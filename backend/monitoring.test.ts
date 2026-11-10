import test from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { createMonitoring, configuredCost, monitoring, nearestRankP95 } from "./monitoring.ts"
const source =
  (rows: any[] = []) =>
  async () => ({
    buckets: rows,
    jobHistory: null,
    contentWorkload: null,
    jobHistoryAllTime: null,
    database: {
      status: "ready",
      responseMs: 1,
      poolTotal: 1,
      poolIdle: 1,
      poolWaiting: 0,
    },
    articles: { total: 2 },
    plans: null,
    ledger: null,
    inventory: {},
    taskRows:[],historicalTasks:[],taskReadComplete:true,
    complete: true,
  })
test("configured pricing separates cached input and missing prices", () => {
  assert.equal(configuredCost(null, 100, 20, 10), null)
  assert.equal(
    configuredCost(
      {
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 10,
        cachedInputUsdPerMillion: 1,
      },
      100,
      20,
      10,
    ),
    0.00039,
  )
  assert.equal(
    configuredCost({ inputUsdPerMillion: -1, outputUsdPerMillion: 1 }, 1, 1, 0),
    null,
  )
})
test("AI instrumentation preserves results, errors and restart-safe aggregate totals", async () => {
  const saved = new Map<string, any>()
  const options = {
    readData: source(),
    save: async (k: string, v: any) => {
      saved.set(k, { key: k, value: v })
    },
    getConfig: async () => ({
      models: [
        {
          id: "known",
          provider: "test",
          pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
      ],
    }),
  }
  const m = createMonitoring("test", options)
  try {
    const result = {
      content: "ok",
      model: "known",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 },
    }
    assert.equal(
      await m.trackAI(
        { provider: "test", modelId: "known" },
        async () => result,
      ),
      result,
    )
    await m.trackAI({ provider: "test", modelId: "unknown" }, async () => ({
      ...result,
      usage: undefined,
    }))
    const error = new Error("provider failure")
    await assert.rejects(
      m.trackAI({ provider: "test", modelId: "known" }, async () => {
        throw error
      }),
      (e) => e === error,
    )
    const report = await m.snapshot(7)
    assert.equal(report.ai.calls, 3)
    assert.equal(report.ai.failed, 1)
    assert.equal(report.ai.usageSamples, 1)
    assert.equal(report.ai.pricedCalls, 1)
    assert.equal(report.ai.inputTokens, 100)
    assert.equal(report.ai.cachedInputTokens, 10)
    assert.equal(report.ai.knownCostUsd, 0.00014)
    const restarted = createMonitoring("test", {
      ...options,
      readData: source([...saved.values()]),
    })
    try {
      const r = await restarted.snapshot(7)
      assert.equal(r.ai.calls, 3)
      assert.equal(r.ai.knownCostUsd, 0.00014)
    } finally {
      await restarted.stop()
    }
  } finally {
    await m.stop()
  }
})
test("monitor route fails closed and HTTP instrumentation records errors without query data", async () => {
  const m = createMonitoring("test", {
    readData: source(),
    save: async () => {},
    token: () => "x".repeat(40),
  })
  const app = express()
  app.use(m.middleware)
  app.get("/api/items/:id", (req, res) =>
    res.status(500).json({ error: "test" }),
  )
  app.get("/internal/monitoring", (req, res) => m.handler(req, res))
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const origin = "http://127.0.0.1:" + (server.address() as any).port
  try {
    assert.equal((await fetch(origin + "/internal/monitoring")).status, 401)
    assert.equal(
      (
        await fetch(origin + "/internal/monitoring?days=31", {
          headers: { Authorization: "Bearer " + "x".repeat(40) },
        })
      ).status,
      400,
    )
    await fetch(origin + "/api/items/private-id?secret=hidden")
    const response = await fetch(origin + "/internal/monitoring?days=7", {
      headers: { Authorization: "Bearer " + "x".repeat(40) },
    })
    assert.equal(response.status, 200)
    const r: any = await response.json()
    assert.equal(r.http.calls, 1)
    assert.equal(r.http.failed, 1)
    assert.equal(r.http.routes[0].route, "GET /api/items/:id")
    assert.ok(!JSON.stringify(r).includes("private-id"))
    assert.ok(!JSON.stringify(r).includes("hidden"))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await m.stop()
    await monitoring.stop()
  }
})

