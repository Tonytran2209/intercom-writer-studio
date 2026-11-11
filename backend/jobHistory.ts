const technicalFailure = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|timeout|timed out)\b|\b(?:HTTP|status(?: code)?)\s*[:=]?\s*5\d{2}\b/i

const rejectedOutput = /^(?:Brief còn thông tin N\/A\.|AI did not return a valid JSON object after one automatic format recovery\.|Batch Step 1 did not return a valid rated Core Idea\.)/

type JobRecord = {
  job: string
  workload: string
  status: "completed" | "failed" | "running"
  valid: boolean
  startedAt: string | Date | null
  endedAt: string | Date | null
  recordedAt?: string | Date | null
  error: string | null
  // Optional run linkage for AI Agent Lab's run history (jobRuns).
  runId?: string | null
  parentRunId?: string | null
  parent?: string | null
  title?: string | null
}

// A run that only exists as a parent of other runs (e.g. a whole batch), sent alongside them.
export type ParentRun = {
  job: string
  runId: string
  workload: string
  status: "success" | "failed" | "running"
  startedAt: string | null
  endedAt: string | null
}

export function summarizeJobHistory(rows: JobRecord[], limit: number) {
  const durations = new Map<string, { job: string; workload: string; values: number[] }>()
  let latest: { job: string; workload: string; durationMs: number; end: number } | null = null
  let executed = 0, failed = 0, technicalErrors = 0, unclassifiedFailures = 0, validCompletions = 0, unverifiedCompletions = 0
  for (const row of rows.slice(0, limit)) {
    if (row.status !== "completed" && row.status !== "failed") continue
    executed++
    if (row.status === "failed") {
      failed++
      if (technicalFailure.test(row.error ?? "")) technicalErrors++
      else if (!rejectedOutput.test(row.error ?? "")) unclassifiedFailures++
    } else if (row.valid) {
      validCompletions++
    } else {
      unverifiedCompletions++
    }

    if (!row.startedAt || !row.endedAt) continue
    const end = new Date(row.endedAt).getTime()
    const duration = end - new Date(row.startedAt).getTime()
    if (!Number.isFinite(duration) || duration < 0) continue
    const key = JSON.stringify([row.job, row.workload])
    const group = durations.get(key) ?? { job: row.job, workload: row.workload, values: [] }
    group.values.push(duration)
    if (!latest || end > latest.end) latest = { job: row.job, workload: row.workload, durationMs: duration, end }
    durations.set(key, group)
  }
  return {
    latestJob: latest ? {
      job: latest.job, workload: latest.workload, durationMs: latest.durationMs,
    } : null,
    executed, failed, technicalErrors, unclassifiedFailures, validCompletions, unverifiedCompletions,
    complete: rows.length <= limit,
    completion: [...durations.values()].map(({ job, workload, values }) => ({
      job, workload, samples: values.length,
      p95Ms: values.sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1],
    })),
  }
}

const iso = (value: string | Date | null | undefined) => {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

// app-monitoring-v1 `jobRuns`: terminal runs of the last 61 days, newest first, for AI Agent Lab to
// compute its own periods, comparisons and per-job error rates. Counts and timestamps only.
// app-monitoring-v1 `jobRuns`: runs of the last 61 days, newest first, for AI Agent Lab to compute
// its own periods, comparisons, per-job success rates and run history. The workload names the
// document or item the run worked on; no content leaves the app.
export function jobRuns(rows: JobRecord[], now: number, max = 5000, parents: ParentRun[] = []) {
  const since = now - 61 * 86400000
  type Run = { job: string; workload: string; status: "success" | "failed" | "running"; startedAt: string | null; endedAt: string | null
    runId?: string; parentRunId?: string; parent?: string }
  const runs: Run[] = []
  let truncated = false
  for (const row of rows) {
    const startedAt = iso(row.startedAt)
    const endedAt = row.status === "running" ? null : iso(row.endedAt) ?? iso(row.recordedAt)
    const at = endedAt ?? (row.status === "running" ? startedAt : null)
    if (!at || Date.parse(at) < since) continue
    if (runs.length >= max) { truncated = true; break }
    const title = row.title?.trim()
    runs.push({
      job: row.job, workload: title ? (row.workload + " · " + title).slice(0, 200) : row.workload,
      status: row.status === "completed" ? "success" : row.status,
      startedAt: startedAt && (!endedAt || Date.parse(startedAt) <= Date.parse(endedAt)) ? startedAt : null, endedAt,
      ...(row.runId ? { runId: String(row.runId) } : {}),
      ...(row.parentRunId ? { parentRunId: String(row.parentRunId) } : {}),
      ...(row.parent ? { parent: row.parent } : {}),
    })
  }
  for (const parent of parents) {
    const at = parent.endedAt ?? parent.startedAt
    if (!at || Date.parse(at) < since) continue
    if (runs.length >= max) { truncated = true; break }
    runs.push({ ...parent, workload: parent.workload.slice(0, 200) })
  }
  runs.sort((a, b) => Date.parse(b.endedAt ?? b.startedAt ?? "") - Date.parse(a.endedAt ?? a.startedAt ?? ""))
  return { since: new Date(since).toISOString(), complete: !truncated, runs }
}

export function jobHistoryWindows(rows: JobRecord[], since: string, limit: number, now = Date.now(), parents: ParentRun[] = []) {
  const start = Date.parse(since)
  const recent = rows.filter(({ recordedAt }) => recordedAt && new Date(recordedAt).getTime() >= start)
  const runs = jobRuns(rows, now, 5000, parents)
  return {
    jobRuns: { ...runs, complete: rows.length <= limit && runs.complete },
    jobHistory: summarizeJobHistory(recent, limit),
    jobHistoryAllTime: summarizeJobHistory(rows, limit),
  }
}
