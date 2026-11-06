import {createTaskUsage} from './taskUsage.ts';
import crypto from "node:crypto"
import { performance } from "node:perf_hooks"
import type { Request, Response, NextFunction } from "express"
import { kvGet, kvSet, tableAvailable, tableSelect } from "./supabase.ts"
import { readMonitoringData } from "./monitoringData.ts"

const limits = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000,
  600000,
]
type Counter = {
  calls: number
  failed: number
  clientErrors: number
  aborted: number
  totalMs: number
  maxMs: number
  histogram: number[]
}
type AiCounter = Counter & {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  usageSamples: number
  pricedCalls: number
  knownCostUsd: number
}
type JobOutcome = "valid" | "technical" | "invalid" | "unknown"
type JobCounter = { job: string; workload: string; duration: Counter; valid: number; technical: number; unknown: number }
type BrowserMetric = "clickLatency" | "responseTime"
const kpiLimits = limits.map((limit) => limit === 250 ? 200 : limit)

export function jobFailure(error: unknown): JobOutcome {
  if (!error || typeof error !== "object") return "unknown"
  const { code, name, status, statusCode } = error as { code?: string; name?: string; status?: number; statusCode?: number }
  if ((status ?? statusCode ?? 0) >= 500 || name === "TimeoutError" ||
      ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "57P01", "57014"].includes(code ?? ""))
    return "technical"
  return "unknown"
}

