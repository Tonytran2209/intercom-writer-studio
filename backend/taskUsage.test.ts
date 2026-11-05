import test from "node:test"
import assert from "node:assert/strict"
import { createTaskUsage } from "./taskUsage.ts"
const cost = (p: any, input: number, output: number, cached: number) =>
  p ? (input + output) / 1e6 : null
test("task context groups retry and model usage while isolating concurrent operations and preserving provider errors", async () => {
  const saved = new Map()
  const t = createTaskUsage({
    save: async (k, v) => {
      saved.set(k, { value: structuredClone(v) })
    },
    pricing: async () => ({
      models: [{ id: "known", provider: "test", pricing: {} }],
    }),
    cost,
  })
  const error = new Error("original provider error")
  const invoke = (model = "known") =>
    t.track({ provider: "test", modelId: model }, async () => ({
      content: "ok",
      model,
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
    }))
  await Promise.all([
    t.run({ kind: "gate", label: "A", entityId: "package-a" }, async () => {
      await assert.rejects(
        t.track({ provider: "test", modelId: "known" }, async () => {
          throw error
        }),
        (e) => e === error,
      )
      await invoke()
      await invoke("unknown")
    }),
    t.run({ kind: "gate", label: "B" }, async () => invoke()),
  ])
  await t.flush()
  const report = t.report([], "2000-01-01")
  const a = report.rows.find((r) => r.label === "A")!,
    b = report.rows.find((r) => r.label === "B")!
  assert.equal(a.calls, 3)
  assert.equal(a.failedCalls, 1)
  assert.equal(a.inputTokens, 200)
  assert.equal(a.usageSamples, 2)
  assert.equal(a.pricedCalls, 1)
  assert.equal(a.status, "completed")
  assert.equal(a.details[0].inputTokens, null)
  assert.equal(a.details[2].costUsd, null)
  assert.equal(b.calls, 1)
  assert.notEqual(a.id, b.id)
  const restarted = createTaskUsage({
    save: async () => {},
    pricing: async () => null,
    cost,
  })
  assert.equal(
    restarted.report([...saved.values()], "2000-01-01").rows.length,
    2,
  )
})
test("telemetry pricing/storage failure cannot replace a successful business result", async () => {
  const t = createTaskUsage({
    save: async () => {
      throw Error("offline")
    },
    pricing: () => {
      throw Error("bad pricing")
    },
    cost,
  })
  const result = {
    content: "ok",
    model: "unknown",
    usage: { inputTokens: 1, outputTokens: 2 },
  }
  assert.equal(
    await t.run({ kind: "api", label: "test" }, () =>
      t.track({ provider: "test", modelId: "unknown" }, async () => result),
    ),
    result,
  )
  await t.flush()
  const r = t.report([], "2000-01-01")
  assert.equal(r.rows[0].knownCostUsd, null)
  assert.ok(r.errors > 0)
})