test("ui-kpi-v2 samples are exact, persist across restarts and withhold ambiguous technical error rates", async () => {
  const rows = new Map<string, { key: string; value: any }>()
  const options = {
    readData: async () => source([...rows.values()])(),
    save: async (key: string, value: any) => { rows.set(key, { key, value }) },
  }
  const monitor = createMonitoring("test", options)
  const app = express()
  app.use(express.json())
  app.post("/sample", monitor.browserSample)
  const server = app.listen(0, "127.0.0.1")
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const url = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/sample"
    const sample = (metric: string, ms: number, site = "same-origin") => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": site },
      body: JSON.stringify({ metric, ms }),
    })
    assert.equal((await sample("clickLatency", 195.04)).status, 204)
    assert.equal((await sample("responseTime", 2200.26)).status, 204)
    assert.equal((await sample("responseTime", 100, "cross-site")).status, 403)
    assert.equal((await sample("invalid", 100)).status, 400)
    monitor.recordJob("Test gate", "1 item", performance.now() - 100, "valid")
    monitor.recordJob("Test gate", "1 item", performance.now() - 100, "technical")
    const first = (await monitor.snapshot(7)).performanceKpis
    assert.equal(first.standard, "ui-kpi-v2")
    assert.deepEqual(first.clickLatency, { p95Ms: 195, samples: 1, precision: "exact" })
    assert.deepEqual(first.responseTime, { p95Ms: 2200.3, samples: 1, precision: "exact" })
    // Only the metric (as key), the duration and the time are persisted.
    const stored = [...rows.values()].map((row) => row.value.browserSamples).find(Boolean)
    assert.deepEqual(Object.keys(stored).sort(), ["clickLatency", "responseTime"])
    assert.equal(stored.clickLatency.length, 1)
    assert.equal(stored.clickLatency[0].length, 2)
    assert.equal(stored.clickLatency[0][0], 195)
    assert.ok(Math.abs(stored.clickLatency[0][1] - Date.now()) < 60000)
    assert.deepEqual(first.jobs, { executed: 2, technicalErrors: 1, validCompletions: 1 })
    assert.equal(first.jobCompletion[0].samples, 2)
    const restarted = createMonitoring("test", options)
    try {
      assert.deepEqual((await restarted.snapshot(7)).performanceKpis, first)
      restarted.recordJob("Test gate", "1 item", performance.now(), "unknown")
      assert.deepEqual((await restarted.snapshot(7)).performanceKpis.jobs, {
        executed: 3, technicalErrors: null, validCompletions: 1,
      })
    } finally {
      await restarted.stop()
    }
  } finally {
    server.close()
    await monitor.stop()
  }
})

test("nearest-rank P95 uses raw samples, not histogram buckets", () => {
  assert.equal(nearestRankP95([]), null)
  assert.equal(nearestRankP95([42.5]), 42.5)
  assert.equal(nearestRankP95(Array.from({ length: 20 }, (_, i) => 20 - i)), 19)
  assert.equal(nearestRankP95(Array.from({ length: 100 }, (_, i) => i + 1)), 95)
  assert.equal(nearestRankP95(Array.from({ length: 101 }, (_, i) => i + 1)), 96)
})

test("ui-kpi-v2 report uses the requested window, ignores legacy histograms and bounds samples", async () => {
  const hour = new Date().toISOString().slice(0, 13) + ":00:00.000Z"
  const old = Date.now() - 40 * 86400000
  const legacy = { calls: 5, failed: 0, clientErrors: 0, aborted: 0, totalMs: 50, maxMs: 10, histogram: [5] }
  const stored = {
    key: "lab-monitor:v1:" + hour + ":previous", hour, instanceId: "previous", version: 1,
    http: { calls: 0, failed: 0, clientErrors: 0, aborted: 0, totalMs: 0, maxMs: 0, histogram: [] }, routes: {}, ai: {},
    browser: { clickLatency: legacy, responseTime: legacy },
    browserSamples: {
      clickLatency: [...Array.from({ length: 19 }, (_, i) => [100 + i, Date.now()]), [900.4, Date.now()], [5000, old]],
      responseTime: [[812.3, Date.now()]],
    },
  }
  const monitor = createMonitoring("test", { readData: source([{ key: stored.key, value: stored }]), save: async () => {} })
  const app = express()
  app.use(express.json())
  app.post("/sample", monitor.browserSample)
  const server = app.listen(0, "127.0.0.1")
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const url = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/sample"
    const kpis = (await monitor.snapshot(7)).performanceKpis
    // 20 in-window samples: nearest rank 19 → 118 ms; the sample older than the window is excluded.
    assert.deepEqual(kpis.clickLatency, { p95Ms: 118, samples: 20, precision: "exact" })
    assert.deepEqual(kpis.responseTime, { p95Ms: 812.3, samples: 1, precision: "exact" })
    const post = (ms: number) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ metric: "responseTime", ms }),
    })
    assert.equal((await post(1)).status, 204)
    const direct = () => monitor.browserSample(
      { get: () => "same-origin", body: { metric: "responseTime", ms: 1 } } as any,
      { sendStatus: (status: number) => status } as any,
    )
    for (let i = 1; i < 10000; i++) assert.equal(direct(), 204)
    assert.equal(direct(), 429)
    assert.equal((await post(1)).status, 429)
  } finally {
    server.close()
    await monitor.stop()
  }
})
