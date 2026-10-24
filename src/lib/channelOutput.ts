// Only standalone channel labels count as delivery boundaries, not mentions in prose.
export function isolateChannelOutput(content: string, channel: string): string {
  const labels = [...content.matchAll(/^\s*(?:#{1,6}\s+)?(?:\*\*)?(Threads|Facebook|LinkedIn)(?:\*\*)?\s*:?\s*$/gim)]
  const selected = labels.filter(label => label[1].toLowerCase() === channel.toLowerCase())
  if (!labels.length) return content
  if (!selected.length) return ""
  return selected.map(label => {
    const next = labels.find(candidate => candidate.index! > label.index!)
    return content.slice(label.index! + label[0].length, next?.index ?? content.length).trim()
  }).filter(Boolean).join("\n\n")
}
