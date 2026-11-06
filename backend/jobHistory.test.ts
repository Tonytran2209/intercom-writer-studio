import test from "node:test"
import assert from "node:assert/strict"
import { summarizeJobHistory } from "./jobHistory.ts"

test("historical counts require terminal records and duration uses only saved timestamp pairs", () => {
  const base = { job: "Gate", workload: "1 item", startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:01Z", error: null }
  const rows = [
    { ...base, status: "completed" as const, valid: true },
    { ...base, status: "completed" as const, valid: false, startedAt: "invalid" },
    { ...base, status: "failed" as const, valid: false, error: "HTTP 503" },
    { ...base, status: "failed" as const, valid: false, error: "Unknown reason", endedAt: null },
  ]
  assert.deepEqual(summarizeJobHistory(rows, 10), {
    latestJob: { job: "Gate", workload: "1 item", durationMs: 1000 },
    executed: 4, failed: 2, technicalErrors: 1, unclassifiedFailures: 1,
    validCompletions: 1, unverifiedCompletions: 1, complete: true,
    completion: [{ job: "Gate", workload: "1 item", p95Ms: 1000, samples: 2 }],
  })
  assert.equal(summarizeJobHistory(rows, 2).complete, false)
})

test("latest completion uses the newest end event and skips incomplete runs", () => {
  const row = { job: "Gate", workload: "1 item", startedAt: "2026-11-01T00:00:00Z", status: "completed" as const, valid: true, error: null }
  const rows = [
    { ...row, endedAt: "2026-11-01T00:01:00Z" },
    { ...row, workload: "2 items", endedAt: "2026-11-01T00:04:00Z" },
    { ...row, endedAt: "2026-11-01T00:05:00Z" },
    { ...row, endedAt: null },
  ]
  assert.deepEqual(summarizeJobHistory(rows, 10).latestJob, {
    job: "Gate", workload: "1 item", durationMs: 300000,
  })
  assert.equal(summarizeJobHistory([], 10).latestJob, null)
})
