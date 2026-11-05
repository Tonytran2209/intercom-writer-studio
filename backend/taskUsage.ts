import crypto from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import type { Request, Response, NextFunction } from "express"
type Meta = { kind: string; label: string; entityId?: string }
type Context = { id: string; meta: () => Meta; closed: boolean; explicit: boolean }
type Call = {
  model: string
  status: string
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  durationMs: number
}
type Task = {
  id: string
  kind: string
  label: string
  entityId?: string
  startedAt: string
  finishedAt: string | null
  status: string
  calls: number
  failedCalls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  usageSamples: number
  pricedCalls: number
  knownCostUsd: number | null
  details: Call[]
  detailTruncated: boolean
  version: number
}
export function createTaskUsage(options: {
  save: (key: string, value: unknown) => Promise<void>
  pricing: () => Promise<any>
  cost: (
    pricing: any,
    input: number,
    output: number,
    cached: number,
  ) => number | null
}) {
  const context = new AsyncLocalStorage<Context>(),
    rows = new Map<string, Task>(),
    dirty = new Set<string>(),
    pricingTasks = new Set<Promise<void>>()
  let errors = 0,
    overflow = 0,
    flushing: Promise<void> | null = null
  function touch(row: Task) {
    row.version++
    dirty.add(row.id)
  }
  function find(c: Context) {
    let row = rows.get(c.id)
    if (!row) {
      if (rows.size >= 1000) {
        const old = [...rows.values()].find(
          (r) => r.finishedAt && !dirty.has(r.id),
        )
        if (old) rows.delete(old.id)
        else {
          overflow++
          return null
        }
      }
      const meta = c.meta()
      row = {
        id: c.id,
        kind: meta.kind.slice(0, 40),
        label: meta.label.slice(0, 160),
        ...(meta.entityId ? { entityId: meta.entityId.slice(0, 100) } : {}),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running",
        calls: 0,
        failedCalls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        usageSamples: 0,
        pricedCalls: 0,
        knownCostUsd: null,
        details: [],
        detailTruncated: false,
        version: 0,
      }
      rows.set(c.id, row)
    }
    return row
  }
  async function run<T>(meta: Meta, operation: () => Promise<T>): Promise<T> {
    const c = {
      id: crypto.randomUUID(),
      meta: () => meta,
      closed: false,
      explicit: true,
    }
    return context.run(c, async () => {
      let status = "completed"
      try {
        return await operation()
      } catch (e) {
        status = "failed"
        throw e
      } finally {
        c.closed = true
        const row = rows.get(c.id)
        if (row) {
          row.status = status
          row.finishedAt = new Date().toISOString()
          touch(row)
        }
      }
    })
  }
  async function track<T extends {
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
    const existing = context.getStore()
    const c =
      existing && !existing.closed
        ? existing
        : {
            id: crypto.randomUUID(),
            meta: () => ({
              kind: "unattributed",
              label: "AI call outside tracked task",
            }),
            closed: false,
            explicit: false,
          }
    const row = find(c),
      start = performance.now()
    if (row) {
      row.calls++
      touch(row)
    }
    const call: Call = {
      model: (req.provider + " / " + req.modelId).slice(0, 160),
      status: "running",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: 0,
    }
    if (row) {
      if (row.details.length < 100) row.details.push(call)
      else row.detailTruncated = true
    }
    try {
      const result = await operation()
      call.status = "completed"
      const u = result.usage
      if (
        row &&
        u &&
        [u.inputTokens, u.outputTokens, u.cachedInputTokens ?? 0].every(
          (v) => Number.isSafeInteger(v) && v >= 0,
        ) &&
        u.inputTokens + u.outputTokens > 0
      ) {
        call.inputTokens = u.inputTokens
        call.outputTokens = u.outputTokens
        call.cachedInputTokens = Math.min(
          u.inputTokens,
          u.cachedInputTokens ?? 0,
        )
        row.inputTokens += call.inputTokens
        row.outputTokens += call.outputTokens
        row.cachedInputTokens += call.cachedInputTokens
        row.usageSamples++
        const work = Promise.resolve()
          .then(options.pricing)
          .then((config) => {
            const model = config?.models?.find(
              (m: any) => m.id === req.modelId && m.provider === req.provider,
            )
            const cost = options.cost(
              model?.pricing,
              u.inputTokens,
              u.outputTokens,
              call.cachedInputTokens!,
            )
            call.costUsd = cost
            if (cost !== null) {
              row.knownCostUsd = (row.knownCostUsd ?? 0) + cost
              row.pricedCalls++
              touch(row)
            }
          })
          .catch(() => {
            errors++
          })
          .finally(() => pricingTasks.delete(work))
        pricingTasks.add(work)
      }
      return result
    } catch (e) {
      call.status = "failed"
      if (row) row.failedCalls++
      throw e
    } finally {
      call.durationMs = performance.now() - start
      if (row) {
        if (c !== existing) {
          row.status = "unattributed"
          row.finishedAt = new Date().toISOString()
        }
        touch(row)
      }
    }
  }
  async function flush() {
    await Promise.allSettled([...pricingTasks])
    if (flushing) return flushing
    flushing = (async () => {
      for (const id of [...dirty]) {
        const row = rows.get(id)
        if (!row) continue
        const snapshot = JSON.parse(JSON.stringify(row))
        try {
          await options.save("lab-task:v1:" + id, snapshot)
          if (snapshot.version === row.version) dirty.delete(id)
        } catch {
          errors++
        }
      }
      for (const [id, row] of rows)
        if (
          !dirty.has(id) &&
          row.finishedAt &&
          Date.parse(row.finishedAt) < Date.now() - 86400000
        )
          rows.delete(id)
    })().finally(() => {
      flushing = null
    })
    return flushing
  }
  return {
    run,
    track,
    flush,
    middleware(req: Request, res: Response, next: NextFunction) {
      const c: Context = {
        id: crypto.randomUUID(),
        meta: () => ({
          kind: "api",
          label:
            req.method +
            " " +
            (typeof req.route?.path === "string"
              ? req.route.path
              : "API operation"),
        }),
        closed: false,
        explicit: false,
      }
      const finish = () => {
        if (c.closed) return
        c.closed = true
        const row = rows.get(c.id)
        if (row) {
          row.status = res.writableFinished
            ? res.statusCode < 400
              ? "completed"
              : "failed"
            : "interrupted"
          row.finishedAt = new Date().toISOString()
          touch(row)
        }
      }
      res.once("finish", finish)
      res.once("close", finish)
      context.run(c, next)
    },
    report(stored: any[], since: string) {
      const byId = new Map<string, Task>(
        stored.map((v) => [v.value.id, v.value]),
      )
      for (const row of rows.values())
        if (row.startedAt >= since) byId.set(row.id, row)
      return {
        version: "task-usage-v1",
        errors,
        overflow,
        rows: [...byId.values()]
          .filter((r) => r.startedAt >= since)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .map((r, i) => ({
            ...r,
            details: i < 50 ? r.details.slice(0, 10) : [],
            detailTruncated:
              r.detailTruncated || i >= 50 || r.details.length > 10,
          })),
        coverage:
          "Explicit gates/batch stages and API operations; unattributed calls are labeled separately. SDK internal retries may not expose usage.",
      }
    },
  }
}
