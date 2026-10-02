import type { Article, AppConfig, DocumentFile, WebsiteContentRecord } from "../types"
import { isShellMode } from "./appMode"

export type UserRole = "user" | "admin"
export interface AuthSession {
  accessToken: string
  expiresAt: number | null
  user: { id: string; email: string; role: UserRole }
}

export function getAuthSession(): AuthSession | null {
  return { accessToken: "local", expiresAt: null, user: { id: "shared-writer", email: "shared@writer.studio", role: "admin" } }
}

export function clearAuthSession() {}

function resolveRailwayUrl(explicitUrl?: string): string {
  const saved =
    typeof window !== "undefined"
      ? localStorage.getItem("writer:railwayUrl")
      : null
  const sameOrigin = typeof window !== "undefined" ? window.location.origin : ""
  const url = explicitUrl?.trim() || saved?.trim() || sameOrigin
  if (!url) throw new Error("Chưa cấu hình Railway URL.")
  return url.replace(/\/$/, "")
}

async function railwayRequest<T>(
  path: string,
  init?: RequestInit,
  railwayUrl?: string,
): Promise<T> {
  if (isShellMode)
    throw new Error("Shell mode is active. No Railway or Supabase request was made.")
  const url = `${resolveRailwayUrl(railwayUrl)}${path}`
  const method = (init?.method ?? "GET").toUpperCase()
  const maxAttempts = method === "GET" ? 3 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response
    try {
      const headers = new Headers(init?.headers)
      response = await fetch(url, { ...init, headers })
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 750))
      continue
    }

    const payload = await response
      .json()
      .catch(() => ({ error: response.statusText }))
    const transient = [502, 503, 504].includes(response.status)

    if (response.ok) return payload as T
    if (!transient || attempt === maxAttempts) {
      throw new Error(payload.error || `Railway error ${response.status}`)
    }
    lastError = new Error(payload.error || `Railway error ${response.status}`)

    await new Promise((resolve) => setTimeout(resolve, attempt * 750))
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Không thể kết nối Railway.")
}

// ── Articles ──────────────────────────────────────────────────────────────────

export async function fetchArticles(): Promise<Article[]> {
  return railwayRequest<Article[]>("/api/articles")
}

export async function saveArticle(article: Article): Promise<Article> {
  const result = await railwayRequest<{ article: Article }>(
    "/api/articles",
    jsonRequest("POST", article),
  )
  return result.article
}

export async function updateArticle(
  id: string,
  updates: Partial<Article>,
): Promise<Article> {
  const result = await railwayRequest<{ article: Article }>(
    `/api/articles/${encodeURIComponent(id)}`,
    jsonRequest("PUT", updates),
  )
  return result.article
}

