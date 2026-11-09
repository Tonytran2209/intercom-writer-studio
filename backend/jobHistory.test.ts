import test from "node:test"
import assert from "node:assert/strict"
import { summarizeJobHistory, jobRuns, jobHistoryWindows } from "./jobHistory.ts"

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

test("job runs list the last 61 days of terminal runs for AI Agent Lab", () => {
  const now = Date.parse("2026-11-09T00:00:00Z")
  const row = { job: "Gate", workload: "1 item", valid: true, error: null }
  const rows = [
    { ...row, status: "completed" as const, startedAt: "2026-11-08T00:00:00Z", endedAt: "2026-11-08T00:05:00Z", recordedAt: "2026-11-08T00:05:00Z" },
    { ...row, status: "failed" as const, startedAt: null, endedAt: null, recordedAt: "2026-11-07T00:00:00Z", error: "HTTP 503" },
    { ...row, status: "completed" as const, startedAt: "2026-11-07T00:10:00Z", endedAt: "2026-11-07T00:00:00Z", recordedAt: "2026-11-07T00:00:00Z" },
    { ...row, status: "completed" as const, startedAt: "2026-08-01T00:00:00Z", endedAt: "2026-08-01T00:05:00Z", recordedAt: "2026-08-01T00:05:00Z" },
  ]
  const result = jobRuns(rows, now)
  assert.equal(result.since, "2026-09-09T00:00:00.000Z")
  assert.equal(result.complete, true)
  assert.deepEqual(result.runs, [
    { job: "Gate", workload: "1 item", status: "success", startedAt: "2026-11-08T00:00:00.000Z", endedAt: "2026-11-08T00:05:00.000Z" },
    { job: "Gate", workload: "1 item", status: "failed", startedAt: null, endedAt: "2026-11-07T00:00:00.000Z" },
    { job: "Gate", workload: "1 item", status: "success", startedAt: null, endedAt: "2026-11-07T00:00:00.000Z" },
  ])
  assert.equal(jobRuns(rows, now, 1).complete, false)
  assert.equal(jobHistoryWindows(rows, "2026-11-01T00:00:00Z", 2, now).jobRuns.complete, false, "a truncated read is incomplete")
})

test("job runs carry run linkage, document names and parent runs for AI Agent Lab", () => {
  const now = Date.parse("2026-11-09T00:00:00Z")
  const rows = [{
    job: "Step", workload: "1 item", status: "completed" as const, valid: true, error: null,
    startedAt: "2026-11-08T00:00:00Z", endedAt: "2026-11-08T00:00:05Z", recordedAt: "2026-11-08T00:00:05Z",
    runId: "s1", parentRunId: "group:1", parent: "Group", title: "  Tài liệu ToR UNIDO  ",
  }]
  const parents = [
    { job: "Group", runId: "group:1", workload: "3 bài · Plan Q4", status: "running" as const, startedAt: "2026-11-08T00:00:00Z", endedAt: null },
    { job: "Group", runId: "group:old", workload: "1 bài", status: "success" as const, startedAt: "2026-08-01T00:00:00Z", endedAt: "2026-08-01T00:10:00Z" },
  ]
  const result = jobRuns(rows, now, 5000, parents)
  assert.deepEqual(result.runs, [
    { job: "Step", workload: "1 item · Tài liệu ToR UNIDO", status: "success", startedAt: "2026-11-08T00:00:00.000Z", endedAt: "2026-11-08T00:00:05.000Z",
      runId: "s1", parentRunId: "group:1", parent: "Group" },
    { job: "Group", runId: "group:1", workload: "3 bài · Plan Q4", status: "running", startedAt: "2026-11-08T00:00:00Z", endedAt: null },
  ])
})
