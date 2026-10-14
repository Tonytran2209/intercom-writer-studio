import type express from "express"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { tableDeleteWhere, tableInsert, tableSelect, tableUpsert } from "./supabase.ts"

type AuthRequest = express.Request & { auth?: { userId: string; email: string; role: "user" | "admin" } }
const ROOT = process.cwd()
const ALLOW_LIST = [
  ".agent-hub/project.md", ".agent-hub/design/design.md", ".agent-hub/design/components.md", ".agent-hub/design/flows.md", ".agent-hub/design/sources.md",
  ".agent-hub/backend/workflow.md", ".agent-hub/backend/api-contracts.md", ".agent-hub/database/data-model.md", ".agent-hub/database/storage.md",
  ".agent-hub/policies/ownership.md", ".agent-hub/policies/automation.md",
] as const
const MAX_DOCUMENT_CHARS = 48_000
const MAX_CHUNK_CHARS = 3_600
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function frontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) throw new Error("Agent Library document is missing frontmatter.")
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => { const index = line.indexOf(":"); return [line.slice(0, index).trim(), line.slice(index + 1).trim()] }))
}
function chunks(markdown: string) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()
  const parts = body.split(/(?=^#{1,3}\s)/m).filter(Boolean)
  const result: Array<{ heading: string; content: string }> = []
  for (const part of parts) {
    const heading = part.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? "Overview"
    for (let offset = 0; offset < part.length; offset += MAX_CHUNK_CHARS)
      result.push({ heading, content: part.slice(offset, offset + MAX_CHUNK_CHARS).trim() })
  }
  return result.filter((chunk) => chunk.content)
}
function allowedLayer(value: unknown) {
  return ["project", "design", "backend", "database", "policy"].includes(String(value)) ? String(value) : null
}
function admin(req: AuthRequest, res: express.Response) {
  if (req.auth?.role === "admin") return true
  res.status(403).json({ error: "Agent Library sync requires admin access." })
  return false
}
function authenticated(req: AuthRequest, res: express.Response) {
  if (req.auth) return true
  res.status(401).json({ error: "Authentication is required for Agent Library retrieval." })
  return false
}

export function registerAgentLibraryRoutes(app: express.Express) {
  app.post("/api/agent-library/sync", async (req: AuthRequest, res) => {
    if (!admin(req, res)) return
    try {
      const documents = await Promise.all(ALLOW_LIST.map(async (relativePath) => {
        const content = await readFile(path.join(ROOT, relativePath), "utf8")
        if (content.length > MAX_DOCUMENT_CHARS) throw new Error(`${relativePath} exceeds the document limit.`)
        const meta = frontmatter(content)
        const layer = allowedLayer(meta.layer)
        if (!layer || meta.status !== "canonical") throw new Error(`${relativePath} has invalid canonical frontmatter.`)
        return { path: relativePath, layer, title: String(meta.id ?? relativePath), content, contentHash: digest(content) }
      }))
      const versionHash = digest(documents.map((document) => document.contentHash).join(""))
      const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || versionHash
      await tableUpsert("agent_library_versions", { commit_sha: commitSha, content_hash: versionHash, synced_by: req.auth?.userId ?? null }, "commit_sha")
      const existing = await tableSelect<any>("agent_library_documents")
      for (const document of documents) {
        const previous = existing.find((row) => row.path === document.path)
        if (previous?.content_hash === document.contentHash) continue
        await tableUpsert("agent_library_documents", { path: document.path, layer: document.layer, title: document.title, content_hash: document.contentHash, char_count: document.content.length, version_commit_sha: commitSha }, "path")
        const saved = (await tableSelect<any>("agent_library_documents", (query) => query.eq("path", document.path).limit(1)))[0]
        if (!saved) throw new Error(`Unable to save ${document.path}.`)
        await tableDeleteWhere("agent_library_chunks", "document_id", saved.id)
        for (const [position, chunk] of chunks(document.content).entries())
          await tableInsert("agent_library_chunks", { document_id: saved.id, layer: document.layer, heading: chunk.heading, position, content: chunk.content, content_hash: digest(chunk.content) })
      }
      for (const stale of existing.filter((row) => !ALLOW_LIST.includes(row.path))) {
        await tableDeleteWhere("agent_library_chunks", "document_id", stale.id)
        await tableDeleteWhere("agent_library_documents", "path", stale.path)
      }
      res.json({ indexed: documents.length, commitSha, contentHash: versionHash })
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Unable to sync Agent Library." }) }
  })

  app.get("/api/agent-library/retrieve", async (req: AuthRequest, res) => {
    if (!authenticated(req, res)) return
    const query = String(req.query.query ?? "").trim(); const layer = allowedLayer(req.query.layer)
    const maxChars = Math.min(16_000, Math.max(400, Number(req.query.maxChars) || 6_000))
    if (!query) return res.status(400).json({ error: "query is required." })
    try {
      const words = new Set(query.toLowerCase().split(/[^a-z0-9à-ỹ]+/i).filter((word) => word.length > 2))
      const rows = await tableSelect<any>("agent_library_chunks", (builder) => layer ? builder.eq("layer", layer) : builder)
      const ranked = rows.map((row) => ({ ...row, score: [...words].filter((word) => `${row.heading} ${row.content}`.toLowerCase().includes(word)).length })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.position - b.position)
      let total = 0; const chunks = ranked.filter((row) => { if (total + row.content.length > maxChars) return false; total += row.content.length; return true }).map(({ id, document_id, layer, heading, position, content, score }) => ({ id, documentId: document_id, layer, heading, position, content, score }))
      res.json({ query, layer, maxChars, chunks })
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Unable to retrieve Agent Library context." }) }
  })
}
