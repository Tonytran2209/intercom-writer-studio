import test from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { createMonitoring, configuredCost, monitoring } from "./monitoring.ts"
const source =
  (rows: any[] = []) =>
  async () => ({
    buckets: rows,
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
