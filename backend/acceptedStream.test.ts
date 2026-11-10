import test from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { acceptOnRequest } from "./acceptedStream.ts"
import { createMonitoring } from "./monitoring.ts"
import { acceptedFetch, readAcceptedResponse } from "../src/lib/acceptedResponse.ts"

// A route shaped like /api/generate and /api/eb-v2/packages: validate, accept, AI work, respond.
async function withServer(run: (origin: string, ai: { release: (outcome: "ok" | "fail") => void; started: Promise<void> }, monitor: ReturnType<typeof createMonitoring>) => Promise<void>) {
  const monitor = createMonitoring("test", { readData: async () => ({ buckets: [], complete: true } as any), save: async () => {} })
  let release!: (outcome: "ok" | "fail") => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const outcome = new Promise<"ok" | "fail">((resolve) => { release = resolve })
  const app = express()
  app.use(monitor.middleware)
  app.use(express.json())
  app.post("/api/work", async (req, res) => {
    if (!req.body?.input) return res.status(400).json({ error: "Input is required." })
    const accept = acceptOnRequest(req, res)
    accept()
    markStarted()
    if ((await outcome) === "fail") return res.status(422).json({ error: "Chưa thể chạy Gate 1." })
    res.status(201).json({ package: { id: "p1" } })
  })
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  try {
    await run("http://127.0.0.1:" + (server.address() as { port: number }).port, { release, started }, monitor)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await monitor.stop()
  }
}
const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

test("callers without the opt-in header keep the plain JSON response", async () => {
  await withServer(async (origin, ai) => {
    const pending = fetch(origin + "/api/work", post({ input: "x" }))
    await ai.started
    ai.release("ok")
    const response = await pending
    assert.equal(response.status, 201)
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    assert.deepEqual(await response.json(), { package: { id: "p1" } })
  })
})

test("opted-in callers receive accepted before the AI finishes, then the same result", async () => {
  await withServer(async (origin, ai) => {
    let accepted = false
    const pending = acceptedFetch(origin + "/api/work", post({ input: "x" }), () => { accepted = true })
    await ai.started
    // The AI is still running: the client must already have seen "accepted".
    for (let i = 0; i < 50 && !accepted; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(accepted, true)
    ai.release("ok")
    const response = await pending
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { package: { id: "p1" } })
  })
})

test("errors after acceptance arrive in-stream with the original status and body; monitoring keeps the logical status", async () => {
  await withServer(async (origin, ai, monitor) => {
    let accepted = 0
    const pending = acceptedFetch(origin + "/api/work", post({ input: "x" }), () => { accepted++ })
    await ai.started
    ai.release("fail")
    const response = await pending
    assert.equal(accepted, 1)
    assert.equal(response.ok, false)
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { error: "Chưa thể chạy Gate 1." })
    const report = await monitor.snapshot(1)
    assert.equal(report.http.calls, 1)
    assert.equal(report.http.clientErrors, 1)
  })
})

test("validation errors before acceptance stay plain JSON and never signal accepted", async () => {
  await withServer(async (origin) => {
    let accepted = false
    const response = await acceptedFetch(origin + "/api/work", post({}), () => { accepted = true })
    assert.equal(accepted, false)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "Input is required." })
  })
})

test("client parser: result-first streams count as accepted; truncated streams fail", async () => {
  const stream = (text: string) => new Response(text, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } })
  let calls = 0
  const cached = await readAcceptedResponse(stream('{"event":"result","status":200,"body":{"content":"ok"}}\n'), () => calls++)
  assert.equal(calls, 1)
  assert.deepEqual(await cached.json(), { content: "ok" })
  await assert.rejects(readAcceptedResponse(stream('{"event":"accepted"}\n'), () => {}), /closed the connection/)
})