export async function deleteArticle(id: string): Promise<void> {
  await railwayRequest(`/api/articles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

export async function deleteBatch(activityId: string): Promise<void> {
  await railwayRequest(`/api/batches/${encodeURIComponent(activityId)}`, {
    method: "DELETE",
  })
}

export async function migrateLegacyArticle(id: string): Promise<Article> {
  const result = await railwayRequest<{ article: Article }>(
    `/api/articles/${encodeURIComponent(id)}/migrate-legacy`,
    { method: "POST" },
  )
  return result.article
}

export async function startBatch(activityId: string): Promise<void> {
  await railwayRequest(`/api/batches/${encodeURIComponent(activityId)}/start`, {
    method: "POST",
  })
}

export async function pauseBatch(activityId: string): Promise<void> {
  await railwayRequest(`/api/batches/${encodeURIComponent(activityId)}/pause`, {
    method: "POST",
  })
}

export async function retryBatchArticle(
  activityId: string,
  articleId: string,
): Promise<Article> {
  const result = await railwayRequest<{ article: Article }>(
    `/api/batches/${encodeURIComponent(activityId)}/retry/${encodeURIComponent(articleId)}`,
    { method: "POST" },
  )
  return result.article
}

export async function fetchBatch(
  activityId: string,
): Promise<{ batch: Record<string, unknown> | null; articles: Article[] }> {
  return railwayRequest(`/api/batches/${encodeURIComponent(activityId)}`)
}

// ── Config ────────────────────────────────────────────────────────────────────

export async function fetchConfig(): Promise<AppConfig | null> {
  return railwayRequest<AppConfig | null>("/api/config")
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await railwayRequest(
    "/api/config",
    jsonRequest("POST", config),
    config.railwayUrl,
  )
}

// ── EB Workspace V2 (isolated from legacy Writer Studio records) ────────────
export interface EbV2Workspace { packages: any[]; articles: any[]; channels: any[]; discovery: any[] }
// V2 is hosted with the current frontend. Never inherit writer:railwayUrl,
// which may still point to an older legacy Railway service in localStorage.
function ebV2Origin() { return typeof window === "undefined" ? undefined : window.location.origin }
export async function fetchEbV2Settings(): Promise<AppConfig | null> { const result = await railwayRequest<{ settings: AppConfig | null }>("/api/eb-v2/settings", undefined, ebV2Origin()); return result.settings }
export async function saveEbV2Settings(settings: AppConfig): Promise<void> { await railwayRequest("/api/eb-v2/settings", jsonRequest("POST", { settings }), ebV2Origin()) }
export async function fetchEbV2Workspace(): Promise<EbV2Workspace> { return railwayRequest<EbV2Workspace>("/api/eb-v2/workspace", undefined, ebV2Origin()) }
export async function createEbV2Package(input: { title?: string; inputText: string; sourceType: "input" | "upload" | "discovery"; discoveryId?: string; model: { provider: string; id: string } }) { return railwayRequest<any>("/api/eb-v2/packages", jsonRequest("POST", input), ebV2Origin()) }
export async function uploadEbV2Package(file: File, model: { provider: string; id: string }) { const body = new FormData(); body.append("file", file); body.append("provider", model.provider); body.append("modelId", model.id); return railwayRequest<any>("/api/eb-v2/packages/upload", { method: "POST", body }, ebV2Origin()) }
export async function runEbV2Discovery(model: { provider: string; id: string }, sourceUrls: string[] = []) { return railwayRequest<{ items: any[] }>("/api/eb-v2/discovery", jsonRequest("POST", { model, sourceUrls }), ebV2Origin()) }
export async function fetchEbV2LibraryDocuments() { return railwayRequest<{ documents: any[] }>("/api/eb-v2/library-documents", undefined, ebV2Origin()) }
export async function fetchEbV2Activity(id: string, kind: "package" | "channel") { return railwayRequest<any>(`/api/eb-v2/activity/${encodeURIComponent(id)}?kind=${kind}`, undefined, ebV2Origin()) }
export async function fetchEbV2DiscoveryDetail(id: string) { return railwayRequest<any>(`/api/eb-v2/discovery/${encodeURIComponent(id)}/details`, undefined, ebV2Origin()) }
export async function deleteEbV2Discovery(id: string) { return railwayRequest<EbV2Workspace>(`/api/eb-v2/discovery/${encodeURIComponent(id)}`, { method: "DELETE" }, ebV2Origin()) }
export async function clearEbV2Discovery() { return railwayRequest<EbV2Workspace>("/api/eb-v2/discovery", { method: "DELETE" }, ebV2Origin()) }
export async function approveEbV2Brief(id: string, model: { provider: string; id: string }) { return railwayRequest<any>(`/api/eb-v2/packages/${encodeURIComponent(id)}/approve-brief`, jsonRequest("POST", { model }), ebV2Origin()) }
export async function approveEbV2Article(id: string, adaptModel: { provider: string; id: string }) { return railwayRequest<EbV2Workspace>(`/api/eb-v2/packages/${encodeURIComponent(id)}/approve-article`, jsonRequest("POST", { adaptModel }), ebV2Origin()) }
export async function reviewEbV2Channel(id: string, action: "done" | "reject" | "recheck") { return railwayRequest<EbV2Workspace>(`/api/eb-v2/channel-outputs/${encodeURIComponent(id)}/review`, jsonRequest("POST", { action }), ebV2Origin()) }
export async function regenerateEbV2Package(id: string, stage: "brief" | "article", model: { provider: string; id: string }) { return railwayRequest<EbV2Workspace>(`/api/eb-v2/packages/${encodeURIComponent(id)}/regenerate`, jsonRequest("POST", { stage, model }), ebV2Origin()) }
export async function moveEbV2Package(id: string, target: "brief" | "article") { return railwayRequest<EbV2Workspace>(`/api/eb-v2/packages/${encodeURIComponent(id)}/move`, jsonRequest("POST", { target }), ebV2Origin()) }
export async function regenerateEbV2Channel(id: string, model: { provider: string; id: string }) { return railwayRequest<EbV2Workspace>(`/api/eb-v2/channel-outputs/${encodeURIComponent(id)}/regenerate`, jsonRequest("POST", { model }), ebV2Origin()) }
export async function deleteEbV2Package(id: string) { return railwayRequest<EbV2Workspace>(`/api/eb-v2/packages/${encodeURIComponent(id)}`, { method: "DELETE" }, ebV2Origin()) }
export async function deleteEbV2ChannelOutput(id: string) { return railwayRequest<EbV2Workspace>(`/api/eb-v2/channel-outputs/${encodeURIComponent(id)}`, { method: "DELETE" }, ebV2Origin()) }

export async function scanWebsiteUrl(
  url: string,
  railwayUrl?: string,
  aiSummary = true,
): Promise<import("../types").WebsiteContentRecord> {
  const result = await railwayRequest<{
    record: import("../types").WebsiteContentRecord
  }>("/api/website-inventory/scan", jsonRequest("POST", { url, aiSummary }), railwayUrl)
  return result.record
}

export interface WebsiteInventoryBatchJob {
  id: string
  status: "queued" | "running" | "complete" | "failed" | "cancelled"
  total: number
  done: number
  failed: number
  summaryLimitReached: boolean
  recentRecords: WebsiteContentRecord[]
  error?: string
}

export async function startWebsiteInventoryBatch(
  urls: string[],
  railwayUrl?: string,
  aiSummary = true,
): Promise<WebsiteInventoryBatchJob> {
  const result = await railwayRequest<{ job: WebsiteInventoryBatchJob }>(
    "/api/website-inventory/batches",
    jsonRequest("POST", { urls, aiSummary }),
    railwayUrl,
  )
  return result.job
}

export async function fetchWebsiteInventoryBatch(
  id: string,
  railwayUrl?: string,
): Promise<WebsiteInventoryBatchJob> {
  const result = await railwayRequest<{ job: WebsiteInventoryBatchJob }>(
    `/api/website-inventory/batches/${encodeURIComponent(id)}`,
    undefined,
    railwayUrl,
  )
  return result.job
}

export async function cancelWebsiteInventoryBatch(
  id: string,
  railwayUrl?: string,
): Promise<WebsiteInventoryBatchJob> {
  const result = await railwayRequest<{ job: WebsiteInventoryBatchJob }>(
    `/api/website-inventory/batches/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    railwayUrl,
  )
  return result.job
}

