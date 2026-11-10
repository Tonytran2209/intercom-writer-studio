// ui-kpi-v2 browser KPIs. Only the metric name and an exact duration (0.1 ms) leave the browser.
export type UiKpiMetric = "clickLatency" | "responseTime"

const MAX_EVENT_AGE_MS = 10_000

/** Start of an interaction: the click/submit event time when it is on the performance.now()
 * clock (positive, not in the future, at most 10 s old), else now (the start of the handler). */
export function interactionStart(event?: { timeStamp?: number } | null, now = performance.now()): number {
  const t = event?.timeStamp
  return typeof t === "number" && Number.isFinite(t) && t > 0 && t <= now && now - t <= MAX_EVENT_AGE_MS ? t : now
}

export const roundMs = (ms: number) => Math.round(ms * 10) / 10

/** Call right after the state change. Resolves inside the SECOND nested requestAnimationFrame,
 * i.e. once the frame showing that state has been painted; null when the page is hidden. */
export function measureAfterPaint(startedAt: number): Promise<number | null> {
  if (document.hidden) return Promise.resolve(null)
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve(document.hidden ? null : roundMs(performance.now() - startedAt))
      })
    })
  })
}

export function postPerformanceSample(metric: UiKpiMetric, ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return
  void fetch("/api/monitoring/ui-sample", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metric, ms: roundMs(ms) }),
    keepalive: true,
  }).catch(() => {})
}

/** Measure after paint and send immediately. */
export function sendPerformanceSample(metric: UiKpiMetric, startedAt: number) {
  void measureAfterPaint(startedAt).then((ms) => postPerformanceSample(metric, ms))
}
