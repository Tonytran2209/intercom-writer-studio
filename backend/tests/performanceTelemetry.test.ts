import test from "node:test"
import assert from "node:assert/strict"
import { interactionStart, measureAfterPaint, postPerformanceSample, roundMs } from "../../src/lib/performanceTelemetry.ts"

// Minimal browser stand-ins: a controllable clock, a manual frame queue and visibility.
let now = 0
let frames: Array<() => void> = []
const doc = { hidden: false }
Object.defineProperty(globalThis, "document", { value: doc, configurable: true })
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => { frames.push(() => callback(now)); return frames.length }) as typeof requestAnimationFrame
const realNow = performance.now.bind(performance)
performance.now = () => now
const frame = (advance: number) => { now += advance; const due = frames; frames = []; due.forEach((run) => run()) }

test.after(() => { performance.now = realNow })

test("start uses the event time on the performance.now() clock, else the handler start", () => {
  assert.equal(interactionStart({ timeStamp: 900 }, 1000), 900)
  assert.equal(interactionStart({ timeStamp: 0 }, 1000), 1000)
  assert.equal(interactionStart({ timeStamp: 1001 }, 1000), 1000, "future timestamps are another clock")
  assert.equal(interactionStart({ timeStamp: 1_700_000_000_000 }, 1000), 1000, "epoch timestamps are rejected")
  assert.equal(interactionStart({ timeStamp: 1000 }, 12_000), 12_000, "older than 10 s is rejected")
  assert.equal(interactionStart({ timeStamp: 2000 }, 12_000), 2000, "exactly 10 s is accepted")
  assert.equal(interactionStart(undefined, 5), 5)
  assert.equal(roundMs(12.345), 12.3)
})

test("the duration is taken inside the second nested animation frame (after paint)", async () => {
  now = 100
  doc.hidden = false
  let value: number | null | undefined
  void measureAfterPaint(40).then((ms) => { value = ms })
  frame(8.04) // first frame: state not painted yet
  await Promise.resolve()
  assert.equal(value, undefined)
  frame(8.03) // second frame: the processing/accepted state has been painted
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(value, 76.1)
})

test("hidden pages are skipped", async () => {
  doc.hidden = true
  assert.equal(await measureAfterPaint(0), null)
  doc.hidden = false
  let value: number | null | undefined
  void measureAfterPaint(0).then((ms) => { value = ms })
  frame(1)
  doc.hidden = true
  frame(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(value, null)
  doc.hidden = false
})

test("only the metric name and the rounded duration are sent", async () => {
  const sent: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }) }) as any
  try {
    postPerformanceSample("responseTime", 1234.56)
    postPerformanceSample("clickLatency", null)
    assert.deepEqual(sent, [{ url: "/api/monitoring/ui-sample", body: { metric: "responseTime", ms: 1234.6 } }])
  } finally {
    globalThis.fetch = realFetch
  }
})
