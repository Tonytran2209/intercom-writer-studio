export function refinementPlan(article: string, requestedHeading?: string) {
  if (!requestedHeading) return { input: article, merge: (replacement: string) => replacement, scope: "full" }
  const escaped = requestedHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`^#{1,6} ${escaped}\\s*$`, "m").exec(article)
  if (!match) throw new Error("The selected section no longer exists. Reload the article.")
  const depth = match[0].match(/^#+/)![0].length
  const tail = article.slice(match.index + match[0].length)
  const next = new RegExp(`^#{1,${depth}} `, "m").exec(tail)
  const end = next ? match.index + match[0].length + next.index : article.length
  return { input: article.slice(match.index, end), scope: requestedHeading,
    merge: (replacement: string) => article.slice(0, match.index) + replacement.trimEnd() + "\n\n" + article.slice(end) }
}

export function refinementChecks(original: string, revised: string, channel?: string) {
  const warnings: string[] = []
  if (!revised.trim()) throw new Error("AI returned an empty revision.")
  const headings = original.match(/^#{1,6} .+$/gm) ?? []
  if (headings.some((heading) => !revised.includes(heading))) warnings.push("Some original headings changed; review the structure before accepting.")
  const facts = original.match(/https?:\/\/[^\s)]+|\b\d+(?:[.,]\d+)?%?/g) ?? []
  if (facts.some((fact) => !revised.includes(fact))) warnings.push("Some original numbers or source links changed; verify evidence before accepting.")
  if (channel === "threads" && revised.split(/Variant [AB][^\n]*\n/i).filter((part) => part.trim()).some((part) => [...part.trim()].length > 500)) warnings.push("Check Threads variants against the 500-character limit.")
  return warnings
}
