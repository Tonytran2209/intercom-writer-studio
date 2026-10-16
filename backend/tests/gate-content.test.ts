import assert from "node:assert/strict"
import test from "node:test"
import { gateResult } from "../../src/lib/ebGateContent.ts"

const activity = {
  runs: [
    { gate: "review", status: "completed", created_at: "2026-10-16T12:00:00Z", output_snapshot: { content: "Repetition report" } },
    { gate: "adapt", status: "completed", created_at: "2026-10-16T11:00:00Z", output_snapshot: { content: "Threads variants" } },
    { gate: "brief", status: "failed", created_at: "2026-10-16T10:30:00Z", output_snapshot: { content: "Failed brief" } },
    { gate: "brief", status: "completed", created_at: "2026-10-16T10:00:00Z", output_snapshot: { content: "## Brief summary\nSaved brief" } },
    { gate: "brief", status: "completed", created_at: "2026-10-15T10:00:00Z", output_snapshot: { content: "Older brief" } },
  ],
  articles: [
    { revision: 3, status: "draft", quality_report: { feedbackPending: true }, body_markdown: "Unaccepted rewrite" },
    { revision: 1, status: "superseded", body_markdown: "Old article" },
    { revision: 2, status: "draft", body_markdown: "# Website article\nFull saved article" },
  ],
  channels: [
    { id: "threads", content: { archived: true, text: "Archived social variants" } },
    { id: "facebook", content: { text: "Current Facebook post" } },
  ],
  selectedChannel: { id: "threads" },
}
test("Gate 3 -> 2 -> 1 always restores the destination format", () => {
  assert.equal(gateResult("review", activity, "facebook"), "Current Facebook post")
  assert.equal(gateResult("article", activity, "threads"), "# Website article\nFull saved article")
  assert.equal(gateResult("brief", activity, "threads"), "## Brief summary\nSaved brief")
})
test("missing gate content never falls back to social, spec, outline or review", () => {
  assert.equal(gateResult("brief", { ...activity, runs: activity.runs.filter(row => row.gate !== "brief") }), null)
  assert.equal(gateResult("article", { ...activity, articles: [] }), null)
  assert.equal(gateResult("review", activity, "threads"), null)
  assert.equal(gateResult("adapt", activity, "missing"), null)
})
