import { isolateChannelOutput } from "./channelOutput"

type Gate = "brief" | "article" | "adapt" | "review"

// Activity includes the full audit history. Result must come only from this gate.
export function gateResult(gate: Gate, activity: any, channelId?: string): string | null {
  if (gate === "brief") {
    const brief = (activity?.runs ?? [])
      .filter((run: any) => run.gate === "brief" && run.status === "completed" && run.output_snapshot?.content?.trim())
      .sort((a: any, b: any) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0]
    return brief?.output_snapshot?.content ?? null
  }
  if (gate === "article") {
    const article = (activity?.articles ?? [])
      .filter((row: any) => row.status !== "superseded" && !row.quality_report?.feedbackPending && row.body_markdown?.trim())
      .sort((a: any, b: any) => Number(b.revision) - Number(a.revision))[0]
    return article?.body_markdown ?? null
  }
  const channels = (activity?.channels ?? []).filter((row: any) => !row.content?.archived && !row.content?.feedbackPending)
  const channel = channels.find((row: any) => row.id === channelId)
    ?? (!channelId ? channels.find((row: any) => row.id === activity?.selectedChannel?.id) : null)
  if (!channel?.content?.text) return null
  return isolateChannelOutput(channel.content.text, channel.channel) || null
}