export async function cancelAllWebsiteInventoryBatches(
  railwayUrl?: string,
): Promise<number> {
  const result = await railwayRequest<{ cancelled: number }>(
    "/api/website-inventory/batches",
    { method: "DELETE" },
    railwayUrl,
  )
  return result.cancelled
}

export async function fetchWebsiteInventory(
  railwayUrl?: string,
): Promise<WebsiteContentRecord[]> {
  const result = await railwayRequest<{ records: WebsiteContentRecord[] }>(
    "/api/website-inventory",
    undefined,
    railwayUrl,
  )
  return result.records
}

export async function updateWebsiteInventoryRecord(
  id: string,
  updates: Partial<WebsiteContentRecord>,
  railwayUrl?: string,
): Promise<WebsiteContentRecord> {
  const result = await railwayRequest<{ record: WebsiteContentRecord }>(
    `/api/website-inventory/${encodeURIComponent(id)}`,
    jsonRequest("PATCH", updates),
    railwayUrl,
  )
  return result.record
}

export async function deleteWebsiteInventoryRecord(
  id: string,
  railwayUrl?: string,
): Promise<void> {
  await railwayRequest(`/api/website-inventory/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }, railwayUrl)
}

// ── Files ─────────────────────────────────────────────────────────────────────

export async function fetchFiles(): Promise<DocumentFile[]> {
  return railwayRequest<DocumentFile[]>("/api/files")
}

export async function saveFiles(
  files: DocumentFile[],
  railwayUrl: string,
): Promise<void> {
  await railwayRequest("/api/files", jsonRequest("POST", files), railwayUrl)
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

// ── Railway health check ───────────────────────────────────────────────────────

export async function pingRailway(
  url: string,
): Promise<{
  ok: boolean
  providers?: Record<string, boolean>
  seoResearch?: boolean
}> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { ok: false }
    const data = await res.json()
    return {
      ok: true,
      providers: data.providers,
      seoResearch: Boolean(data.seoResearch),
    }
  } catch {
    return { ok: false }
  }
}