type Bucket = {
  key: string
  hour: string
  instanceId: string
  version: number
  http: Counter
  routes: Record<string, Counter>
  ai: Record<string, AiCounter>
  browser?: Partial<Record<BrowserMetric, Counter>>
  jobs?: Record<string, JobCounter>
}
const counter = (): Counter => ({
  calls: 0,
  failed: 0,
  clientErrors: 0,
  aborted: 0,
  totalMs: 0,
  maxMs: 0,
  histogram: Array(limits.length + 1).fill(0),
})
const aiCounter = (): AiCounter => ({
  ...counter(),
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  usageSamples: 0,
  pricedCalls: 0,
  knownCostUsd: 0,
})
function record(row: Counter, ms: number, status: number, aborted = false, bounds = limits) {
  row.calls++
  row.failed += Number(status >= 500)
  row.clientErrors += Number(status >= 400 && status < 500)
  row.aborted += Number(aborted)
  row.totalMs += ms
  row.maxMs = Math.max(row.maxMs, ms)
  let i = bounds.findIndex((limit) => ms <= limit)
  if (i < 0) i = bounds.length
  row.histogram[i]++
}
function add(target: Counter, source: Counter) {
  for (const key of [
    "calls",
    "failed",
    "clientErrors",
    "aborted",
    "totalMs",
  ] as const)
    target[key] += source[key] || 0
  target.maxMs = Math.max(target.maxMs, source.maxMs || 0)
  target.histogram = target.histogram.map(
    (v, i) => v + (source.histogram[i] || 0),
  )
}
function summarize(row: Counter, bounds = limits) {
  const quantile = (fraction: number) => {
    if (!row.calls) return null
    let n = 0
    const target = Math.ceil(row.calls * fraction)
    for (let i = 0; i < row.histogram.length; i++) {
      n += row.histogram[i]
      if (n >= target) return bounds[i] ?? row.maxMs
    }
    return null
  }
  return {
    ...row,
    averageMs: row.calls ? row.totalMs / row.calls : null,
    errorRate: row.calls ? (row.failed / row.calls) * 100 : null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    percentileMethod: "histogram-upper-bound",
  }
}
export function configuredCost(
  pricing: any,
  input: number,
  output: number,
  cached: number,
): number | null {
  if (!pricing) return null
  const rates = [
    pricing.inputUsdPerMillion,
    pricing.outputUsdPerMillion,
    pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion,
  ]
  if (rates.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0))
    return null
  const long =
    Number(pricing.longContextThresholdTokens) > 0 &&
    input > Number(pricing.longContextThresholdTokens)
  const inputMultiplier = long
      ? Number(pricing.longContextInputMultiplier ?? 1)
      : 1,
    outputMultiplier = long
      ? Number(pricing.longContextOutputMultiplier ?? 1)
      : 1
  if (
    !Number.isFinite(inputMultiplier) ||
    !Number.isFinite(outputMultiplier) ||
    inputMultiplier < 0 ||
    outputMultiplier < 0
  )
    return null
  return (
    ((input - cached) * rates[0] * inputMultiplier +
      cached * rates[2] * inputMultiplier +
      output * rates[1] * outputMultiplier) /
    1e6
  )
}
export function createMonitoring(
  appId: string,
  options: {
    readData?: typeof readMonitoringData
    getConfig?: () => Promise<any>
    save?: (key: string, value: unknown) => Promise<void>
    token?: () => string | undefined
  } = {},
) {
  const instanceId = crypto.randomUUID(),
    startedAt = new Date().toISOString(),
    buckets = new Map<string, Bucket>(),
    dirty = new Set<string>()
  let recordingErrors = 0,
    inFlight = 0,
    aiInFlight = 0,
    flushPromise: Promise<void> | null = null,
    cpuAt = process.cpuUsage(),
    cpuTime = performance.now()
  const pricingTasks = new Set<Promise<void>>()
  let config: any = null,
    configAt = 0,
    configPromise: Promise<any> | null = null
  const getConfig = () => {
    if (configAt > Date.now() - 60000) return Promise.resolve(config)
    if (!configPromise)
      configPromise = (options.getConfig?.() ?? kvGet("writer:config"))
        .then((v) => {
          config = v
          configAt = Date.now()
          return v
        })
        .finally(() => {
          configPromise = null
        })
    return configPromise
  }
  const tasks=createTaskUsage({save:options.save??kvSet,pricing:getConfig,cost:configuredCost});
  function bucket() {
    const hour = new Date().toISOString().slice(0, 13) + ":00:00.000Z"
    let value = buckets.get(hour)
    if (!value) {
      value = {
        key: "lab-monitor:v1:" + hour + ":" + instanceId,
        hour,
        instanceId,
        version: 0,
        http: counter(),
        routes: {},
        ai: {},
      }
      buckets.set(hour, value)
    }
    return value
  }
  function changed(b: Bucket) {
    b.version++
    dirty.add(b.hour)
  }
  function recordJob(job: string, workload: string, start: number, outcome: JobOutcome) {
    const b = bucket()
    const jobs = b.jobs ??= {}
    const key = job + ":" + workload
    const row = jobs[key] ??= { job, workload, duration: counter(), valid: 0, technical: 0, unknown: 0 }
    record(row.duration, performance.now() - start, 200, false, kpiLimits)
    row.valid += Number(outcome === "valid")
    row.technical += Number(outcome === "technical")
    row.unknown += Number(outcome === "unknown")
    changed(b)
  }

  async function flush() {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      for (const hour of [...dirty]) {
        const b = buckets.get(hour)
        if (!b) continue
        const snapshot = JSON.parse(JSON.stringify(b))
        try {
          await (options.save ?? kvSet)(b.key, snapshot)
          if (b.version === snapshot.version) dirty.delete(hour)
        } catch {
          recordingErrors++
        }
      }
      for (const [hour] of buckets)
        if (Date.parse(hour) < Date.now() - 31 * 86400000 && !dirty.has(hour))
          buckets.delete(hour)
    })().finally(() => {
      flushPromise = null
    })
    return flushPromise
  }
  const timer = setInterval(() => {
    void tasks.flush();
    void flush()
  }, 5000)
  timer.unref()
  async function trackAI<T extends {
    content: string
    model: string
    usage?: {
      inputTokens: number
      outputTokens: number
      cachedInputTokens?: number
    }
  },>(
    req: { provider: string; modelId: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const b = bucket(),
      key = (req.provider + ":" + req.modelId).slice(0, 160)
    const group = Object.keys(b.ai).length < 100 || b.ai[key] ? key : "other"
    const row = b.ai[group] ?? (b.ai[group] = aiCounter())
    const start = performance.now()
    aiInFlight++
    try {
      const result = await tasks.track(req, operation)
      record(row, performance.now() - start, 200)
      const usage = result.usage
      const valid =
        usage &&
        [
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedInputTokens ?? 0,
        ].every((v) => Number.isSafeInteger(v) && v >= 0) &&
        (usage.inputTokens + usage.outputTokens > 0 || !result.content)
      if (valid && usage) {
        const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0)
        row.inputTokens += usage.inputTokens
        row.outputTokens += usage.outputTokens
        row.cachedInputTokens += cached
        row.usageSamples++
        const task = getConfig()
          .then((c) => {
            const model = c?.models?.find(
              (m: any) => m.id === req.modelId && m.provider === req.provider,
            )
            const cost = configuredCost(
              model?.pricing,
              usage.inputTokens,
              usage.outputTokens,
              cached,
            )
            if (cost !== null) {
              row.knownCostUsd += cost
              row.pricedCalls++
              changed(b)
            }
          })
          .catch(() => {
            recordingErrors++
          })
          .finally(() => {
            pricingTasks.delete(task)
          })
        pricingTasks.add(task)
      }
      changed(b)
      return result
    } catch (error) {
      record(row, performance.now() - start, 500)
      changed(b)
      throw error
    } finally {
      aiInFlight--
    }
  }
  return {
    trackAI,
    task:tasks.run,
    recordJob,
    browserSample(req: Request, res: Response) {
      // Only accept the app's own browser requests and a bounded scalar payload.
      if (req.get("sec-fetch-site") !== "same-origin") return res.sendStatus(403)
      const { metric, ms } = req.body ?? {}
      if ((metric !== "clickLatency" && metric !== "responseTime") ||
          typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 600000) return res.sendStatus(400)
      const b = bucket()
      const browser = b.browser ??= {}
      const row = browser[metric as BrowserMetric] ??= counter()
      if (row.calls >= 10000) return res.sendStatus(429)
      record(row, ms, 200, false, kpiLimits)
      changed(b)
      return res.sendStatus(204)
    },
    flush:async()=>{await tasks.flush();await flush();},
    stop() {
      clearInterval(timer)
      return Promise.all([tasks.flush(),flush()])
    },
    middleware(req: Request, res: Response, next: NextFunction) {
      if (!req.path.startsWith("/api/") || req.path === "/api/monitoring/ui-sample") return next()
      inFlight++
      const start = performance.now()
      let done = false
      const finish = (aborted: boolean) => {
        if (done) return
        done = true
        inFlight--
        const b = bucket(),
          ms = performance.now() - start,
          status = aborted ? 0 : res.statusCode
        const path =
          typeof req.route?.path === "string"
            ? req.method + " " + req.route.path
            : "unmatched"
        const route =
          Object.keys(b.routes).length < 100 || b.routes[path] ? path : "other"
        record(b.http, ms, status, aborted)
        record(
          b.routes[route] ?? (b.routes[route] = counter()),
          ms,
          status,
          aborted,
        )
        changed(b)
      }
      res.once("finish", () => finish(false))
      res.once("close", () => finish(!res.writableFinished))
      tasks.middleware(req,res,next)
    },
    async snapshot(days: number) {
      await Promise.allSettled([...pricingTasks])
      await tasks.flush()
      await flush()
      const since = new Date(
        Date.parse(new Date().toISOString().slice(0, 10)) -
          (days - 1) * 86400000,
      ).toISOString()
      const source = await (options.readData ?? readMonitoringData)(since)
      const byKey = new Map<string, Bucket>(
        (source.buckets || []).map((b: any) => [b.key, b.value]),
      )
      for (const b of buckets.values()) if (b.hour >= since) byKey.set(b.key, b)
      const http = counter(),
        routes: Record<string, Counter> = {},
        models: Record<string, AiCounter> = {}
      const browser = { clickLatency: counter(), responseTime: counter() }
      const jobs = new Map<string, JobCounter>()
      let first: string | null = null
      const timeline = new Map<string, {
        hour: string
        calls: number
        errors: number
        httpTotalMs: number
        aiCalls: number
        usageSamples: number
        pricedCalls: number
        totalTokens: number
        knownCostUsd: number
      }>()
      for (const b of byKey.values()) {
        if (!b || !b.http || !b.ai || !b.routes) continue
        if (!first || b.hour < first) first = b.hour
        for (const metric of ["clickLatency", "responseTime"] as const) {
          const sample = b.browser?.[metric]
          if (sample) add(browser[metric], sample)
        }
        for (const [key, row] of Object.entries(b.jobs ?? {})) {
          const total = jobs.get(key) ?? { job: row.job, workload: row.workload, duration: counter(), valid: 0, technical: 0, unknown: 0 }
          add(total.duration, row.duration)
          total.valid += row.valid
          total.technical += row.technical
          total.unknown += row.unknown
          jobs.set(key, total)
        }
        add(http, b.http)
        for (const [key, value] of Object.entries(b.routes)) {
          add(routes[key] ?? (routes[key] = counter()), value)
        }
        for (const [key, value] of Object.entries(b.ai)) {
          const target = models[key] ?? (models[key] = aiCounter())
          add(target, value)
          for (const name of [
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "usageSamples",
            "pricedCalls",
            "knownCostUsd",
          ] as const)
            target[name] += value[name] || 0
        }
        const point = timeline.get(b.hour) ?? {
          hour: b.hour,
          calls: 0,
          errors: 0,
          httpTotalMs: 0,
          aiCalls: 0,
          usageSamples: 0,
          pricedCalls: 0,
          totalTokens: 0,
          knownCostUsd: 0,
        }
        point.calls += b.http.calls
        point.errors += b.http.failed
        point.httpTotalMs += b.http.totalMs
        for (const model of Object.values(b.ai)) {
          point.aiCalls += model.calls
          point.usageSamples += model.usageSamples || 0
          point.pricedCalls += model.pricedCalls || 0
          point.totalTokens += (model.inputTokens || 0) + (model.outputTokens || 0)
          point.knownCostUsd += model.knownCostUsd || 0
        }
        timeline.set(b.hour, point)
      }
      const ai = aiCounter()
      for (const row of Object.values(models)) {
        add(ai, row)
        for (const name of [
          "inputTokens",
          "outputTokens",
          "cachedInputTokens",
          "usageSamples",
          "pricedCalls",
          "knownCostUsd",
        ] as const)
          ai[name] += row[name]
      }
      const now = performance.now(),
        cpu = process.cpuUsage(),
        elapsed = now - cpuTime,
        cpuPercent =
          elapsed > 0
            ? ((cpu.user - cpuAt.user + (cpu.system - cpuAt.system)) /
                1000 /
                elapsed) *
              100
            : null
      cpuAt = cpu
      cpuTime = now
      const jobRows = [...jobs.values()]
      const outcomes = jobRows.reduce((total, row) => ({
        executed: total.executed + row.duration.calls,
        technicalErrors: total.technicalErrors + row.technical,
        validCompletions: total.validCompletions + row.valid,
        unknownOutcomes: total.unknownOutcomes + row.unknown,
      }), { executed: 0, technicalErrors: 0, validCompletions: 0, unknownOutcomes: 0 })
      const measure = (row: Counter) => ({ p95Ms: summarize(row, kpiLimits).p95Ms, samples: row.calls })
      const memory = process.memoryUsage()
      return {
        protocol: "app-monitoring-v1",
        jobHistory: "jobHistory" in source ? source.jobHistory : null,
        jobHistoryAllTime: "jobHistoryAllTime" in source ? source.jobHistoryAllTime : null,
        performanceKpis: {
          clickLatency: measure(browser.clickLatency),
          responseTime: measure(browser.responseTime),
          jobCompletion: jobRows.map(({ job, workload, duration }) => ({ job, workload, ...measure(duration) })),
          jobs: {
            executed: outcomes.executed,
            validCompletions: outcomes.validCompletions,
            technicalErrors: outcomes.unknownOutcomes ? null : outcomes.technicalErrors,
          },
        },
        taskUsage: tasks.report((source as any).taskRows||[],since),
        historicalTasks:(source as any).historicalTasks||[],
        taskReadComplete:(source as any).taskReadComplete??false,
        appId,
        generatedAt: new Date().toISOString(),
        window: { days, since, timeZone: "UTC" },
        coverage: {
          firstMeasuredHour: first,
          recordingErrors,
          persistIntervalSeconds: 5,
          complete: source.complete,
          aiCalls:
            "generate dispatcher operations; SDK internal retries are not separately counted",
          cost: "estimated from model pricing configured when the call completes",
        },
        runtime: {
          startedAt,
          uptimeSeconds: Math.floor(process.uptime()),
          nodeVersion: process.version,
          commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
          instanceId,
          cpuPercent,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          scope: "current-process",
        },
        database: source.database,
        articles: source.articles,
        plans: source.plans,
        ledger: source.ledger,
        inventory: source.inventory,
        http: {
          ...summarize(http),
          inFlight,
          routes: Object.entries(routes)
            .map(([route, r]) => ({ route, ...summarize(r) }))
            .sort((a, b) => b.calls - a.calls),
        },
        ai: {
          ...summarize(ai),
          inFlight: aiInFlight,
          inputTokens: ai.inputTokens,
          cachedInputTokens: ai.cachedInputTokens,
          outputTokens: ai.outputTokens,
          usageSamples: ai.usageSamples,
          pricedCalls: ai.pricedCalls,
          knownCostUsd: ai.pricedCalls ? ai.knownCostUsd : null,
          averageKnownCostPerCall: ai.pricedCalls
            ? ai.knownCostUsd / ai.pricedCalls
            : null,
          models: Object.entries(models).map(([model, r]) => ({
            model,
            ...summarize(r),
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cachedInputTokens: r.cachedInputTokens,
            usageSamples: r.usageSamples,
            pricedCalls: r.pricedCalls,
            knownCostUsd: r.pricedCalls ? r.knownCostUsd : null,
          })),
        },
        timeline: [...timeline.values()].sort((a, b) =>
          a.hour.localeCompare(b.hour),
        ),
        unavailable: [
          "container limits and disk/network metrics require a Railway metrics connection",
          "browser performance and JavaScript errors require frontend instrumentation",
          "provider invoices are not available from token estimates",
        ],
      }
    },
    async handler(req: Request, res: Response) {
      res.setHeader("Cache-Control", "no-store")
      const token = (
        options.token ?? (() => process.env.LAB_MONITORING_TOKEN)
      )()
      if (!token || token.length < 32)
        return res
          .status(503)
          .json({ error: "Monitoring connection is not configured." })
      const supplied =
        req.header("authorization")?.replace(/^Bearer\s+/i, "") || ""
      const hash = (v: string) => crypto.createHash("sha256").update(v).digest()
      if (!crypto.timingSafeEqual(hash(token), hash(supplied)))
        return res.status(401).json({ error: "Unauthorized." })
      const raw = String(req.query.days ?? 7)
      if (!/^(?:[1-9]|[12][0-9]|30)$/.test(raw))
        return res.status(400).json({ error: "days must be 1–30." })
      try {
        return res.json(await this.snapshot(Number(raw)))
      } catch {
        return res
          .status(503)
          .json({ error: "Monitoring data source is unavailable." })
      }
    },
  }
}
export const monitoring = createMonitoring("intercom", {getConfig:async()=>{
  if(await tableAvailable('eb_v2_app_settings')) {
    const row=(await tableSelect<any>('eb_v2_app_settings',q=>q.select('settings').limit(1)))[0];
    if(row?.settings?.models) return row.settings;
  }
  return kvGet('writer:config');
}})
