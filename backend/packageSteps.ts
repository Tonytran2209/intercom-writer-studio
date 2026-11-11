import type { ParentRun } from "./jobHistory.ts"

// AI Agent Lab run history for EB V2: one package = one Main Job run, its gate runs = sub-jobs.
export const PACKAGE_JOB = "EB V2 package"
export const MARKDOWN_EVIDENCE_STEP = "Tìm dẫn chứng Markdown"
export const MARKDOWN_EVIDENCE_RUN_PREFIX = "lab-markdown-evidence:"

const channelLabels: Record<string, string> = { facebook: "Facebook", linkedin: "LinkedIn", threads: "Threads" }
const channelName = (channel: string) => channelLabels[channel] ?? (channel.charAt(0).toUpperCase() + channel.slice(1))

// Sub-jobs in pipeline order (brief → article → channels → repetition check). Feedback revisions
// are separate sub-jobs that do not count toward the package time.
export const pipelineSteps = [
  MARKDOWN_EVIDENCE_STEP,
  "Trích xuất brief",
  "Article Spec",
  "Lập outline",
  "Viết bài",
  "Chuyển thể Facebook",
  "Chuyển thể LinkedIn",
  "Chuyển thể Threads",
  "Kiểm tra trùng lặp",
]
export const FEEDBACK_ARTICLE = "Sửa bài theo feedback"
export const FEEDBACK_CHANNEL = "Sửa post theo feedback"

// Map one eb_v2_gate_runs row to its sub-job name.
export function gateStepName(gate: string, stage: string): string {
  const [head, channel] = String(stage ?? "").split(":")
  if (gate === "brief") return "Trích xuất brief"
  if (gate === "article")
    return head === "article_spec" ? "Article Spec" : head === "outline" ? "Lập outline" : head === "draft" ? "Viết bài"
      : head === "feedback" ? FEEDBACK_ARTICLE : "EB V2 article · " + head
  if (gate === "adapt")
    return head === "feedback" ? FEEDBACK_CHANNEL : "Chuyển thể " + channelName(channel || head)
  if (gate === "review") return "Kiểm tra trùng lặp"
  return "EB V2 " + gate
}

const isFeedback = (job: string) => job === FEEDBACK_ARTICLE || job === FEEDBACK_CHANNEL

// Targets in minutes from 61 days of production runs (P95 rounded up): brief 6.7s, article stage
// 9.8s, channel 22.7s, repetition check 17.3s; a package's summed processing P95 is about 77s.
export const labProfile = {
  version: "profile-v1",
  mainJob: { job: PACKAGE_JOB, steps: pipelineSteps },
  // Failure-rate target in percent (success ≥ 99%): 12/12 packages and 205/206 gate runs succeeded
  // in 61 days. Lab uses it until there are enough packages for its own baseline.
  errorRateTarget: 1,
  // What the browser KPIs measure under ui-kpi-v2 (src/components/EbWorkingSpace.tsx,
  // legacy Step3Outline.tsx, src/lib/performanceTelemetry.ts).
  kpiDescriptions: {
    responseTime: "Từ lúc bấm 'Phân tích' hoặc 'Tạo outline' đến khung hình thứ hai sau tín hiệu accepted. Với 'Chuyển sang Gate 1' hoặc 'Tìm lại dẫn chứng F', đo đến khi hiển thị thẻ sau khi server nhận việc. Chỉ số không chờ AI hoàn thành brief/outline.",
    clickLatency: "Từ lúc bấm 'Phân tích', 'Tạo outline', 'Chuyển sang Gate 1' hoặc 'Tìm lại dẫn chứng F' đến khung hình thứ hai hiển thị trạng thái đang xử lý",
  },
  jobTargets: <Record<string, number>>{
    [PACKAGE_JOB]: 2,
    [MARKDOWN_EVIDENCE_STEP]: 15 / 60,
    "Trích xuất brief": 10 / 60,
    "Article Spec": 15 / 60,
    "Lập outline": 15 / 60,
    "Viết bài": 15 / 60,
    "Chuyển thể Facebook": 0.5,
    "Chuyển thể LinkedIn": 0.5,
    "Chuyển thể Threads": 0.5,
    "Kiểm tra trùng lặp": 0.5,
  },
}

type Interval = [number, number]
function unionMs(intervals: Interval[]) {
  let total = 0, end = -Infinity
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue
    total += b - Math.max(a, end)
    end = b
  }
  return total
}

export type GateRow = { runId: string; job: string; status: string; startedAt: string | null; endedAt: string | null }

// The package run for a package that reached review/completed: its time is the processing time of
// the pipeline gate runs (union, so parallel channels count once; human approvals in between are
// not counted); it failed if the latest run of any pipeline step failed. Packages still waiting for
// approval get no package run: Lab lists their gate runs as an unscored group.
export function packageRun(pkg: { id: string; workload: string; state: string | null }, gates: GateRow[]): ParentRun | null {
  if (!["review", "completed"].includes(String(pkg.state))) return null
  const pipeline = gates.filter((g) => !isFeedback(g.job) && g.endedAt)
  if (!pipeline.length) return null
  const latest = new Map<string, GateRow>()
  for (const g of [...pipeline].sort((a, b) => Date.parse(a.endedAt!) - Date.parse(b.endedAt!))) latest.set(g.job, g)
  const failed = [...latest.values()].some((g) => g.status === "failed")
  const intervals = pipeline.flatMap((g) => g.startedAt ? [[Date.parse(g.startedAt), Date.parse(g.endedAt!)] as Interval] : [])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a <= b)
  const end = Math.max(...pipeline.map((g) => Date.parse(g.endedAt!)).filter(Number.isFinite))
  if (!Number.isFinite(end)) return null
  const total = unionMs(intervals)
  return {
    job: PACKAGE_JOB, runId: "package:" + pkg.id, workload: pkg.workload,
    status: failed ? "failed" : "success",
    startedAt: total > 0 ? new Date(end - total).toISOString() : null, endedAt: new Date(end).toISOString(),
  }
}
