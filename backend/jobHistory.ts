const technicalFailure = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|timeout|timed out)\b|\b(?:HTTP|status(?: code)?)\s*[:=]?\s*5\d{2}\b/i

const rejectedOutput = /^(?:Brief còn thông tin N\/A\.|AI did not return a valid JSON object after one automatic format recovery\.|Batch Step 1 did not return a valid rated Core Idea\.)/

type JobRecord = {
  job: string
  workload: string
  status: "completed" | "failed"
  valid: boolean
  startedAt: string | Date | null
  endedAt: string | Date | null
  error: string | null
}

export function summarizeJobHistory(rows: JobRecord[], limit: number) {
  const durations = new Map<string, { job: string; workload: string; values: number[] }>()
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
    const duration = new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()
    if (!Number.isFinite(duration) || duration < 0) continue
    const key = JSON.stringify([row.job, row.workload])
    const group = durations.get(key) ?? { job: row.job, workload: row.workload, values: [] }
    group.values.push(duration)
    durations.set(key, group)
  }
  return {
    executed, failed, technicalErrors, unclassifiedFailures, validCompletions, unverifiedCompletions,
    complete: rows.length <= limit,
    completion: [...durations.values()].map(({ job, workload, values }) => ({
      job, workload, samples: values.length,
      p95Ms: values.sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1],
    })),
  }
}
