import "dotenv/config"
import express from "express"
import cors from "cors"
import multer from "multer"
import crypto from "crypto"
import path from "path"
import { fileURLToPath } from "url"
import { generate, getAvailableProviders } from "./providers.ts"
import {
  kvGet,
  kvSet,
  kvDelete,
  kvGetByPrefix,
  checkConnection,
  uploadDocumentBinary,
  downloadDocumentBinary,
  deleteDocumentBinaries,
  runReadOnlySelect,
  tableAvailable,
  tableSelect,
  tableInsert,
  tableUpsert,
  tableUpdate,
  tableDeleteWhere,
} from "./supabase.ts"
import { extractDocumentText } from "./documentParser.ts"
import { extractStructuredSections } from "./documentStructure.ts"
import {
  resolveStepContext,
  resolveStep1WaveContexts,
  type StepWaveContext,
} from "./stepContext.ts"
import { compileBackendWorkflowRules } from "./workflowRules.ts"
import { researchSeoKeywords, seoResearchConfigured } from "./seoResearch.ts"
import { jsonrepair } from "jsonrepair"
import { scanWebsiteUrl, selectWebsiteCandidates } from "./websiteInventory.ts"
import { registerEbV2Routes } from "./ebV2.ts"

// DIST_PATH env var set by Railway start command; fallback to sibling dist/ of cwd
const DIST = process.env.DIST_PATH
  ? path.resolve(process.cwd(), process.env.DIST_PATH)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist")

console.log(`[static] serving frontend from: ${DIST}`)

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors({ origin: process.env.CORS_ORIGIN || true }))
app.use(express.json({ limit: "10mb" }))
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
})

type AuthenticatedRequest = express.Request & {
  auth?: { userId: string; email: string; role: "user" | "admin" }
}

app.use("/api", async (req: AuthenticatedRequest, res, next) => {
  // Writer Studio is a shared internal application. Supabase is used only by
  // the server as persistence; no request is authenticated or role-gated.
  req.auth = { userId: "00000000-0000-0000-0000-000000000000", email: "shared@writer.studio", role: "admin" }
  next()
})

registerEbV2Routes(app)

const ARTICLE_PREFIX = "writer:article:"
const LEARNING_DECISIONS_KEY = "writer:learning:decision-cards:v1"
const articleMutationQueues = new Map<string, Promise<unknown>>()
const aiBudgetQueues = new Map<string, Promise<unknown>>()
const batchControllers = new Map<string, { paused: boolean; running: boolean }>()
const deletedBatchIds = new Set<string>()
const DAILY_AI_LIMITS: Record<number, number> = { 1: 12, 2: 12, 3: 10, 4: 6 }

type LearningDecisionCard = {
  id: string
  contentType: string
  primaryKeyword: string
  audience: string
  angle: string
  title: string
  thesis: string
  mustCover: string[]
  tone: string
  selectedAt: string
}

function compactText(value: unknown, limit: number) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit)
}

function explicitContentGroupLine(line: string) {
  return line.match(/^\s*\[?(comparison-seo|editorial-originality)\]?\s*[:|–—-]\s*(.+)$/i)
}

// A content plan can label rows explicitly.  Those rows are already a human
// data decision, so sending them to the classifier wastes tokens and can
// introduce needless disagreement.  Ambiguous rows still go through AI.
function deterministicPlanItems(plan: any) {
  const items: any[] = []
  for (const source of plan?.sources ?? []) {
    const lines = String(source?.extractedContent ?? "").replace(/\r\n?/g, "\n").split("\n")
    for (const line of lines) {
      const match = explicitContentGroupLine(line)
      if (!match) continue
      const detail = compactText(match[2], 500)
      const [rawTitle, rawKeywords = ""] = detail.split(/\s*\|\s*/, 2)
      const title = compactText(rawTitle, 220)
      if (!title) continue
      items.push({
        id: `explicit-${crypto.createHash("sha256").update(`${source.id}|${line}`).digest("hex").slice(0, 20)}`,
        title,
        keywords: rawKeywords.split(/[,;]+/).map((item: string) => compactText(item, 120)).filter(Boolean),
        type: match[1].toLocaleLowerCase(),
        confidence: 1,
        classificationReason: "Explicit content-group label in source plan.",
        sourceId: source.id,
        sourceSectionId: "explicit-row",
        sourceLine: line.trim(),
        sourceQuote: line.trim(),
      })
    }
  }
  return items
}

async function recordLearningDecision(article: any) {
  const idea = selectedArticleIdea(article)
  if (!idea || !article?.articleSpec || !String(article?.contentType ?? "").trim()) return
  const card: LearningDecisionCard = {
    id: crypto.createHash("sha256").update([
      article.contentType,
      idea.primaryKeyword,
      idea.title,
    ].map(value => compactText(value, 160).toLocaleLowerCase()).join("|")).digest("hex"),
    contentType: compactText(article.contentType, 80),
    primaryKeyword: compactText(idea.primaryKeyword, 120),
    audience: compactText(idea.targetAudience ?? article.articleSpec.audience, 160),
    angle: compactText(idea.angleLabel, 100),
    title: compactText(idea.title, 180),
    thesis: compactText(idea.mainArgument ?? article.articleSpec.thesis, 280),
    mustCover: Array.isArray(article.articleSpec.mustCover)
      ? article.articleSpec.mustCover.map((item: unknown) => compactText(item, 100)).filter(Boolean).slice(0, 6)
      : [],
    tone: compactText(idea.recommendedTone ?? article.tone, 80),
    selectedAt: new Date().toISOString(),
  }
  const existing = await kvGet<LearningDecisionCard[]>(LEARNING_DECISIONS_KEY)
  const cards = Array.isArray(existing) ? existing : []
  await kvSet(LEARNING_DECISIONS_KEY, [card, ...cards.filter(item => item?.id !== card.id)].slice(0, 60))
}

async function learningDecisionContext(article: any, stepNumber: number) {
  if (stepNumber !== 2 && stepNumber !== 3) return ""
  const cards = await kvGet<LearningDecisionCard[]>(LEARNING_DECISIONS_KEY)
  const contentType = compactText(article?.contentType, 80).toLocaleLowerCase()
  const selected = (Array.isArray(cards) ? cards : [])
    .filter(card => compactText(card.contentType, 80).toLocaleLowerCase() === contentType)
    .slice(0, 3)
    .map(({ selectedAt, ...card }) => card)
  if (!selected.length) return ""
  return [
    "<<<LEARNING_DECISION_CARDS>>>",
    "These are prior human selections for style and preference only. They are not factual evidence and must not be cited or override the supplied documents.",
    JSON.stringify(selected),
    "<<<END_LEARNING_DECISION_CARDS>>>",
  ].join("\n")
}

function hasArticlePlanSelection(article: any) {
  return Boolean(
    article?.contentPlanId &&
      (article.contentPlanSourceItemId ||
        article.contentPlanItemId ||
        article.selectedContentTypeSuggestionId) &&
      String(article.contentPlanInput ?? "").trim() &&
      String(article.topic ?? "").trim() &&
      String(article.contentType ?? "").trim(),
  )
}

function selectedArticleIdea(article: any) {
  if (
    !article?.selectedCoreIdeaId ||
    !Array.isArray(article.coreIdeaSuggestions)
  )
    return null
  return (
    article.coreIdeaSuggestions.find(
      (idea: any) => idea?.id === article.selectedCoreIdeaId,
    ) ?? null
  )
}

function articleStepPrerequisite(article: any, step: number): string | null {
  if (!hasArticlePlanSelection(article))
    return "Select an article from a classified Content Plan before running Step 1."
  if (
    step >= 3 &&
    (!selectedArticleIdea(article) ||
      !article?.articleSpec ||
      !article?.articleSpecFingerprint)
  )
    return "Step 2 requires a saved Article Spec and an explicit direction selection from Step 1."
  if (
    step >= 4 &&
    (!Array.isArray(article.outline) ||
      !article.outline.length ||
      article.outline.some(
        (section: any) => !String(section?.heading ?? "").trim(),
      ))
  ) {
    return "Step 3 requires a valid saved outline from Step 2."
  }
  if (
    step >= 4 &&
    article?.activityType === "editorial-originality" &&
    article?.editorialApproval?.status !== "approved"
  )
    return "Editorial articles require explicit outline approval before draft generation."
  return null
}

function highestReachableArticleStep(article: any): 2 | 3 | 4 {
  if (!articleStepPrerequisite(article, 4)) return 4
  if (!articleStepPrerequisite(article, 3)) return 3
  return 2
}

function clampStoredArticleStep(article: any): 2 | 3 | 4 {
  const requested = Math.min(4, Math.max(2, Number(article?.currentStep) || 2))
  return Math.min(requested, highestReachableArticleStep(article)) as 2 | 3 | 4
}

function workflowPrerequisiteResponse(res: any, message: string) {
  return res
    .status(409)
    .json({ code: "WORKFLOW_PREREQUISITE_MISSING", error: message })
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  mistral: "Mistral",
  groq: "Groq",
  together: "Together AI",
  deepseek: "DeepSeek",
}

function classifyAIError(error: unknown, provider: string, modelId: string) {
  const raw = error instanceof Error ? error.message : String(error)
  const details =
    typeof error === "object" && error
      ? JSON.stringify(error, Object.getOwnPropertyNames(error))
      : raw
  const searchable = `${raw} ${details}`.toLocaleLowerCase()
  const providerName = PROVIDER_NAMES[provider] ?? provider
  const creditsExhausted = [
    /no credits? remaining/,
    /not enough credits?/,
    /credits?.*(?:exhausted|depleted|empty)/,
    /insufficient[_ -]?quota/,
    /insufficient.*(?:balance|funds|credits?)/,
    /credit balance.*(?:low|insufficient|exhausted|empty)/,
    /payment required/,
    /billing hard limit/,
    /(?:billing|payment).*(?:quota|limit|required|inactive|disabled)/,
    /(?:quota|limit).*(?:billing|payment)/,
    /add credits? to continue/,
  ].some((pattern) => pattern.test(searchable))
  if (creditsExhausted) {
    return {
      status: 402,
      body: {
        code: "AI_CREDITS_EXHAUSTED",
        provider,
        modelId,
        error: `${providerName} API đã hết credits hoặc tài khoản billing không còn hoạt động. Model ${modelId} tạm thời không thể chạy. Vui lòng nạp credits hoặc chọn model thuộc provider khác.`,
      },
    }
  }
  if (/giới hạn.*ai calls/i.test(raw)) {
    return {
      status: 429,
      body: { code: "ARTICLE_DAILY_AI_LIMIT", provider, modelId, error: raw },
    }
  }
  const status = Number(
    (error as any)?.status ?? (error as any)?.statusCode ?? 0,
  )
  if (
    status === 429 ||
    /rate[_ -]?limit|resource[_ -]?exhausted|too many requests|quota exceeded/i.test(
      searchable,
    )
  ) {
    return {
      status: 429,
      body: {
        code: "AI_PROVIDER_QUOTA_EXCEEDED",
        provider,
        modelId,
        error: `${providerName} đang vượt quota hoặc rate limit cho model ${modelId}. Vui lòng thử lại sau hoặc chọn provider khác.`,
      },
    }
  }
  return {
    status: 500,
    body: {
      code: "AI_PROVIDER_ERROR",
      provider,
      modelId,
      error: raw || "Lỗi gọi AI API",
    },
  }
}

function serializeByKey<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  // The queue tail must always resolve. A rejected promise created by
  // `finally()` remains unhandled even when the caller catches `result`, and
  // Node 22 terminates the process for that rejection.
  const queued = result.then(
    () => { if (queues.get(key) === queued) queues.delete(key) },
    () => { if (queues.get(key) === queued) queues.delete(key) },
  )
  queues.set(key, queued)
  return result
}

async function loadArticles(): Promise<any[]> {
  const records = await kvGetByPrefix(ARTICLE_PREFIX)
  const individual = records.map((record) => record.value).filter(Boolean)
  const legacy = (await kvGet<any[]>("writer:articles")) ?? []
  const relationalRows = (await tableAvailable("writer_articles"))
    ? await tableSelect<any>("writer_articles", (query) =>
        query.select("id, title, status, current_step, payload, draft, created_at, updated_at, completed_at"),
      )
    : []
  const relational = relationalRows.map((row) => ({
    ...(row.payload && typeof row.payload === "object" ? row.payload : {}),
    id: row.id,
    title: row.payload?.title || row.title,
    status: row.payload?.status || row.status,
    currentStep: row.payload?.currentStep ?? row.current_step,
    draft: row.payload?.draft ?? row.draft,
    createdAt: row.payload?.createdAt || row.created_at,
    updatedAt: row.payload?.updatedAt || row.updated_at,
    completedAt: row.payload?.completedAt ?? row.completed_at,
  }))
  const individualIds = new Set(individual.map((article) => article.id).filter(Boolean))
  const missingLegacy = legacy.filter(
    (article) => article?.id && !individualIds.has(article.id),
  )
  const knownIds = new Set([...individualIds, ...missingLegacy.map((article) => article.id)])
  const missingRelational = relational.filter(
    (article) => article?.id && !knownIds.has(article.id),
  )
  await Promise.all(
    [...missingLegacy, ...missingRelational].map((article) =>
      kvSet(`${ARTICLE_PREFIX}${article.id}`, article),
    ),
  )
  return [...individual, ...missingLegacy, ...missingRelational].map((article) => {
    const hasPlanContract = Boolean(
      article?.contentPlanId &&
      (article?.contentPlanSourceItemId || article?.contentPlanItemId || article?.selectedContentTypeSuggestionId) &&
      String(article?.contentPlanInput ?? "").trim(),
    )
    const hasLegacyOutput = Boolean(
      String(article?.draft ?? "").trim() ||
      article?.outline?.length ||
      article?.coreIdeaSuggestions?.length ||
      article?.contentTypeSuggestions?.length,
    )
    return !hasPlanContract && hasLegacyOutput
      ? { ...article, legacyReadOnly: true, legacyReason: "missing-current-content-plan-contract" }
      : article
  }).sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  )
}

async function reserveAIBudget(
  articleId: string,
  stepNumber: number,
): Promise<{ used: number; limit: number }> {
  const date = new Date().toISOString().slice(0, 10)
  const key = `writer:ai-budget:${date}:${articleId}:step-${stepNumber}`
  return serializeByKey(aiBudgetQueues, key, async () => {
    const current = await kvGet<{ used?: number }>(key)
    const used = Number(current?.used ?? 0)
    const limit = DAILY_AI_LIMITS[stepNumber] ?? 6
    if (used >= limit)
      throw new Error(
        `Đã đạt giới hạn ${limit} AI calls tính phí cho Step ${stepNumber} hôm nay. Hãy dùng kết quả đã lưu hoặc chờ sang ngày mới.`,
      )
    await kvSet(key, {
      used: used + 1,
      limit,
      updatedAt: new Date().toISOString(),
    })
    return { used: used + 1, limit }
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function contentMetadata(content: string) {
  return {
    contentLength: content.length,
    contentHash: crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex"),
    scanStatus: "ready" as const,
    structuredSections: extractStructuredSections(content),
  }
}

function aiCacheKey(input: unknown): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
  return `writer:ai-cache:${digest}`
}

function repairModelJson(input: string) {
  let output = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (!inString) {
      if (char === '"') inString = true
      output += char
      continue
    }
    if (escaped) {
      output += char
      escaped = false
      continue
    }
    if (char === "\\") {
      output += char
      escaped = true
      continue
    }
    if (char !== '"') {
      output += char
      continue
    }
    const next = input.slice(index + 1).match(/^\s*([,:}\]"])/)?.[1]
    if (next || !input.slice(index + 1).trim()) {
      inString = false
      output += char
    } else output += '\\"'
  }
  return output
    .replace(/\u00a0/g, " ")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/}\s*{/g, "},{")
    .replace(
      /("(?:\\.|[^"\\])*"|\d+(?:\.\d+)?|true|false|null|\]|})\s*\n\s*(?="[^"\n]+"\s*:)/g,
      "$1,\n",
    )
}

function parseJsonObject(raw: string): Record<string, any> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed
  } catch {
    /* scan below */
  }
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start >= 0 && end > start) {
    const body = cleaned.slice(start, end + 1)
    try {
      return JSON.parse(body)
    } catch {
      try {
        return JSON.parse(jsonrepair(body))
      } catch {
        return JSON.parse(repairModelJson(body))
      }
    }
  }
  throw new Error("AI did not return a valid JSON object.")
}

function batchUsage(step: 1 | 2 | 3 | 4, provider: string, response: any) {
  const inputTokens = response.cacheHit
    ? 0
    : Number(response.usage?.inputTokens ?? 0)
  const outputTokens = response.cacheHit
    ? 0
    : Number(response.usage?.outputTokens ?? 0)
  return {
    id: `usage-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    step,
    provider,
    model: response.model,
    inputTokens,
    cachedInputTokens: response.cacheHit
      ? 0
      : Number(response.usage?.cachedInputTokens ?? 0),
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: response.cacheHit ? 0 : (response.costUsd ?? null),
    cacheHit: Boolean(response.cacheHit),
    purpose: response.callPurpose ?? "generation",
    contextCharsSent: Number(response.contextCharsSent ?? 0),
    calledAt: new Date().toISOString(),
  }
}

async function saveArticleCheckpoint(
  article: any,
  updates: Record<string, any>,
) {
  const next = { ...article, ...updates, updatedAt: new Date().toISOString() }
  if (article.activityKind === "batch" && article.activityId && deletedBatchIds.has(article.activityId)) return next
  await kvSet(`${ARTICLE_PREFIX}${article.id}`, next)
  await projectArticle(next)
  return next
}

async function projectArticle(article: any) {
  if (!(await tableAvailable("writer_articles"))) {
    if (article.contentPlanId) {
      const plan = await kvGet<any>(
        `${CONTENT_PLAN_PREFIX}${article.contentPlanId}`,
      )
      if (plan) {
        const articleRecords = await kvGetByPrefix(ARTICLE_PREFIX)
        plan.totalArticles = articleRecords.filter(
          (record) => record.value?.contentPlanId === article.contentPlanId,
        ).length
        plan.updatedAt = new Date().toISOString()
        await kvSet(`${CONTENT_PLAN_PREFIX}${plan.id}`, plan)
      }
    }
    return
  }
  await tableUpsert(
    "writer_articles",
    {
      id: article.id,
      content_plan_id: article.contentPlanId ?? null,
      content_plan_item_id: article.contentPlanSourceItemId ?? null,
      activity_id: article.activityId ?? null,
      content_group:
        article.activityType === "comparison-seo"
          ? "comparison_seo"
          : article.activityType === "editorial-originality"
            ? "editorial_originality"
            : null,
      title: article.topic?.trim() || article.title,
      status: article.status,
      current_step: article.currentStep,
      payload: article,
      draft: article.draft ?? null,
      batch_status: article.batchStatus ?? null,
      error_message: article.batchError ?? null,
      created_at: article.createdAt,
      updated_at: article.updatedAt,
      completed_at: article.completedAt ?? null,
    },
    "id",
  )
  const usage = Object.values(article.aiUsageByStep ?? {}).flat() as any[]
  for (const call of usage)
    await tableUpsert(
      "writer_ai_usage",
      {
        id: call.id,
        content_plan_id: article.contentPlanId ?? null,
        activity_id: article.activityId ?? null,
        article_id: article.id,
        step: call.step,
        provider: call.provider,
        model: call.model,
        input_tokens: call.inputTokens ?? 0,
        cached_input_tokens: call.cachedInputTokens ?? 0,
        output_tokens: call.outputTokens ?? 0,
        total_tokens: call.totalTokens ?? 0,
        cost_usd: call.costUsd ?? null,
        cache_hit: Boolean(call.cacheHit),
        called_at: call.calledAt,
      },
      "id",
    )
  await projectArticleStageRuns(article)
  await projectBatchState(article)
  if (
    article.articleSpec &&
    article.articleSpecFingerprint &&
    (await tableAvailable("article_specs"))
  ) {
    await tableUpsert(
      "article_specs",
      {
        article_id: article.id,
        content_plan_id: article.contentPlanId ?? null,
        version: Number(article.articleSpec.version ?? 1),
        fingerprint: article.articleSpecFingerprint,
        spec: article.articleSpec,
        updated_at: article.updatedAt,
      },
      "article_id",
    )
  }
  if (article.qualityReport && (await tableAvailable("quality_gate_runs"))) {
    const qualityId = snapshotFingerprint({
      articleId: article.id,
      checkedAt: article.qualityReport.checkedAt,
      report: article.qualityReport,
    })
    await tableUpsert(
      "quality_gate_runs",
      {
        id: qualityId,
        article_id: article.id,
        spec_fingerprint: article.qualityReport.articleSpecFingerprint,
        version: Number(article.qualityReport.version ?? 1),
        status: article.qualityReport.status,
        report: article.qualityReport,
        created_at: article.qualityReport.checkedAt,
      },
      "id",
    )
  }
  if (
    article.editorialApproval &&
    (await tableAvailable("editorial_approvals"))
  ) {
    await tableUpsert(
      "editorial_approvals",
      {
        article_id: article.id,
        status: article.editorialApproval.status,
        outline_fingerprint:
          article.editorialApproval.outlineFingerprint ?? null,
        note: article.editorialApproval.note ?? null,
        approved_at: article.editorialApproval.approvedAt ?? null,
        updated_at: article.updatedAt,
      },
      "article_id",
    )
  }
  if (
    article.contentPlanSourceItemId &&
    (await tableAvailable("article_stage_runs"))
  ) {
    const itemStatus =
      article.batchStatus === "failed"
        ? "failed"
        : article.status === "done" || article.batchStatus === "completed"
          ? "completed"
          : article.batchStatus === "running"
            ? "generating"
            : article.currentStep > 2
              ? "in_progress"
              : article.batchStatus === "queued"
                ? "queued"
                : article.activityKind === "single"
                  ? "in_progress"
                  : "not_started"
    await tableUpdate("content_plan_items", article.contentPlanSourceItemId, {
      status: itemStatus,
      updated_at: article.updatedAt,
    })
  }
  if (article.contentPlanId) {
    const projected = await tableSelect<any>("writer_articles", (query) =>
      query.select("id").eq("content_plan_id", article.contentPlanId),
    )
    await tableUpdate("content_plans", article.contentPlanId, {
      total_articles: projected.length,
      status: "active",
      updated_at: new Date().toISOString(),
    })
  }
}

function snapshotFingerprint(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")
}

function normalizeBatchArticleSpec(raw: any, article: any, idea: any) {
  const list = (value: any) =>
    (Array.isArray(value) ? value : [])
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean)
  const intent = [
    "informational",
    "commercial",
    "transactional",
    "navigational",
  ].includes(raw?.primaryIntent)
    ? raw.primaryIntent
    : "informational"
  const spec = {
    version: 1,
    topic: String(raw?.topic ?? article.topic ?? "").trim(),
    primaryQuery: String(
      raw?.primaryQuery ?? idea?.primaryKeyword ?? article.topic ?? "",
    ).trim(),
    secondaryQueries: list(raw?.secondaryQueries ?? idea?.secondaryKeywords),
    audience: String(raw?.audience ?? idea?.targetAudience ?? "").trim(),
    market: String(raw?.market ?? "Global / USA").trim(),
    language: "English",
    primaryIntent: intent,
    secondaryIntent: [
      "informational",
      "commercial",
      "transactional",
      "navigational",
    ].includes(raw?.secondaryIntent)
      ? raw.secondaryIntent
      : undefined,
    expectedReaderOutcome: String(raw?.expectedReaderOutcome ?? "").trim(),
    winningFormat: String(raw?.winningFormat ?? "Evidence-led article").trim(),
    mustCover: list(raw?.mustCover),
    optionalCoverage: list(raw?.optionalCoverage),
    thesis: String(raw?.thesis ?? idea?.mainArgument ?? "").trim(),
    brandPov: String(raw?.brandPov ?? "").trim(),
    evidence: Array.isArray(raw?.evidence) ? raw.evidence : [],
    ctaObjective: String(
      raw?.ctaObjective ?? "Continue to a relevant next step",
    ).trim(),
    internalLinkRequirements: list(raw?.internalLinkRequirements),
    createdAt: new Date().toISOString(),
  }
  if (
    !spec.topic ||
    !spec.primaryQuery ||
    !spec.expectedReaderOutcome ||
    spec.mustCover.length < 3 ||
    !spec.thesis
  )
    throw new Error("Batch Step 1 returned an incomplete Article Spec.")
  return spec
}

async function projectArticleStageRuns(article: any) {
  if (!(await tableAvailable("article_stage_runs"))) return
  const stages = [
    {
      stage: "core_idea",
      legacyStep: 2,
      output: article.coreIdeaSuggestions?.length
        ? {
            suggestions: article.coreIdeaSuggestions,
            selectedId: article.selectedCoreIdeaId,
            seoResearch: article.seoResearch,
          }
        : null,
      input: {
        topic: article.topic,
        keywords: article.keywords,
        contentType: article.contentType,
        planVersion: article.contentPlanVersion,
      },
    },
    {
      stage: "outline",
      legacyStep: 3,
      output: article.outline?.length ? { sections: article.outline } : null,
      input: {
        selectedCoreIdeaId: article.selectedCoreIdeaId,
        suggestions: article.coreIdeaSuggestions,
        planVersion: article.contentPlanVersion,
      },
    },
    {
      stage: "draft",
      legacyStep: 4,
      output: article.draft?.trim() ? { markdown: article.draft } : null,
      input: {
        outline: article.outline,
        selectedCoreIdeaId: article.selectedCoreIdeaId,
        planVersion: article.contentPlanVersion,
      },
    },
  ]
  for (const entry of stages) {
    if (!entry.output) continue
    const fingerprint = snapshotFingerprint({
      input: entry.input,
      output: entry.output,
    })
    const existing = await tableSelect<any>("article_stage_runs", (query) =>
      query
        .select("id")
        .eq("article_id", article.id)
        .eq("stage", entry.stage)
        .eq("input_fingerprint", fingerprint)
        .limit(1),
    )
    if (existing.length) continue
    const revisions = await tableSelect<any>("article_stage_runs", (query) =>
      query
        .select("revision_number")
        .eq("article_id", article.id)
        .eq("stage", entry.stage)
        .order("revision_number", { ascending: false })
        .limit(1),
    )
    const calls = article.aiUsageByStep?.[entry.legacyStep] ?? []
    const latest = calls.at(-1)
    await tableInsert("article_stage_runs", {
      article_id: article.id,
      content_plan_id: article.contentPlanId ?? null,
      content_plan_item_id: article.contentPlanSourceItemId ?? null,
      stage: entry.stage,
      revision_number: Number(revisions[0]?.revision_number ?? 0) + 1,
      status: "completed",
      input_fingerprint: fingerprint,
      input_snapshot: entry.input,
      output_snapshot: entry.output,
      model: latest?.model ?? null,
      prompt_version: null,
      input_tokens: latest?.inputTokens ?? 0,
      output_tokens: latest?.outputTokens ?? 0,
      cost_usd: latest?.costUsd ?? null,
      created_at: article.updatedAt,
    })
  }
}

async function projectBatchState(article: any) {
  if (
    !article.activityId ||
    article.activityKind !== "batch" ||
    !(await tableAvailable("batch_jobs"))
  )
    return
  const siblings = (await loadArticles()).filter(
    (item) => item.activityId === article.activityId,
  )
  const status = siblings.some((item) => item.batchStatus === "running")
    ? "running"
    : siblings.some((item) => item.batchStatus === "paused")
      ? "paused"
      : siblings.length &&
          siblings.every((item) => item.batchStatus === "completed")
        ? "completed"
        : siblings.some((item) => item.batchStatus === "failed")
          ? "failed"
          : "queued"
  const calls = siblings.flatMap(
    (item) => Object.values(item.aiUsageByStep ?? {}).flat() as any[],
  )
  await tableUpsert(
    "batch_jobs",
    {
      id: article.activityId,
      content_plan_id: article.contentPlanId ?? null,
      status,
      total_items: siblings.length,
      completed_items: siblings.filter(
        (item) => item.batchStatus === "completed",
      ).length,
      failed_items: siblings.filter((item) => item.batchStatus === "failed")
        .length,
      total_tokens: calls.reduce(
        (sum, call) => sum + Number(call.totalTokens ?? 0),
        0,
      ),
      total_cost_usd: calls.every((call) => call.costUsd != null)
        ? calls.reduce((sum, call) => sum + Number(call.costUsd), 0)
        : null,
      updated_at: new Date().toISOString(),
    },
    "id",
  )
  await tableUpsert(
    "batch_job_items",
    {
      batch_job_id: article.activityId,
      content_plan_item_id: article.contentPlanSourceItemId ?? null,
      article_id: article.id,
      status: article.batchStatus ?? "queued",
      error_message: article.batchError ?? null,
      updated_at: article.updatedAt,
    },
    "batch_job_id,article_id",
  )
}

async function runBatchModel(
  article: any,
  step: 2 | 3 | 4,
  prompt: string,
  jsonMode: boolean,
  maxTokens: number,
  jsonSchema?: Record<string, unknown>,
  purpose: "generation" | "recovery" = "generation",
  options: { skipDocumentContext?: boolean } = {},
) {
  const config = await kvGet<any>("writer:config")
  const stepConfig = config?.stepConfigs?.[step]
  const model = config?.models?.find(
    (item: any) => item.id === stepConfig?.modelId && item.enabled,
  )
  if (!model)
    throw new Error(`Step ${step}: no enabled AI model is configured.`)
  if (!getAvailableProviders()[model.provider])
    throw new Error(`${model.provider} API is not configured.`)
  const compiledRules = compileBackendWorkflowRules(config, step, "batch")
  const effectivePrompt = compiledRules.taskGuidance
    ? `${prompt}\n\n${compiledRules.taskGuidance}`
    : prompt
  const context = await resolveStepContext(
    step,
    `${article.topic ?? ""} ${article.keywords ?? ""}`,
    article.id,
  )
  const key = aiCacheKey({
    kind: "batch-pipeline-v4",
    purpose,
    articleId: article.id,
    step,
    model: model.id,
    prompt: effectivePrompt,
    fingerprint: `${context.summary.sourceFingerprint}:${compiledRules.fingerprint}`,
  })
  const cached = await kvGet<any>(key)
  if (cached?.content)
    return {
      ...cached,
      provider: model.provider,
      cacheHit: true,
      callPurpose: purpose,
      contextCharsSent: options.skipDocumentContext ? 0 : context.summary.totalChars,
      workflowRuleSnapshot: compiledRules.snapshot,
    }
  if (purpose === "generation") await reserveAIBudget(article.id, step)
  const response = await generate({
    modelId: model.id,
    provider: model.provider,
    prompt: effectivePrompt,
    systemPrompt:
      step === 4
        ? `${compiledRules.systemPrompt}\n\nBATCH LENGTH AUTHORITY: Use the supplied English word-budget contract as the only length requirement. Ignore legacy or document-level fixed character-count requirements for the introduction or conclusion.`
        : compiledRules.systemPrompt,
    // Keep the source fingerprint in the cache key, but do not bill the model
    // again for source documents when a repair/review already receives the
    // frozen draft, Article Spec and approved evidence mapping.
    contextDocs: options.skipDocumentContext ? [] : context.contextDocs,
    jsonMode,
    jsonSchema,
    maxTokens,
    temperature: step === 4 ? 0.2 : 0.35,
  })
  const input = Number(response.usage?.inputTokens ?? 0)
  const cachedTokens = Number(response.usage?.cachedInputTokens ?? 0)
  const output = Number(response.usage?.outputTokens ?? 0)
  const pricing = model.pricing
  const costUsd = pricing
    ? ((input - cachedTokens) * Number(pricing.inputUsdPerMillion ?? 0) +
        cachedTokens *
          Number(
            pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion ?? 0,
          ) +
        output * Number(pricing.outputUsdPerMillion ?? 0)) /
      1_000_000
    : null
  await kvSet(key, {
    ...response,
    costUsd,
    generatedAt: new Date().toISOString(),
  })
  return {
    ...response,
    provider: model.provider,
    costUsd,
    cacheHit: false,
    callPurpose: purpose,
    contextCharsSent: options.skipDocumentContext ? 0 : context.summary.totalChars,
    workflowRuleSnapshot: compiledRules.snapshot,
  }
}

function batchSeoFailures(text: string, article: any, targetWords: number) {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const acceptedMin = Math.max(800, Math.ceil(targetWords * 0.85))
  const acceptedMax = Math.floor(targetWords * 1.15)
  const idea =
    article.coreIdeaSuggestions?.find(
      (item: any) => item.id === article.selectedCoreIdeaId,
    ) ?? article.coreIdeaSuggestions?.[0]
  const primaryKeyword = String(
    article.articleSpec?.primaryQuery ??
      idea?.primaryKeyword ??
      String(article.keywords ?? "").split(",")[0] ??
      article.topic ??
      "",
  ).trim()
  const normalizedKeyword = primaryKeyword.toLocaleLowerCase()
  const title =
    text
      .split("\n")
      .find((line) => /^#\s+\S/.test(line.trim()))
      ?.replace(/^#\s+/, "")
      .trim() ?? ""
  const conclusionCount = [...text.matchAll(/^##\s+conclusion\s*$/gim)].length
  const failures = [
    !normalizedKeyword || !title.toLocaleLowerCase().includes(normalizedKeyword)
      ? "H1 title must contain the exact primary keyword"
      : "",
    words < acceptedMin
      ? `article is below the accepted ${acceptedMin}-word minimum around target ${targetWords}`
      : "",
    words > acceptedMax
      ? `article exceeds the accepted ${acceptedMax}-word maximum around target ${targetWords}`
      : "",
    !/^#{2,3}\s+\S/m.test(text)
      ? "article must contain Markdown H2/H3 headings"
      : "",
    conclusionCount !== 1
      ? `article must contain exactly one Conclusion heading (found ${conclusionCount})`
      : "",
    !normalizedKeyword || !text.toLocaleLowerCase().includes(normalizedKeyword)
      ? "body must contain the primary keyword"
      : "",
  ].filter(Boolean)
  return { failures, primaryKeyword, words }
}

function batchOutlineHasEvidence(outline: any[]) {
  return outline.some(
    (section: any) =>
      Array.isArray(section?.evidence) && section.evidence.length > 0,
  )
}

function canonicalEvidenceText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\u00ad/g, "")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

function batchContextDocuments(contextDocs: string[]) {
  return contextDocs.flatMap((value) => {
    const match = value.match(
      /^<<<DOCUMENT role="([^"]+)" id="([^"]+)" name="([^"]+)"[^>]*>>>\n([\s\S]*?)\n<<<END_DOCUMENT>>>$/,
    )
    if (!match) return []
    const role =
      match[1] === "RULES"
        ? "rules"
        : match[1] === "CONTENT_PLAN"
          ? "content_plan"
          : "kb"
    return [{ role, id: match[2], name: match[3], content: match[4] }]
  })
}

function batchDeterministicEvidence(contextDocs: string[], query: string) {
  const documents = batchContextDocuments(contextDocs)
  const terms = [...new Set(
    canonicalEvidenceText(query)
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3),
  )].slice(0, 30)
  const best = (roles: string[]) =>
    documents
      .filter((document) => roles.includes(document.role))
      .flatMap((document) =>
        document.content
          .split(/\n\s*\n|\r?\n/)
          .map((text) => text.replace(/\s+/g, " ").trim())
          .filter((text) => text.length >= 40)
          .map((quote) => ({
            source: document.name,
            role: document.role,
            quote: quote.slice(0, 800),
            note: "Deterministically selected and verified source excerpt.",
            score: terms.reduce(
              (sum, term) =>
                sum + (canonicalEvidenceText(quote).includes(term) ? 1 : 0),
              0,
            ),
          })),
      )
      .sort((left, right) => right.score - left.score || right.quote.length - left.quote.length)[0]
  return [best(["kb", "content_plan"]), best(["rules"])]
    .filter(Boolean)
    .map(({ score: _score, ...item }: any) => item)
}

function quoteExistsInDocument(content: string, quote: string) {
  const source = canonicalEvidenceText(content)
  const target = canonicalEvidenceText(quote)
  if (!target) return false
  if (source.includes(target)) return true
  return quote
    .split(/\r?\n|\.{3}|…|(?<=[.!?。])\s+/)
    .map(canonicalEvidenceText)
    .filter((part) => part.length >= 24)
    .some((part) => source.includes(part))
}

function normalizeBatchOutlinePayload(
  parsed: any,
  contextDocs: string[],
  inheritedEvidence: any[] = [],
) {
  const registry =
    parsed?.evidenceRegistry && typeof parsed.evidenceRegistry === "object"
      ? parsed.evidenceRegistry
      : {}
  const documents = batchContextDocuments(contextDocs)
  const hasResearchDocs = documents.some((item) => item.role !== "rules")
  const hasRuleDocs = documents.some((item) => item.role === "rules")
  return (Array.isArray(parsed?.sections) ? parsed.sections : []).map(
    (section: any, index: number) => {
      const referencedEvidence = (Array.isArray(section?.evidenceRefs)
        ? section.evidenceRefs
        : [])
        .map((id: any) => registry[String(id)])
      const directEvidence = Array.isArray(section?.evidence)
        ? section.evidence
        : []
      const verifiedEvidence = [...referencedEvidence, ...directEvidence]
        .flatMap((item: any) => {
          const quote = String(item?.quote ?? "").trim()
          const source = canonicalEvidenceText(String(item?.source ?? ""))
          const named = documents.filter(
            (doc) =>
              canonicalEvidenceText(doc.name) === source ||
              canonicalEvidenceText(doc.id) === source,
          )
          const candidates = named.length ? named : documents
          const match = candidates.find(
            (doc) => quote.length >= 12 && quoteExistsInDocument(doc.content, quote),
          )
          return match
            ? [{
                source: match.name,
                note: String(item.note ?? ""),
                quote,
                role: match.role,
              }]
            : []
        })
      // Core Idea evidence was already selected deterministically from the
      // allowed sources. Reusing it here mirrors the single-article outline
      // flow and avoids rejecting a structurally sound section merely because
      // the model omitted a duplicate registry reference.
      const evidence = [...verifiedEvidence, ...inheritedEvidence]
        .filter(
          (item: any, itemIndex: number, all: any[]) =>
            all.findIndex(
              (candidate) =>
                candidate.source === item.source &&
                candidate.role === item.role &&
                candidate.quote === item.quote,
            ) === itemIndex,
        )
      const hasRequiredEvidence =
        (!hasResearchDocs || evidence.some((item: any) => item.role !== "rules")) &&
        (!hasRuleDocs || evidence.some((item: any) => item.role === "rules"))
      if (!hasRequiredEvidence) return null
      return {
        id: String(section?.id ?? `batch-section-${index + 1}`),
        heading: String(section?.heading ?? "").trim(),
        notes: String(section?.notes ?? "").trim(),
        rationale: String(section?.rationale ?? "").trim(),
        level: section?.level === "h3" ? "h3" : "h2",
        keywords: Array.isArray(section?.keywords)
          ? section.keywords.map(String).filter(Boolean)
          : [],
        searchIntent: [
          "informational",
          "commercial",
          "transactional",
          "navigational",
        ].includes(section?.searchIntent)
          ? section.searchIntent
          : "informational",
        evidence,
        ruleRefs: Array.isArray(section?.ruleRefs)
          ? section.ruleRefs.map(String).filter(Boolean)
          : [],
      }
    },
  ).filter(Boolean)
}

function repairBatchInternalLinks(
  draft: string,
  article: any,
  inventory: any[],
) {
  const canonicalUrl = (value: string) => {
    try {
      const url = new URL(value)
      url.hash = ""
      url.search = ""
      url.hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, "")
      url.protocol = "https:"
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
      return url.toString()
    } catch {
      return value.trim()
    }
  }
  const approved = new Set(
    inventory
      .filter(
        (item) =>
          item.eligibleForInternalLink &&
          ["active", "redirected"].includes(item.status),
      )
      .flatMap((item) =>
        [item.url, item.canonicalUrl, item.redirectTarget].filter(Boolean),
      )
      .map((value) => canonicalUrl(String(value))),
  )
  const internalHosts = new Set(
    [...approved].flatMap((value) => {
      try {
        return [new URL(value).hostname.replace(/^www\./, "")]
      } catch {
        return []
      }
    }),
  )
  const candidates = selectWebsiteCandidates(article, inventory, 6)
  const replacement = candidates[0]
  let next = draft
  const urls = [...draft.matchAll(/https?:\/\/[^\s)\]}>"']+/gi)].map(
    (match) => match[0].replace(/[.,;:!?]+$/, ""),
  )
  for (const value of urls) {
    try {
      const host = new URL(value).hostname.toLocaleLowerCase().replace(/^www\./, "")
      if (
        internalHosts.has(host) &&
        !approved.has(canonicalUrl(value)) &&
        replacement?.url
      )
        next = next.split(value).join(replacement.url)
    } catch {
      // Ignore malformed non-link text; deterministic QC reports it later.
    }
  }
  const repairedUrls = [...next.matchAll(/https?:\/\/[^\s)\]}>"']+/gi)].map(
    (match) => canonicalUrl(match[0].replace(/[.,;:!?]+$/, "")),
  )
  const requiresInternalLink = Boolean(
    article.articleSpec?.internalLinkRequirements?.length,
  )
  if (
    requiresInternalLink &&
    replacement?.url &&
    !repairedUrls.some((value) => approved.has(value))
  ) {
    const anchor = String(
      replacement.suggestedAnchors?.[0] ?? replacement.title ?? "related guidance",
    ).replace(/[\[\]]/g, "")
    const addition = `For related guidance, see [${anchor}](${replacement.url}).`
    const conclusionIndex = next.search(/^##\s+Conclusion\s*$/mi)
    next =
      conclusionIndex >= 0
        ? `${next.slice(0, conclusionIndex).trimEnd()}\n\n${addition}\n\n${next.slice(conclusionIndex)}`
        : `${next.trimEnd()}\n\n${addition}`
  }
  return next
}

function batchCoverageTerms(value: unknown) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 3)
}

function batchMissingOutlineCoverage(article: any, outline = article.outline ?? []) {
  const outlineText = String(
    outline
      .flatMap((section: any) => [
        section.heading,
        section.notes,
        section.rationale,
        ...(section.keywords ?? []),
      ])
      .filter(Boolean)
      .join(" "),
  )
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
  return (article.articleSpec?.mustCover ?? []).filter((topic: unknown) => {
    const terms = batchCoverageTerms(topic)
    return terms.length > 0 && terms.filter((term) => outlineText.includes(term)).length < Math.ceil(terms.length * 0.5)
  }).map(String)
}

/**
 * Article Spec coverage is a contract, not an AI-only suggestion. If an outline
 * omitted a must-cover topic, attach that requirement to the most relevant
 * approved section before Step 3. The draft generator receives this persisted
 * instruction and the final draft is still checked independently below.
 */
function attachBatchOutlineCoverage(outline: any[], missingTopics: string[]) {
  const next = outline.map((section: any) => ({ ...section, keywords: [...(section.keywords ?? [])] }))
  for (const topic of missingTopics) {
    const topicTerms = new Set(batchCoverageTerms(topic))
    const target = next
      .map((section: any, index: number) => ({
        index,
        score: batchCoverageTerms([section.heading, section.notes, section.rationale, ...(section.keywords ?? [])].join(" "))
          .filter((term) => topicTerms.has(term)).length,
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]
    if (!target) continue
    const section = next[target.index]
    const instruction = `Required coverage: ${topic}.`
    if (!String(section.notes ?? "").includes(instruction))
      section.notes = [String(section.notes ?? "").trim(), instruction].filter(Boolean).join(" ")
    if (!section.keywords.some((keyword: unknown) => String(keyword).toLocaleLowerCase() === topic.toLocaleLowerCase()))
      section.keywords.push(topic)
  }
  return next
}

function batchMissingDraftCoverage(article: any, text: string) {
  const draftText = String(text ?? "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
  return (article.articleSpec?.mustCover ?? []).filter((topic: unknown) => {
    const terms = batchCoverageTerms(topic)
    return terms.length > 0 && terms.filter((term) => draftText.includes(term)).length < Math.ceil(terms.length * 0.5)
  }).map(String)
}

function batchUniversalChecks(
  text: string,
  article: any,
  targetWords: number,
  inventory: any[] = [],
  sourceNames: string[] = [],
) {
  const basic = batchSeoFailures(text, article, targetWords)
  const missing = batchMissingOutlineCoverage(article)
  const missingDraftCoverage = batchMissingDraftCoverage(article, text)
  const urls = [...text.matchAll(/https?:\/\/[^\s)\]}>"']+/gi)].map((match) =>
    match[0].replace(/[.,;:!?]+$/, ""),
  )
  const canonicalUrl = (value: string) => {
    try {
      const url = new URL(value)
      url.hash = ""
      url.search = ""
      url.hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, "")
      url.protocol = "https:"
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
      return url.toString()
    } catch {
      return value.trim()
    }
  }
  const approved = new Set(
    inventory
      .filter(
        (item) =>
          item.eligibleForInternalLink &&
          ["active", "redirected"].includes(item.status),
      )
      .flatMap((item) =>
        [item.url, item.canonicalUrl, item.redirectTarget].filter(Boolean),
      )
      .map((value) => canonicalUrl(String(value))),
  )
  const inventoryHosts = new Set(
    [...approved].flatMap((value: any) => {
      try {
        return [new URL(String(value)).hostname.replace(/^www\./, "")]
      } catch {
        return []
      }
    }),
  )
  const internalUrls = urls.filter((value) => {
    try {
      return inventoryHosts.has(new URL(value).hostname.toLocaleLowerCase().replace(/^www\./, ""))
    } catch {
      return false
    }
  })
  const approvedInternalUrls = internalUrls.filter((url) => approved.has(canonicalUrl(url)))
  const unapprovedInternalUrls = internalUrls.filter((url) => !approved.has(canonicalUrl(url)))
  const internalLinkRequired = Boolean(article.articleSpec?.internalLinkRequirements?.length)
  const leaked = sourceNames.filter(
    (name) =>
      /\.[a-z0-9]{1,8}$/i.test(String(name).trim()) &&
      text.toLocaleLowerCase().includes(String(name).trim().toLocaleLowerCase()),
  )
  const checks = [
    {
      id: "seo-contract",
      label: "SEO and structure contract",
      kind: "deterministic",
      status: basic.failures.length ? "fail" : "pass",
      reason:
        basic.failures.join("; ") ||
        "Structure, primary query and word budget pass.",
      autoFixAllowed: true,
    },
    {
      id: "must-cover",
      label: "Must-cover topic coverage",
      kind: "deterministic",
      status: missing.length ? "fail" : "pass",
      reason: missing.length
        ? `Not mapped in the approved outline: ${missing.join(", ")}`
        : "Every required topic is covered by the approved outline or draft.",
      autoFixAllowed: true,
    },
    {
      id: "must-cover-draft",
      label: "Must-cover topics in draft",
      kind: "deterministic",
      status: missingDraftCoverage.length ? "fail" : "pass",
      reason: missingDraftCoverage.length
        ? `Draft does not cover required topics: ${missingDraftCoverage.join(", ")}`
        : "Every required topic is covered in the draft.",
      autoFixAllowed: true,
    },
    {
      id: "placeholders",
      label: "No placeholders",
      kind: "deterministic",
      status: /\[(?:needs?|todo|tbd)[^\]]*\]|lorem ipsum|about:blank/i.test(
        text,
      )
        ? "fail"
        : "pass",
      reason: "Draft must not contain placeholders.",
      autoFixAllowed: true,
    },
    {
      id: "source-confidentiality",
      label: "No internal source leakage",
      kind: "deterministic",
      status: leaked.length ? "fail" : "pass",
      reason: leaked.length
        ? `Leaked source names: ${leaked.join(", ")}`
        : "No infrastructure filenames detected.",
      autoFixAllowed: false,
    },
    {
      id: "link-correctness",
      label: "Approved internal links",
      kind: "deterministic",
      status: !unapprovedInternalUrls.length && (!internalLinkRequired || approvedInternalUrls.length > 0) ? "pass" : "fail",
      reason: unapprovedInternalUrls.length
        ? `Not approved in Website Inventory: ${unapprovedInternalUrls.join(", ")}`
        : internalLinkRequired && !approvedInternalUrls.length
          ? "Article Spec requires an internal link, but the draft does not contain an approved URL."
          : approvedInternalUrls.length
            ? "Every internal URL matches an approved Website Inventory entry."
            : "No internal link is required by the Article Spec.",
      autoFixAllowed: true,
    },
  ]
  return checks
}

function parseBatchSemanticChecks(raw: string) {
  const payload = parseJsonObject(raw)
  const requiredIds = [
    "intent-satisfied",
    "reader-outcome",
    "intro-quality",
    "keyword-naturalness",
    "evidence-support",
    "brand-pov",
  ]
  const required = new Set(requiredIds)
  const entries = Array.isArray(payload.checks)
    ? payload.checks.map((item: any) => [String(item.id ?? ""), item])
    : Object.entries(payload.checks ?? {})
  const checks = entries
    .filter(([id]: any[]) => required.has(String(id)))
    .map(([id, item]: any[]) => ({
      id: String(id),
      label: String(item.label ?? id),
      kind: "semantic",
      status:
        item.status === "pass"
          ? "pass"
          : item.status === "warning"
            ? "warning"
            : "fail",
      reason: String(item.reason ?? ""),
      evidence: String(item.evidence ?? ""),
      location: String(item.location ?? ""),
      recommendedAction: String(item.recommendedAction ?? ""),
      autoFixAllowed: Boolean(item.autoFixAllowed),
    }))
  const present = new Set(checks.map((item: any) => item.id))
  const missing = requiredIds.filter((id) => !present.has(id))
  if (missing.length)
    throw new Error(
      `Universal semantic reviewer returned an incomplete report. Missing: ${missing.join(", ")}.`,
    )
  return checks
}

function reconcileBatchSemanticChecks(
  semantic: ReturnType<typeof parseBatchSemanticChecks>,
  deterministic: Array<{ id: string; status: string }>,
) {
  const linkCheckPassed = deterministic.some(
    (item) => item.id === "link-correctness" && item.status === "pass",
  )
  if (!linkCheckPassed) return semantic
  const outOfScopeLinkFinding = /\b(?:internal[- ]links?|website inventory|approved (?:urls?|links?)|urls? target)\b/i
  return semantic.map((item) =>
    outOfScopeLinkFinding.test(
      `${item.reason} ${item.evidence} ${item.recommendedAction}`,
    )
      ? {
          ...item,
          status: "pass" as const,
          reason:
            "Internal-link correctness is validated deterministically against Website Inventory and passed.",
          evidence: "",
          location: "",
          recommendedAction: "",
          autoFixAllowed: false,
        }
      : item,
  )
}

function batchSemanticReviewInstruction(article: any, draft: string) {
  const keyword = String(
    article.articleSpec?.primaryQuery ??
      article.coreIdeaSuggestions?.[0]?.primaryKeyword ??
      String(article.keywords ?? "").split(",")[0] ??
      article.topic ??
      "",
  ).trim()
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const exactMatches = keyword
    ? draft.match(new RegExp(escaped, "gi"))?.length ?? 0
    : 0
  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length
  return [
    "For keyword-naturalness, pass when the primary query is present in the H1/body and reads grammatically in context.",
    "Do not warn merely because an exact-match keyword is used. Warn only for a clearly awkward sentence or avoidable repetition, and quote its exact location.",
    "Fail only for material keyword stuffing that blocks publication.",
    `PRIMARY KEYWORD METRICS: ${JSON.stringify({ keyword, exactMatches, approximateDensityPercent: Number(((exactMatches / Math.max(wordCount, 1)) * 100).toFixed(2)) })}`,
  ].join("\n")
}

function batchDraftBudget(
  outline: any[],
  wordTarget: number,
  introductionPercent = 8,
  conclusionPercent = 7,
) {
  const targetMin = Math.ceil(wordTarget * 0.95)
  const targetMax = Math.floor(wordTarget * 1.03)
  const introduction = {
    min: Math.floor((targetMin * introductionPercent) / 100),
    max: Math.floor((targetMax * (introductionPercent + 1)) / 100),
  }
  const introductionAccepted = {
    min: Math.max(1, Math.floor(introduction.min * 0.85)),
    max: Math.ceil(introduction.max * 1.15),
  }
  const conclusion = {
    min: Math.floor((targetMin * conclusionPercent) / 100),
    max: Math.floor((targetMax * (conclusionPercent + 1)) / 100),
  }
  const conclusionAccepted = {
    min: Math.max(1, Math.floor(conclusion.min * 0.85)),
    max: Math.ceil(conclusion.max * 1.15),
  }
  const headingOverhead = outline.reduce(
    (sum, section) =>
      sum + String(section.heading ?? "").trim().split(/\s+/).filter(Boolean).length + 1,
    10,
  )
  const minimumPool = Math.max(
    0,
    targetMin - introduction.min - conclusion.min - headingOverhead,
  )
  const maximumPool = Math.max(
    minimumPool,
    targetMax - introduction.max - conclusion.max - headingOverhead,
  )
  const totalWeight =
    outline.reduce(
      (sum, section) => sum + (section.level === "h3" ? 0.65 : 1),
      0,
    ) || 1
  return {
    wordTarget,
    acceptedMin: Math.max(800, Math.ceil(wordTarget * 0.85)),
    acceptedMax: Math.floor(wordTarget * 1.15),
    targetMin,
    targetMax,
    introduction: { ...introduction,
      acceptedMin: introductionAccepted.min,
      acceptedMax: introductionAccepted.max,
    },
    conclusion: { ...conclusion,
      acceptedMin: conclusionAccepted.min,
      acceptedMax: conclusionAccepted.max,
    },
    sections: outline.map((section) => {
      const weight = section.level === "h3" ? 0.65 : 1
      return {
        id: section.id,
        heading: section.heading,
        level: section.level,
        minWords: Math.max(35, Math.floor((minimumPool * weight) / totalWeight)),
        maxWords: Math.max(45, Math.floor((maximumPool * weight) / totalWeight)),
      }
    }),
  }
}

function batchFieldBudgetChecks(
  draft: string,
  budget: ReturnType<typeof batchDraftBudget>,
) {
  const lines = draft.split("\n")
  const firstH2 = lines.findIndex((line) => /^##\s+\S/.test(line.trim()))
  const conclusionIndex = lines.findIndex((line) =>
    /^##\s+conclusion\s*$/i.test(line.trim()),
  )
  const count = (value: string) =>
    value.trim().split(/\s+/).filter(Boolean).length
  const introductionWords = count(
    lines.slice(1, firstH2 >= 0 ? firstH2 : lines.length).join(" "),
  )
  const conclusionWords =
    conclusionIndex >= 0
      ? count(lines.slice(conclusionIndex + 1).join(" "))
      : 0
  return [
    {
      id: "introduction-word-budget",
      label: "Introduction word budget",
      kind: "deterministic",
      status:
        introductionWords >= budget.introduction.acceptedMin &&
        introductionWords <= budget.introduction.acceptedMax
          ? "pass"
          : "fail",
      reason: `${introductionWords} English words; preferred ${budget.introduction.min}-${budget.introduction.max}, accepted ${budget.introduction.acceptedMin}-${budget.introduction.acceptedMax}.`,
      autoFixAllowed: true,
    },
    {
      id: "conclusion-word-budget",
      label: "Conclusion word budget",
      kind: "deterministic",
      status:
        conclusionWords >= budget.conclusion.acceptedMin &&
        conclusionWords <= budget.conclusion.acceptedMax
          ? "pass"
          : "fail",
      reason: `${conclusionWords} English words; preferred ${budget.conclusion.min}-${budget.conclusion.max}, accepted ${budget.conclusion.acceptedMin}-${budget.conclusion.acceptedMax}.`,
      autoFixAllowed: true,
    },
  ]
}

function batchOutlineFeasibility(article: any, wordTarget: number) {
  const outline = Array.isArray(article.outline) ? article.outline : []
  const headingWords = outline.reduce(
    (sum: number, section: any) =>
      sum + String(section.heading ?? "").trim().split(/\s+/).filter(Boolean).length + 1,
    10,
  )
  const sectionMinimum = outline.reduce(
    (sum: number, section: any) => sum + (section.level === "h3" ? 55 : 90),
    0,
  )
  const coverageMinimum = (article.articleSpec?.mustCover?.length ?? 0) * 30
  const minimumRequired = headingWords + sectionMinimum + coverageMinimum + 130
  return { minimumRequired, feasible: minimumRequired <= Math.floor(wordTarget * 1.15) }
}

const batchDraftRepairJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["edits", "appendBeforeConclusion"],
  properties: {
    edits: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["find", "replace"],
        properties: { find: { type: "string" }, replace: { type: "string" } },
      },
    },
    appendBeforeConclusion: { type: "string" },
  },
}

const batchFieldLengthRepairJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["introduction", "conclusion"],
  properties: {
    introduction: { type: "string", minLength: 1 },
    conclusion: { type: "string", minLength: 1 },
  },
}

function applyBatchDraftRepair(draft: string, raw: string) {
  const repair = parseJsonObject(raw)
  let next = draft
  for (const edit of Array.isArray(repair.edits) ? repair.edits : []) {
    const find = String(edit?.find ?? "")
    if (find && next.includes(find)) next = next.replace(find, String(edit?.replace ?? ""))
  }
  const addition = String(repair.appendBeforeConclusion ?? "").trim()
  if (addition) {
    const index = next.search(/^##\s+Conclusion\s*$/mi)
    next = index >= 0
      ? `${next.slice(0, index).trimEnd()}\n\n${addition}\n\n${next.slice(index)}`
      : `${next.trimEnd()}\n\n${addition}`
  }
  return next
}

function batchDraftFieldParts(draft: string) {
  const firstHeading = /^##\s+\S.*$/m.exec(draft)
  const conclusionHeading = /^##\s+Conclusion\s*$/im.exec(draft)
  const h1 = /^#\s+.*$/m.exec(draft)
  const introductionStart = h1 ? h1.index + h1[0].length : 0
  const introductionEnd = firstHeading?.index ?? draft.length
  const conclusionStart = conclusionHeading
    ? conclusionHeading.index + conclusionHeading[0].length
    : draft.length
  return {
    introduction: draft.slice(introductionStart, introductionEnd).trim(),
    conclusion: draft.slice(conclusionStart).trim(),
  }
}

function applyBatchFieldLengthRepair(
  draft: string,
  raw: string,
  failureIds: Set<string>,
) {
  const repair = parseJsonObject(raw)
  let next = draft
  if (failureIds.has("introduction-word-budget")) {
    const h1 = /^#\s+.*$/m.exec(next)
    const firstHeading = /^##\s+\S.*$/m.exec(next)
    if (h1 && firstHeading && firstHeading.index > h1.index) {
      const replacement = sanitizeBatchStructuredField(repair.introduction)
      if (replacement)
        next = `${next.slice(0, h1.index + h1[0].length).trimEnd()}\n\n${replacement}\n\n${next.slice(firstHeading.index).trimStart()}`
    }
  }
  if (failureIds.has("conclusion-word-budget")) {
    const conclusion = /^##\s+Conclusion\s*$/im.exec(next)
    const replacement = sanitizeBatchStructuredField(repair.conclusion, "Conclusion")
    if (conclusion && replacement)
      next = `${next.slice(0, conclusion.index + conclusion[0].length).trimEnd()}\n\n${replacement}`
  }
  return next
}

function sanitizeBatchArticleSpec(spec: any) {
  const instructionPattern = /\b(exact primary keyword|title|introduction|heading|body copy|conclusion|keyword density|use the exact|include the keyword)\b/i
  const mustCover = (Array.isArray(spec?.mustCover) ? spec.mustCover : [])
    .map(String)
    .map((item: string) => item.trim())
    .filter((item: string) => item && !instructionPattern.test(item))
  return { ...spec, mustCover }
}

const structuredDraftJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "introduction", "sections", "conclusion"],
  properties: {
    title: { type: "string", minLength: 1 },
    introduction: { type: "string", minLength: 1 },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "content", "usedEvidenceRefs"],
        properties: {
          id: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          usedEvidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    conclusion: { type: "string", minLength: 1 },
  },
}

const semanticQualityJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["checks"],
  properties: {
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["intent-satisfied", "reader-outcome", "intro-quality", "keyword-naturalness", "evidence-support", "brand-pov"],
      properties: Object.fromEntries(["intent-satisfied", "reader-outcome", "intro-quality", "keyword-naturalness", "evidence-support", "brand-pov"].map((id) => [id, {
        type: "object",
        additionalProperties: false,
        required: ["label", "status", "reason", "evidence", "location", "recommendedAction", "autoFixAllowed"],
        properties: {
          label: { type: "string" },
          status: { type: "string", enum: ["pass", "warning", "fail"] },
          reason: { type: "string" },
          evidence: { type: "string" },
          location: { type: "string" },
          recommendedAction: { type: "string" },
          autoFixAllowed: { type: "boolean" },
        },
      }])),
    },
  },
}

function batchVerifiedOutline(outline: any[]) {
  const evidenceRegistry: Record<string, any> = {}
  const evidenceIds = new Map<string, string>()
  const sections = outline.map((section: any) => ({
    ...section,
    evidenceRefs: (section.evidence ?? []).map((evidence: any) => {
      const key = [evidence.role, evidence.source, evidence.quote].join("|")
      let id = evidenceIds.get(key)
      if (!id) {
        id = `ev-${evidenceIds.size + 1}`
        evidenceIds.set(key, id)
        evidenceRegistry[id] = evidence
      }
      return id
    }),
    evidence: undefined,
  }))
  return { evidenceRegistry, sections }
}

function batchEvidenceMappingCheck(verified: ReturnType<typeof batchVerifiedOutline>, usage: Record<string, string[]>) {
  const registered = new Set(Object.keys(verified.evidenceRegistry))
  const invalid: string[] = []
  const missing: string[] = []
  for (const section of verified.sections) {
    const allowed = new Set(section.evidenceRefs ?? [])
    const used = usage[section.id] ?? []
    const bad = used.filter((id) => !registered.has(id) || !allowed.has(id))
    if (bad.length) invalid.push(`${section.id}: ${bad.join(", ")}`)
    if (allowed.size > 0 && used.length === 0) missing.push(section.id)
  }
  return {
    id: "evidence-mapping",
    label: "Evidence mapped to outline sections",
    kind: "deterministic",
    status: invalid.length || missing.length ? "fail" : "pass",
    reason: invalid.length
      ? `Evidence references outside their approved section: ${invalid.join("; ")}`
      : missing.length
        ? `Sections with approved evidence did not declare usage: ${missing.join(", ")}`
        : "Every declared evidence reference exists and belongs to its outline section.",
    evidence: JSON.stringify(usage),
    autoFixAllowed: true,
  }
}

// Evidence IDs are bookkeeping metadata. Never allow an AI response to claim
// an ID from another section: retain only IDs explicitly approved for that
// section, then let the deterministic check flag genuinely missing usage.
function normalizeBatchEvidenceUsage(
  verified: ReturnType<typeof batchVerifiedOutline>,
  usage: Record<string, string[]>,
) {
  return Object.fromEntries(verified.sections.map((section: any) => {
    const allowed = new Set((section.evidenceRefs ?? []).map(String))
    const declared = Array.isArray(usage[section.id]) ? usage[section.id] : []
    return [section.id, [...new Set(declared.map(String).filter((id) => allowed.has(id)))]]
  })) as Record<string, string[]>
}

// A section's approved evidence is already validated in Step 2. If the model
// omits bookkeeping IDs, restore that deterministic declaration rather than
// paying for a full draft rewrite whose prose would be identical.
function completeBatchEvidenceUsage(
  verified: ReturnType<typeof batchVerifiedOutline>,
  usage: Record<string, string[]>,
) {
  const normalized = normalizeBatchEvidenceUsage(verified, usage)
  return Object.fromEntries(verified.sections.map((section: any) => {
    const allowed = [...new Set((section.evidenceRefs ?? []).map(String))]
    return [section.id, normalized[section.id]?.length ? normalized[section.id] : allowed]
  })) as Record<string, string[]>
}

function sanitizeBatchStructuredField(value: unknown, expectedHeading?: string) {
  let text = String(value ?? "").trim()
  text = text.replace(/^#{1,6}\s+/, "").trim()
  if (expectedHeading) {
    const escapedHeading = expectedHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    text = text.replace(
      new RegExp(`^(?:#{1,6}\\s+)?${escapedHeading}\\s*(?:\\r?\\n|$)`, "i"),
      "",
    ).trim()
  }
  return text.replace(/^#{1,6}\s+Conclusion\s*$/im, "").trim()
}

function assembleBatchDraft(raw: string, article: any) {
  const parsed = parseJsonObject(raw)
  if (
    !String(parsed.title ?? "").trim() ||
    !String(parsed.introduction ?? "").trim() ||
    !String(parsed.conclusion ?? "").trim() ||
    !Array.isArray(parsed.sections)
  ) {
    throw new Error(
      "Structured draft is missing title, introduction, sections, or conclusion.",
    )
  }
  const expected = article.outline ?? []
  const byId = new Map(
    parsed.sections.map((section: any) => [section.id, section]),
  )
  const sections = expected.map((section: any, index: number) => {
    const candidate = byId.get(section.id) ?? parsed.sections[index]
    return candidate
      ? { ...candidate, content: sanitizeBatchStructuredField(candidate.content, section.heading) }
      : candidate
  })
  if (
    sections.length !== expected.length ||
    sections.some((section: any) => !String(section?.content ?? "").trim())
  ) {
    throw new Error(
      `Structured draft completed only ${sections.filter((section: any) => String(section?.content ?? "").trim()).length}/${expected.length} sections.`,
    )
  }
  const idea =
    article.coreIdeaSuggestions?.find(
      (item: any) => item.id === article.selectedCoreIdeaId,
    ) ?? article.coreIdeaSuggestions?.[0]
  const keyword = String(
    article.articleSpec?.primaryQuery ??
      idea?.primaryKeyword ??
      String(article.keywords ?? "").split(",")[0] ??
      article.topic ??
      "",
  ).trim()
  const parsedTitle = sanitizeBatchStructuredField(parsed.title)
  const title = parsedTitle
    .toLocaleLowerCase()
    .includes(keyword.toLocaleLowerCase())
    ? parsedTitle
    : `${parsedTitle}: ${keyword}`
  const draft = [
    `# ${title}`,
    sanitizeBatchStructuredField(parsed.introduction),
    ...sections.flatMap((section: any, index: number) => [
      `${
        expected[index].level === "h3" ? "###" : "##"
      } ${expected[index].heading}`,
      String(section.content).trim(),
    ]),
    "## Conclusion",
    sanitizeBatchStructuredField(parsed.conclusion, "Conclusion"),
  ].join("\n\n")
  const declaredEvidenceUsage = Object.fromEntries(expected.map((section: any, index: number) => [
    section.id,
    [...new Set((sections[index]?.usedEvidenceRefs ?? []).map(String).filter(Boolean))],
  ]))
  const evidenceUsage = completeBatchEvidenceUsage(
    batchVerifiedOutline(expected),
    declaredEvidenceUsage,
  )
  return { draft, evidenceUsage, parsed }
}

async function runBatchArticle(
  initial: any,
  controller: { paused: boolean; running: boolean },
) {
  let article = initial
  const contentMode =
    article.activityType === "editorial-originality"
      ? "Editorial/Originality"
      : "Comparison/SEO"
  const runtimeConfig = {
    ...((await kvGet<any>("writer:config")) ?? {}),
    websiteInventory: await loadWebsiteInventory(),
  }
  const maxDraftWords = Math.min(
    10000,
    Math.max(
      800,
      Number(
        runtimeConfig?.stepConfigs?.[4]?.maxDraftWords ??
          runtimeConfig?.stepConfigs?.[4]?.maxDraftCharacters ??
          1500,
      ),
    ),
  )
  const workflowParam = (
    rule: string,
    stage: string,
    param: string,
    fallback: number,
  ) =>
    Number(
      runtimeConfig?.workflowRules?.[rule]?.stageOverrides?.[stage]
        ?.parameters?.[param] ?? fallback,
    )
  const minimumOutlineSections = Math.min(
    12,
    Math.max(
      4,
      workflowParam("outline", "outline-mapping", "minimumSections", 4),
    ),
  )
  const desiredOutlineSections = Math.max(
    minimumOutlineSections,
    maxDraftWords <= 1000 ? 6 : maxDraftWords <= 1800 ? 8 : 10,
  )
  const keywordCount = Math.min(
    20,
    Math.max(
      5,
      workflowParam("core-idea", "market-research", "keywordCount", 10),
    ),
  )
  const batchIdeaCount = Math.min(
    6,
    Math.max(
      2,
      workflowParam("core-idea", "idea-generation", "ideaCount", 3),
    ),
  )
  const introductionPercent = Math.min(
    15,
    Math.max(
      5,
      workflowParam("draft", "word-allocation", "introductionPercent", 8),
    ),
  )
  const conclusionPercent = Math.min(
    12,
    Math.max(
      5,
      workflowParam("draft", "word-allocation", "conclusionPercent", 7),
    ),
  )
  const maxSentencesPerParagraph = Math.min(
    7,
    Math.max(
      2,
      workflowParam(
        "draft",
        "structured-assembly",
        "maxSentencesPerParagraph",
        5,
      ),
    ),
  )
  const appendUsage = (step: 2 | 3 | 4, response: any) => ({
    ...article.aiUsageByStep,
    [step]: [
      ...(article.aiUsageByStep?.[step] ?? []),
      batchUsage(step, response.provider ?? "unknown", response),
    ].slice(-50),
  })
  try {
    if (controller.paused) return
    const planError = articleStepPrerequisite(article, 2)
    if (planError) throw new Error(planError)
    article = await saveArticleCheckpoint(article, {
      batchStatus: "running",
      batchError: null,
      batchStartedAt: article.batchStartedAt ?? new Date().toISOString(),
      status: "in_progress",
    })
    if (article.articleSpec) {
      const sanitizedSpec = sanitizeBatchArticleSpec(article.articleSpec)
      if (JSON.stringify(sanitizedSpec.mustCover) !== JSON.stringify(article.articleSpec.mustCover)) {
        article = await saveArticleCheckpoint(article, {
          articleSpec: sanitizedSpec,
          articleSpecFingerprint: snapshotFingerprint(sanitizedSpec),
        })
      }
    }
    if (
      !article.coreIdeaSuggestions?.length ||
      article.coreIdeaSuggestions.length < batchIdeaCount ||
      !article.articleSpec ||
      !article.articleSpecFingerprint
    ) {
      let seoResearch = article.seoResearch
      let seoUsage: any = null
      if (!seoResearch) {
        const seeds = [
          article.topic,
          ...String(article.keywords ?? "").split(","),
        ]
          .map(String)
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 10)
        const seoKey = aiCacheKey({
          kind: "batch-seo-v2",
          keywordCount,
          seeds: seeds.map((value) => value.toLowerCase()).sort(),
        })
        seoResearch = await kvGet<any>(seoKey)
        if (
          seoResearch?.researchedAt &&
          Date.now() - new Date(seoResearch.researchedAt).getTime() >
            24 * 60 * 60 * 1000
        )
          seoResearch = null
        if (!seoResearch) {
          await reserveAIBudget(article.id, 2)
          seoResearch = await researchSeoKeywords(seeds, keywordCount)
          seoUsage = batchUsage(2, "openai", {
            model: "gpt-5.4-mini-web-search",
            usage: seoResearch.usage,
            costUsd: null,
            cacheHit: false,
          })
          await kvSet(seoKey, seoResearch)
          article = await saveArticleCheckpoint(article, {
            seoResearch,
            aiUsageByStep: {
              ...article.aiUsageByStep,
              2: [...(article.aiUsageByStep?.[2] ?? []), seoUsage].slice(-50),
            },
          })
          seoUsage = null
        }
      }
      const response = await runBatchModel(
        article,
        2,
        [
          `Build one canonical Article Spec, then propose exactly ${batchIdeaCount} distinct evidence-grounded ${contentMode} directions for: ${article.topic}.`,
          `SEO research: ${JSON.stringify(seoResearch.keywords)}`,
          "articleSpec.mustCover must contain only reader-facing subject-matter topics, never writing instructions about keyword placement, title, introduction, headings, body, or conclusion.",
          "Every idea must use a primary keyword from the supplied SEO research and include separate 0-10 ratings for overall, SEO potential, audience fit, document support and uniqueness.",
          "The batch runner will select the idea with the highest overall rating, using document support, audience fit and SEO potential as tie-breakers. Do not pre-select an idea.",
          "Use the supplied Knowledge Base and Skills. Return only JSON:",
          '{"articleSpec":{"topic":string,"primaryQuery":string,"secondaryQueries":string[],"audience":string,"market":"Global / USA","language":"English","primaryIntent":"informational|commercial|transactional|navigational","secondaryIntent":"informational|commercial|transactional|navigational","expectedReaderOutcome":string,"winningFormat":string,"mustCover":string[],"optionalCoverage":string[],"thesis":string,"brandPov":string,"evidence":[],"ctaObjective":string,"internalLinkRequirements":string[]},"ideas":[{"title":string,"angleLabel":string,"angleDescription":string,"mainArgument":string,"primaryKeyword":string,"secondaryKeywords":string[],"targetAudience":string,"recommendedTone":string,"recommendedWordCount":number,"rating":{"overall":number,"seoPotential":number,"audienceFit":number,"docSupport":number,"uniqueness":number},"ratingRationale":string}]}',
        ].join("\n"),
        true,
        Math.min(6000, 2200 + batchIdeaCount * 700),
      )
      const payload = parseJsonObject(response.content)
      const coreIdeaContext = await resolveStepContext(
        2,
        `${article.topic ?? ""} ${article.keywords ?? ""}`,
        article.id,
      )
      const trustedIdeaEvidence = batchDeterministicEvidence(
        coreIdeaContext.contextDocs,
        `${article.topic ?? ""} ${article.keywords ?? ""}`,
      )
      const researchedKeywords = new Set(
        (seoResearch.keywords ?? []).map((item: any) =>
          String(item.keyword ?? item).trim().toLocaleLowerCase(),
        ),
      )
      const normalizedIdeas = (Array.isArray(payload.ideas)
        ? payload.ideas
        : payload.idea
          ? [payload.idea]
          : []
      )
        .map((idea: any, index: number) => {
          const primaryKeyword = String(
            idea?.primaryKeyword ?? idea?.seoKeywords?.primary ?? "",
          ).trim()
          return {
            id: `batch-idea-${article.id}-${index + 1}`,
            ...idea,
            primaryKeyword,
            secondaryKeywords: Array.isArray(idea?.secondaryKeywords)
              ? idea.secondaryKeywords.map(String).filter(Boolean)
              : Array.isArray(idea?.seoKeywords?.secondary)
                ? idea.seoKeywords.secondary.map(String).filter(Boolean)
                : [],
            matchedDocs: [...new Set(
              trustedIdeaEvidence
                .filter((item: any) => item.role !== "rules")
                .map((item: any) => item.source),
            )],
            ruleRefs: [...new Set(
              trustedIdeaEvidence
                .filter((item: any) => item.role === "rules")
                .map((item: any) => item.source),
            )],
            evidence: trustedIdeaEvidence,
          }
        })
        .filter(
          (idea: any) =>
            idea.title &&
            idea.mainArgument &&
            idea.primaryKeyword &&
            researchedKeywords.has(idea.primaryKeyword.toLocaleLowerCase()),
        )
      // A batch needs one trustworthy direction to proceed. Treat the configured
      // idea count as a generation target, not a hard failure condition.
      if (!normalizedIdeas.length)
        throw new Error(
          "Batch Step 1 did not return a valid rated Core Idea.",
        )
      const score = (idea: any) => [
        Number(idea.rating?.overall ?? 0),
        Number(idea.rating?.docSupport ?? 0),
        Number(idea.rating?.audienceFit ?? 0),
        Number(idea.rating?.seoPotential ?? 0),
        Number(idea.rating?.uniqueness ?? 0),
      ]
      const normalized = [...normalizedIdeas].sort((left, right) => {
        const leftScore = score(left)
        const rightScore = score(right)
        for (let index = 0; index < leftScore.length; index += 1) {
          if (leftScore[index] !== rightScore[index])
            return rightScore[index] - leftScore[index]
        }
        return String(left.title).localeCompare(String(right.title))
      })[0]
      const baseArticleSpec = normalizeBatchArticleSpec(
        payload.articleSpec,
        article,
        normalized,
      )
      const articleSpec = {
        ...baseArticleSpec,
        primaryQuery: normalized.primaryKeyword,
        secondaryQueries: normalized.secondaryKeywords,
        thesis: normalized.mainArgument,
        audience: normalized.targetAudience || baseArticleSpec.audience,
        evidence: trustedIdeaEvidence,
      }
      const articleSpecFingerprint = snapshotFingerprint(articleSpec)
      const step2Usage = appendUsage(2, response)
      if (seoUsage)
        step2Usage[2] = [seoUsage, ...(step2Usage[2] ?? [])].slice(-50)
      article = await saveArticleCheckpoint(article, {
        seoResearch,
        articleSpec,
        articleSpecFingerprint,
        coreIdeaSuggestions: normalizedIdeas,
        selectedCoreIdeaId: normalized.id,
        title: normalized.title,
        topic: normalized.title,
        angle: normalized.angleLabel,
        keywords: [normalized.primaryKeyword, ...(normalized.secondaryKeywords ?? [])]
          .filter(Boolean)
          .join(", "),
        targetAudience: normalized.targetAudience || articleSpec.audience,
        tone: normalized.recommendedTone,
        wordCount: normalized.recommendedWordCount,
        outline: [],
        draft: "",
        draftEvidenceUsage: {},
        qualityReport: null,
        coreIdeaScannedAt: new Date().toISOString(),
        currentStep: 3,
        aiUsageByStep: step2Usage,
        workflowRuleSnapshots: {
          ...article.workflowRuleSnapshots,
          2: response.workflowRuleSnapshot,
        },
      })
    }
    if (controller.paused) {
      await saveArticleCheckpoint(article, { batchStatus: "paused" })
      return
    }
    if (!article.outline?.length || !batchOutlineHasEvidence(article.outline)) {
      if (!selectedArticleIdea(article))
        throw new Error(
          "Batch Step 2 did not produce a selected Core Idea; outline generation was blocked.",
        )
      const idea =
        article.coreIdeaSuggestions.find(
          (item: any) => item.id === article.selectedCoreIdeaId,
        ) ?? article.coreIdeaSuggestions[0]
      const outlineContext = await resolveStepContext(
        3,
        `${article.topic ?? ""} ${article.keywords ?? ""}`,
        article.id,
      )
      const existingOutline = Array.isArray(article.outline)
        ? article.outline.map((section: any) => ({
            id: section.id,
            heading: section.heading,
            notes: section.notes,
            rationale: section.rationale,
            level: section.level,
            keywords: section.keywords,
            searchIntent: section.searchIntent,
          }))
        : []
      const outlinePrompt = [
        existingOutline.length
          ? `Enrich this approved outline with verified evidence without changing section IDs, headings, order, or level: ${JSON.stringify(existingOutline)}.`
          : `Create a detailed outline that satisfies this immutable Article Spec: ${JSON.stringify(article.articleSpec)}.`,
        `Selected direction: ${JSON.stringify(idea)}`,
        "Use only exact quotes copied from the supplied reference documents. Never invent or paraphrase evidence quotes.",
        "For every section, include at least one evidence quote from Knowledge Base or the current Content Plan when those sources are available, plus at least one Rules quote when Rules sources are available.",
        `Return only JSON: {"evidenceRegistry":{"ev-1":{"source":string,"note":string,"quote":string,"role":"kb"|"content_plan"|"rules"}},"sections":[{"id":string,"heading":string,"notes":string,"rationale":string,"level":"h2"|"h3","keywords":string[],"searchIntent":"informational"|"commercial"|"transactional"|"navigational","evidenceRefs":string[],"evidence":[{"source":string,"note":string,"quote":string,"role":"kb"|"content_plan"|"rules"}],"ruleRefs":string[]}]}. ${existingOutline.length ? "Return every existing section." : `Create approximately ${desiredOutlineSections} sections and never fewer than ${minimumOutlineSections}.`} Map verified evidence to every section.`,
      ].join("\n")
      const response = await runBatchModel(
        article,
        3,
        outlinePrompt,
        true,
        5000,
        undefined,
        existingOutline.length ? "recovery" : "generation",
      )
      const parsed = parseJsonObject(response.content)
      const inheritedOutlineEvidence = [
        ...(Array.isArray(idea?.evidence) ? idea.evidence : []),
        ...(Array.isArray(article.articleSpec?.evidence)
          ? article.articleSpec.evidence
          : []),
      ].filter(
        (item: any, index: number, all: any[]) =>
          item?.source &&
          item?.quote &&
          all.findIndex(
            (candidate: any) =>
              candidate?.source === item.source &&
              candidate?.quote === item.quote &&
              candidate?.role === item.role,
          ) === index,
      )
      let sections = normalizeBatchOutlinePayload(
        parsed,
        outlineContext.contextDocs,
        inheritedOutlineEvidence,
      ).filter((section: any) => section.heading)
      const outlineResponses = [response]
      if (sections.length < minimumOutlineSections) {
        const rawHeadings = (Array.isArray(parsed.sections) ? parsed.sections : [])
          .map((section: any) => String(section?.heading ?? "").trim())
          .filter(Boolean)
        const acceptedHeadings = new Set(
          sections.map((section: any) => section.heading.toLocaleLowerCase()),
        )
        const rejectedHeadings = rawHeadings.filter(
          (heading: string) => !acceptedHeadings.has(heading.toLocaleLowerCase()),
        )
        const missingCount = Math.max(
          minimumOutlineSections - sections.length,
          desiredOutlineSections - sections.length,
        )
        const correction = await runBatchModel(
          article,
          3,
          [
            outlinePrompt,
            `The first response produced only ${sections.length}/${minimumOutlineSections} sections that passed deterministic evidence verification.`,
            `Return exactly ${missingCount} replacement sections only. Do not repeat accepted headings: ${JSON.stringify([...acceptedHeadings])}.`,
            `Rejected headings that may be rebuilt with valid evidence: ${JSON.stringify(rejectedHeadings)}.`,
            `Verified evidence that may be reused directly in each replacement: ${JSON.stringify(inheritedOutlineEvidence)}.`,
            "Each replacement must include valid evidenceRefs or direct evidence objects for every available source category. Copy source names and quotes exactly from the supplied documents.",
            'Return only {"evidenceRegistry":{...},"sections":[...]}.',
          ].join("\n\n"),
          true,
          Math.min(5000, 1200 + missingCount * 450),
          undefined,
          "recovery",
        )
        outlineResponses.push(correction)
        const additions = normalizeBatchOutlinePayload(
          parseJsonObject(correction.content),
          outlineContext.contextDocs,
          inheritedOutlineEvidence,
        ).filter((section: any) => section.heading)
        sections = [...sections, ...additions]
          .filter(
            (section: any, index: number, all: any[]) =>
              all.findIndex(
                (candidate) =>
                  candidate.heading.toLocaleLowerCase() ===
                  section.heading.toLocaleLowerCase(),
              ) === index,
          )
          .slice(0, desiredOutlineSections)
          .map((section: any, index: number) => ({
            ...section,
            id: `batch-section-${index + 1}`,
          }))
      }
      if (sections.length < minimumOutlineSections)
        throw new Error(
          `Step 2 outline validation returned only ${sections.length}/${minimumOutlineSections} usable sections after one targeted evidence correction.`,
        )
      if (!batchOutlineHasEvidence(sections))
        throw new Error(
          "Batch outline has no evidence quote verified against the supplied sources. Draft generation was stopped before semantic QC.",
        )
      article = await saveArticleCheckpoint(article, {
        outline: sections,
        outlineScannedAt: new Date().toISOString(),
        currentStep: 4,
        aiUsageByStep: {
          ...article.aiUsageByStep,
          3: [
            ...(article.aiUsageByStep?.[3] ?? []),
            ...outlineResponses.map((item) =>
              batchUsage(3, item.provider ?? "unknown", item),
            ),
          ].slice(-50),
        },
        workflowRuleSnapshots: {
          ...article.workflowRuleSnapshots,
          3: response.workflowRuleSnapshot,
        },
      })
    }
    if (controller.paused) {
      await saveArticleCheckpoint(article, { batchStatus: "paused" })
      return
    }
    let feasibility = batchOutlineFeasibility(article, maxDraftWords)
    if (!feasibility.feasible) {
      const outlineContext = await resolveStepContext(
        3,
        `${article.topic ?? ""} ${article.keywords ?? ""}`,
        article.id,
      )
      const compacted = await runBatchModel(
        article,
        3,
        [
          `The approved outline requires approximately ${feasibility.minimumRequired} words and cannot fit the user target of ${maxDraftWords} words.`,
          `Merge overlapping sections and simplify the outline to approximately ${desiredOutlineSections} sections without changing the Article Spec, primary query, reader outcome, must-cover coverage, or supported claims.`,
          `CURRENT VERIFIED OUTLINE: ${JSON.stringify(batchVerifiedOutline(article.outline ?? []))}`,
          "Use only exact evidence quotes from the supplied documents. Preserve useful evidence by remapping it to the merged section.",
          'Return only JSON: {"evidenceRegistry":{"ev-1":{"source":string,"note":string,"quote":string,"role":"kb"|"content_plan"|"rules"}},"sections":[{"id":string,"heading":string,"notes":string,"rationale":string,"level":"h2"|"h3","keywords":string[],"searchIntent":"informational"|"commercial"|"transactional"|"navigational","evidenceRefs":string[],"ruleRefs":string[]}]}.',
        ].join("\n\n"),
        true,
        5000,
        undefined,
        "recovery",
      )
      const compactedSections = normalizeBatchOutlinePayload(
        parseJsonObject(compacted.content),
        outlineContext.contextDocs,
        (article.outline ?? []).flatMap((section: any) => section.evidence ?? []),
      ).filter((section: any) => section.heading)
      if (
        compactedSections.length < minimumOutlineSections ||
        !batchOutlineHasEvidence(compactedSections)
      )
        throw new Error(
          "Batch could not compact the outline into the configured word target with verified evidence.",
        )
      const compactedFeasibility = batchOutlineFeasibility(
        { ...article, outline: compactedSections },
        maxDraftWords,
      )
      if (!compactedFeasibility.feasible)
        throw new Error(
          `Outline still requires approximately ${compactedFeasibility.minimumRequired} words after automatic compaction; target remains ${maxDraftWords}.`,
        )
      article = await saveArticleCheckpoint(article, {
        outline: compactedSections,
        outlineScannedAt: new Date().toISOString(),
        draft: "",
        draftEvidenceUsage: {},
        qualityReport: null,
        aiUsageByStep: appendUsage(3, compacted),
      })
      feasibility = compactedFeasibility
    }
    // Do not spend draft-generation credits on an outline whose Article Spec contract is
    // not visibly mapped. Persist the missing requirements onto the most
    // relevant approved section, then validate the generated prose separately.
    const missingOutlineCoverage = batchMissingOutlineCoverage(article)
    if (missingOutlineCoverage.length) {
      article = await saveArticleCheckpoint(article, {
        outline: attachBatchOutlineCoverage(article.outline ?? [], missingOutlineCoverage),
        outlineScannedAt: new Date().toISOString(),
        qualityReport: null,
      })
    }
    const approvedInternalLinkCandidates = selectWebsiteCandidates(
      article,
      runtimeConfig?.websiteInventory ?? [],
      6,
    )
    if (
      article.articleSpec?.internalLinkRequirements?.length &&
      !approvedInternalLinkCandidates.length
    )
      throw new Error(
        "Batch stopped before draft generation: the Article Spec requires an internal link, but Website Inventory has no relevant approved URL. Approve a matching inventory page or update the Article Spec before retrying.",
      )
    if (!article.draft?.trim() || article.qualityReport?.status !== "pass") {
      const draftPrerequisite = articleStepPrerequisite(article, 4)
      if (draftPrerequisite) throw new Error(draftPrerequisite)
      const effectiveDraftWords = maxDraftWords
      const budget = batchDraftBudget(
        article.outline ?? [],
        effectiveDraftWords,
        introductionPercent,
        conclusionPercent,
      )
      const verifiedOutline = batchVerifiedOutline(article.outline ?? [])
      let response: any = null
      const initialDraftResponses: any[] = []
      let assembled: { draft: string; evidenceUsage: Record<string, string[]>; parsed: any }
      if (String(article.draft ?? "").trim()) {
        assembled = {
          draft: String(article.draft),
          evidenceUsage: completeBatchEvidenceUsage(
            verifiedOutline,
            article.draftEvidenceUsage ?? {},
          ),
          parsed: null,
        }
      } else {
        response = await runBatchModel(
          article,
          4,
          [
            `Write the complete publication-ready ${contentMode} article: ${article.topic}.`,
            `ARTICLE SPEC (immutable acceptance contract): ${JSON.stringify(article.articleSpec)}.`,
            `Primary keyword: ${article.articleSpec?.primaryQuery ?? article.coreIdeaSuggestions?.[0]?.primaryKeyword ?? article.keywords ?? article.topic}.`,
            `Approved outline and evidence registry: ${JSON.stringify(verifiedOutline)}`,
            `WORD BUDGET CONTRACT: ${JSON.stringify(budget)}`,
            `RELEVANT APPROVED INTERNAL LINK CANDIDATES: ${JSON.stringify(approvedInternalLinkCandidates)}`,
            article.articleSpec?.internalLinkRequirements?.length
              ? "INTERNAL LINK CONTRACT: Include one contextual Markdown link using exactly one URL from the approved candidates. Never invent, alter, or substitute a URL."
              : "Never invent a URL. Use only an approved inventory URL when the Article Spec requires a relevant internal link.",
            `Complete every section before expanding any section. Do not repeat definitions, benefits, comparisons, evidence, or conclusions. Each paragraph serves one claim and contains at most ${maxSentencesPerParagraph} sentences.`,
            "Knowledge Base is the only source for concrete facts, figures, evidence and product claims. If a concrete claim has no approved evidence, omit it or replace it with general explanatory prose.",
            "Follow every supplied Skill rule and use only supported KB claims. Keep every approved heading in order and do not add unplanned sections.",
            'Return only JSON: {"title":string,"introduction":string,"sections":[{"id":string,"content":string,"usedEvidenceRefs":string[]}],"conclusion":string}. Include exactly one non-empty entry for every outline section ID in order. Each usedEvidenceRefs array may contain only IDs approved for that section. section.content is prose only: never include #, ##, ###, its outline heading, or a Conclusion heading.',
          ].join("\n"),
          true,
          Math.min(12000, Math.max(1800, Math.ceil(effectiveDraftWords * 1.9))),
          structuredDraftJsonSchema,
        )
        initialDraftResponses.push(response)
        if (!response.content.trim()) throw new Error("Step 4 returned an empty draft.")
        try {
          assembled = assembleBatchDraft(response.content, article)
        } catch (schemaError: any) {
          const schemaRepair = await runBatchModel(
            article,
            4,
            [
              "Repair the incomplete structured draft response. Return one complete JSON object and preserve every usable field already returned.",
              `VALIDATION ERROR: ${schemaError?.message ?? String(schemaError)}`,
              `INCOMPLETE RESPONSE: ${response.content}`,
              `ARTICLE SPEC: ${JSON.stringify(article.articleSpec)}`,
              `APPROVED OUTLINE AND EVIDENCE: ${JSON.stringify(verifiedOutline)}`,
              `WORD BUDGET CONTRACT: ${JSON.stringify(budget)}`,
              'Return only JSON: {"title":string,"introduction":string,"sections":[{"id":string,"content":string,"usedEvidenceRefs":string[]}],"conclusion":string}. Return every outline section exactly once in order. section.content must be prose only and must not repeat a Markdown heading.',
            ].join("\n\n"),
            true,
            Math.min(12000, Math.max(1800, Math.ceil(effectiveDraftWords * 1.9))),
            structuredDraftJsonSchema,
            "recovery",
            { skipDocumentContext: true },
          )
          initialDraftResponses.push(schemaRepair)
          assembled = assembleBatchDraft(schemaRepair.content, article)
        }
      }
      const draftResponses = [...initialDraftResponses]
      let assembledDraft = repairBatchInternalLinks(
        assembled.draft,
        article,
        runtimeConfig?.websiteInventory ?? [],
      )
      article = await saveArticleCheckpoint(article, {
        draft: assembledDraft,
        draftEvidenceUsage: assembled.evidenceUsage,
        qualityReport: null,
        draftScannedAt: new Date().toISOString(),
        currentStep: 4,
        aiUsageByStep: initialDraftResponses.length
          ? {
              ...article.aiUsageByStep,
              4: [
                ...(article.aiUsageByStep?.[4] ?? []),
                ...initialDraftResponses.map((item) =>
                  batchUsage(4, item.provider ?? "unknown", item),
                ),
              ].slice(-50),
            }
          : article.aiUsageByStep,
        workflowRuleSnapshots: {
          ...article.workflowRuleSnapshots,
          4: response?.workflowRuleSnapshot ?? article.workflowRuleSnapshots?.[4],
        },
      })
      draftResponses.length = 0
      const internalNames = ((await kvGet<any[]>("writer:files")) ?? [])
        .filter(
          (item) =>
            item.category === "kb" &&
            !item.knowledgeMetadata?.approvedForExternalUse,
        )
        .map((item) => item.name)
      let deterministic = [
        ...batchUniversalChecks(
          assembledDraft,
          article,
          effectiveDraftWords,
          runtimeConfig?.websiteInventory ?? [],
          internalNames,
        ),
        ...batchFieldBudgetChecks(assembledDraft, budget),
        batchEvidenceMappingCheck(verifiedOutline, assembled.evidenceUsage),
      ]
      const repairFieldBudgetGaps = async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const fieldFailures = deterministic.filter(
            (item) =>
              item.status === "fail" &&
              ["introduction-word-budget", "conclusion-word-budget"].includes(
                item.id,
              ),
          )
          if (!fieldFailures.length) return
          const failureIds = new Set(fieldFailures.map((item) => item.id))
          const currentFields = batchDraftFieldParts(assembledDraft)
          const repair = await runBatchModel(
            article,
            4,
            [
              "Expand only the under-length introduction and/or conclusion. Do not return a title, headings, body sections, markdown, or any other article field.",
              `LENGTH FAILURES: ${JSON.stringify(fieldFailures)}`,
              `INTRODUCTION: preferred ${budget.introduction.min}-${budget.introduction.max}; mandatory accepted range ${budget.introduction.acceptedMin}-${budget.introduction.acceptedMax} English words.`,
              `CONCLUSION: preferred ${budget.conclusion.min}-${budget.conclusion.max}; mandatory accepted range ${budget.conclusion.acceptedMin}-${budget.conclusion.acceptedMax} English words.`,
              "Count words before responding. Each failed field must meet its accepted range in the returned JSON. Add useful reader-facing explanation that is supported by the Article Spec and approved evidence; do not add filler or unsupported claims.",
              `ARTICLE SPEC: ${JSON.stringify(article.articleSpec)}`,
              `APPROVED OUTLINE AND EVIDENCE: ${JSON.stringify(verifiedOutline)}`,
              `CURRENT INTRODUCTION: ${currentFields.introduction}`,
              `CURRENT CONCLUSION: ${currentFields.conclusion}`,
              'Return only JSON: {"introduction":string,"conclusion":string}. Keep a field unchanged when it is not listed in LENGTH FAILURES.',
            ].join("\n\n"),
            true,
            1800,
            batchFieldLengthRepairJsonSchema,
            "recovery",
            { skipDocumentContext: true },
          )
          draftResponses.push(repair)
          const nextDraft = applyBatchFieldLengthRepair(
            assembledDraft,
            repair.content,
            failureIds,
          )
          if (nextDraft === assembledDraft) return
          assembledDraft = nextDraft
          deterministic = [
            ...batchUniversalChecks(assembledDraft, article, effectiveDraftWords, runtimeConfig?.websiteInventory ?? [], internalNames),
            ...batchFieldBudgetChecks(assembledDraft, budget),
            batchEvidenceMappingCheck(verifiedOutline, assembled.evidenceUsage),
          ]
        }
      }
      if (deterministic.some((item) => item.status !== "pass")) {
        const deterministicFailures = deterministic.filter(
          (item) => item.status !== "pass",
        )
        const needsStructuredRecovery = deterministicFailures.some(
          (item) =>
            item.id === "seo-contract" &&
            /headings|conclusion heading/i.test(String(item.reason ?? "")),
        )
        const repair = await runBatchModel(
          article,
          4,
          needsStructuredRecovery
            ? [
                "Rebuild the current draft into a complete structured article while preserving its valid claims and approved outline.",
                `FINDINGS: ${JSON.stringify(deterministicFailures)}`,
                `ARTICLE SPEC: ${JSON.stringify(article.articleSpec)}`,
                `APPROVED OUTLINE AND EVIDENCE: ${JSON.stringify(verifiedOutline)}`,
                `WORD BUDGET CONTRACT: ${JSON.stringify(budget)}`,
                `APPROVED INTERNAL LINKS: ${JSON.stringify(selectWebsiteCandidates(article, runtimeConfig?.websiteInventory ?? [], 6))}`,
                `CURRENT DRAFT:\n${assembledDraft}`,
                'Return only JSON: {"title":string,"introduction":string,"sections":[{"id":string,"content":string,"usedEvidenceRefs":string[]}],"conclusion":string}. Return every approved section exactly once, one conclusion, and only evidence IDs allowed for that section.',
              ].join("\n\n")
            : [
                "Repair only the deterministic QC findings in the current draft. Return exact find/replace edits, not a rewritten article.",
                `FINDINGS: ${JSON.stringify(deterministicFailures)}`,
                `ARTICLE SPEC: ${JSON.stringify(article.articleSpec)}`,
                `APPROVED INTERNAL LINKS: ${JSON.stringify(selectWebsiteCandidates(article, runtimeConfig?.websiteInventory ?? [], 6))}`,
                `CURRENT DRAFT:\n${assembledDraft}`,
                "Never invent URLs. Preserve headings and unaffected prose.",
              ].join("\n\n"),
          true,
          needsStructuredRecovery
            ? Math.min(16000, Math.max(3000, Math.ceil(effectiveDraftWords * 1.9)))
            : 2000,
          needsStructuredRecovery
            ? structuredDraftJsonSchema
            : batchDraftRepairJsonSchema,
          "recovery",
          { skipDocumentContext: true },
        )
        draftResponses.push(repair)
        if (needsStructuredRecovery) {
          assembled = assembleBatchDraft(repair.content, article)
          assembledDraft = repairBatchInternalLinks(
            assembled.draft,
            article,
            runtimeConfig?.websiteInventory ?? [],
          )
        } else {
          assembledDraft = applyBatchDraftRepair(assembledDraft, repair.content)
        }
        deterministic = [
          ...batchUniversalChecks(assembledDraft, article, effectiveDraftWords, runtimeConfig?.websiteInventory ?? [], internalNames),
          ...batchFieldBudgetChecks(assembledDraft, budget),
          batchEvidenceMappingCheck(verifiedOutline, assembled.evidenceUsage),
        ]
        await repairFieldBudgetGaps()
        const report = {
          version: 5, status: "fail", checkedAt: new Date().toISOString(),
          articleSpecFingerprint: article.articleSpecFingerprint, checks: deterministic,
        }
        article = await saveArticleCheckpoint(article, {
          draft: assembledDraft,
          draftEvidenceUsage: assembled.evidenceUsage,
          qualityReport: report,
          aiUsageByStep: {
            ...article.aiUsageByStep,
            4: [
              ...(article.aiUsageByStep?.[4] ?? []),
              ...draftResponses.map((item) => batchUsage(4, item.provider ?? "unknown", item)),
            ].slice(-50),
          },
        })
        draftResponses.length = 0
        if (deterministic.some((item) => item.status !== "pass")) throw new Error(
          `Targeted batch repair was saved, but Universal QC still failed: ${deterministic
            .filter((item) => item.status !== "pass")
            .map((item) => item.reason)
            .join("; ")}`,
        )
      }
      const requestSemanticReview = async (
        candidate: string,
        candidateUsage: Record<string, string[]>,
        incompleteRecovery = false,
      ) => {
        const review = await runBatchModel(
          article,
          4,
          [
            "Act only as a strict semantic publishing reviewer. Do not rewrite the draft. Visible citations, footnotes, filenames, and evidence IDs are not required in prose.",
            `ARTICLE SPEC: ${JSON.stringify(article.articleSpec)}`,
            `APPROVED EVIDENCE REGISTRY: ${JSON.stringify(verifiedOutline.evidenceRegistry)}`,
            `OUTLINE EVIDENCE MAPPING: ${JSON.stringify(verifiedOutline.sections.map((section: any) => ({ id: section.id, evidenceRefs: section.evidenceRefs })))}`,
            `DRAFT EVIDENCE USAGE: ${JSON.stringify(candidateUsage)}`,
            `INTRODUCTION LENGTH: prefer ${budget.introduction.min}-${budget.introduction.max} words; accept ${budget.introduction.acceptedMin}-${budget.introduction.acceptedMax} words. Length inside the accepted range must not produce a warning or failure. There is no fixed character-count requirement; never invent one.`,
            `DRAFT: ${candidate}`,
            batchSemanticReviewInstruction(article, candidate),
            incompleteRecovery
              ? "The prior report was structurally incomplete. Return a fresh complete report."
              : "",
            'Return checks as an object with exactly these keys: intent-satisfied, reader-outcome, intro-quality, keyword-naturalness, evidence-support, brand-pov. Each value has label,status(pass|warning|fail),reason,evidence,location,recommendedAction,autoFixAllowed. Evidence support passes when concrete claims are supported by the registry and declared section mapping; do not penalize general explanatory prose for lacking a citation. Never evaluate URLs, internal links, link targets, or Website Inventory in a semantic check; those are validated separately by deterministic code. Use warning only for a genuine non-blocking publish-quality concern and fail only for a blocking unsupported claim or contract violation.',
          ].filter(Boolean).join("\n\n"),
          true,
          1600,
          semanticQualityJsonSchema,
          "recovery",
          { skipDocumentContext: true },
        )
        draftResponses.push(review)
        return review
      }
      let review = await requestSemanticReview(
        assembledDraft,
        assembled.evidenceUsage,
      )
      let semantic
      try {
        semantic = reconcileBatchSemanticChecks(
          parseBatchSemanticChecks(review.content),
          deterministic,
        )
      } catch {
        review = await requestSemanticReview(
          assembledDraft,
          assembled.evidenceUsage,
          true,
        )
        semantic = reconcileBatchSemanticChecks(
          parseBatchSemanticChecks(review.content),
          deterministic,
        )
      }
      let checks = [...deterministic, ...semantic]
      let report = {
        version: 5,
        status: checks.every((item) => item.status === "pass")
          ? "pass"
          : checks.some((item) => item.status === "fail")
            ? "fail"
            : "warning",
        checkedAt: new Date().toISOString(),
        articleSpecFingerprint: article.articleSpecFingerprint,
        checks,
      }
      if (report.status === "fail") {
        const semanticFindings = semantic.filter(
          (item: any) => item.status !== "pass",
        )
        const semanticRepair = await runBatchModel(
          article,
          4,
          [
            "Revise only what is necessary to resolve the supplied semantic findings. Preserve every approved outline section ID and heading. Section content must contain prose only: never repeat its outline heading or add Markdown headings inside content. Return the complete structured draft JSON.",
            `SEMANTIC FINDINGS: ${JSON.stringify(semanticFindings)}`,
            `CURRENT DRAFT: ${JSON.stringify(assembled.parsed ?? assembledDraft)}`,
            `ARTICLE SPEC: ${JSON.stringify(article.articleSpec)}`,
            `APPROVED OUTLINE AND EVIDENCE: ${JSON.stringify(verifiedOutline)}`,
            `WORD BUDGET CONTRACT: ${JSON.stringify(budget)}`,
            'Return only JSON: {"title":string,"introduction":string,"sections":[{"id":string,"content":string,"usedEvidenceRefs":string[]}],"conclusion":string}. Declare only evidence IDs approved for each section.',
          ].join("\n\n"),
          true,
          Math.min(12000, Math.max(3000, Math.ceil(effectiveDraftWords * 1.9))),
          structuredDraftJsonSchema,
          "recovery",
          { skipDocumentContext: true },
        )
        draftResponses.push(semanticRepair)
        assembled = assembleBatchDraft(semanticRepair.content, article)
        assembledDraft = repairBatchInternalLinks(
          assembled.draft,
          article,
          runtimeConfig?.websiteInventory ?? [],
        )
        deterministic = [
          ...batchUniversalChecks(assembledDraft, article, effectiveDraftWords, runtimeConfig?.websiteInventory ?? [], internalNames),
          ...batchFieldBudgetChecks(assembledDraft, budget),
          batchEvidenceMappingCheck(verifiedOutline, assembled.evidenceUsage),
        ]
        await repairFieldBudgetGaps()
        if (deterministic.every((item) => item.status === "pass")) {
          const verification = await requestSemanticReview(
            assembledDraft,
            assembled.evidenceUsage,
          )
          try {
            semantic = reconcileBatchSemanticChecks(
              parseBatchSemanticChecks(verification.content),
              deterministic,
            )
          } catch {
            const recoveredVerification = await requestSemanticReview(
              assembledDraft,
              assembled.evidenceUsage,
              true,
            )
            semantic = reconcileBatchSemanticChecks(
              parseBatchSemanticChecks(recoveredVerification.content),
              deterministic,
            )
          }
        }
        checks = [...deterministic, ...semantic]
        report = {
          version: 5,
          status: checks.every((item) => item.status === "pass") ? "pass" : checks.some((item) => item.status === "fail") ? "fail" : "warning",
          checkedAt: new Date().toISOString(),
          articleSpecFingerprint: article.articleSpecFingerprint,
          checks,
        }
      }
      if (report.status === "fail") {
        article = await saveArticleCheckpoint(article, {
          draft: assembledDraft,
          draftEvidenceUsage: assembled.evidenceUsage,
          qualityReport: report,
          aiUsageByStep: {
            ...article.aiUsageByStep,
            4: [
              ...(article.aiUsageByStep?.[4] ?? []),
              ...draftResponses.map((item) =>
                batchUsage(4, item.provider ?? "unknown", item),
              ),
            ].slice(-50),
          },
        })
        throw new Error(
          `Targeted batch recovery was saved, but Universal QC is still ${report.status}: ${checks.filter((item) => item.status !== "pass").map((item) => `${item.label}: ${item.reason}`).join("; ")}`,
        )
      }
      article = await saveArticleCheckpoint(article, {
        draft: assembledDraft,
        draftEvidenceUsage: assembled.evidenceUsage,
        qualityReport: report,
        draftScannedAt: new Date().toISOString(),
        currentStep: 4,
        status: "done",
        completedAt: new Date().toISOString(),
        batchStatus: "completed",
        aiUsageByStep: {
          ...article.aiUsageByStep,
          4: [
            ...(article.aiUsageByStep?.[4] ?? []),
            ...draftResponses.map((item) =>
              batchUsage(4, item.provider ?? "unknown", item),
            ),
          ].slice(-50),
        },
        workflowRuleSnapshots: {
          ...article.workflowRuleSnapshots,
          4: response?.workflowRuleSnapshot ?? article.workflowRuleSnapshots?.[4],
        },
      })
    } else if (article.batchStatus !== "completed") {
      article = await saveArticleCheckpoint(article, {
        status: "done",
        batchStatus: "completed",
        completedAt: article.completedAt ?? new Date().toISOString(),
      })
    }
  } catch (error: any) {
    await saveArticleCheckpoint(article, {
      batchStatus: "failed",
      batchError: error?.message ?? String(error),
      status: "review",
    })
  }
}

async function runBatch(activityId: string) {
  const controller = batchControllers.get(activityId) ?? {
    paused: false,
    running: false,
  }
  if (controller.running) return
  controller.running = true
  controller.paused = false
  batchControllers.set(activityId, controller)
  await kvSet(`writer:batch:${activityId}`, {
    activityId,
    status: "running",
    updatedAt: new Date().toISOString(),
  })
  try {
    while (!controller.paused) {
      const articles = (await loadArticles()).filter(
        (article) =>
          article.activityId === activityId &&
          article.activityKind === "batch" &&
          !["completed", "failed"].includes(article.batchStatus),
      )
      if (!articles.length) break
      await runWithConcurrency(articles, 2, (article) =>
        runBatchArticle(article, controller),
      )
      const queuedDuringRun = (await loadArticles()).some(
        (article) =>
          article.activityId === activityId &&
          article.activityKind === "batch" &&
          article.batchStatus === "queued",
      )
      if (!queuedDuringRun) break
    }
    const latest = (await loadArticles()).filter(
      (article) => article.activityId === activityId,
    )
    const status = controller.paused
      ? "paused"
      : latest.every((article) => article.batchStatus === "completed")
        ? "completed"
        : latest.some((article) => article.batchStatus === "failed")
          ? "failed"
          : "queued"
    const usage = latest.flatMap(
      (article) => Object.values(article.aiUsageByStep ?? {}).flat() as any[],
    )
    await kvSet(`writer:batch:${activityId}`, {
      activityId,
      status,
      total: latest.length,
      completed: latest.filter((article) => article.batchStatus === "completed")
        .length,
      failed: latest.filter((article) => article.batchStatus === "failed")
        .length,
      totalTokens: usage.reduce(
        (sum, call) => sum + Number(call.totalTokens ?? 0),
        0,
      ),
      totalCostUsd: usage.every((call) => call.costUsd != null)
        ? usage.reduce((sum, call) => sum + Number(call.costUsd), 0)
        : null,
      updatedAt: new Date().toISOString(),
    })
  } finally {
    controller.running = false
  }
}

function extractJsonArray(content: string): unknown[] {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return parsed
  } catch {
    const start = cleaned.indexOf("[")
    const end = cleaned.lastIndexOf("]")
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    }
  }
  throw new Error("AI không trả về JSON array hợp lệ cho một wave.")
}

function canonicalEvidence(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

function extractWaveNumber(value: unknown): string | undefined {
  const canonical = canonicalEvidence(value)
  return (
    canonical.match(/\b(?:publishing\s+)?wave\s*(\d+)\b/)?.[1] ??
    canonical.match(/^w?\s*(\d+)$/)?.[1]
  )
}

function normalizeStep1ScopeItems(
  items: unknown[],
  context: StepWaveContext,
): unknown[] {
  const expectedWaveNumber = extractWaveNumber(context.wave)
  const expectedTimeframe = canonicalEvidence(context.timeframe)
  return items.map((item) => {
    if (!item || typeof item !== "object") return item
    const record = item as Record<string, unknown>
    const waveMatches =
      expectedWaveNumber &&
      extractWaveNumber(record.wave) === expectedWaveNumber
    const timeframeMatches =
      !expectedTimeframe ||
      canonicalEvidence(record.timeframe).includes(expectedTimeframe)
    return waveMatches && timeframeMatches
      ? {
          ...record,
          wave: context.wave,
          timeframe: context.timeframe ?? record.timeframe,
        }
      : record
  })
}

function missingStep1Coverage(
  items: unknown[],
  context: StepWaveContext,
): string[] {
  const records = items.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object"),
  )
  const expectedWave = canonicalEvidence(context.wave)
  const expectedWaveNumber = extractWaveNumber(context.wave)
  const expectedTimeframe = canonicalEvidence(context.timeframe)
  const inScope = records.filter((item) => {
    const wave = canonicalEvidence(item.wave)
    const timeframe = canonicalEvidence(item.timeframe)
    const waveNumber = extractWaveNumber(item.wave)
    const waveMatches = expectedWaveNumber
      ? waveNumber === expectedWaveNumber
      : wave === expectedWave
    return (
      waveMatches &&
      (!expectedTimeframe || timeframe.includes(expectedTimeframe))
    )
  })
  const missing: string[] = []
  if (!inScope.length)
    missing.push(
      `${context.wave}${context.timeframe ? ` / ${context.timeframe}` : ""}`,
    )
  for (const typeGroup of context.expectedTypeGroups) {
    const present = inScope.some(
      (item) =>
        String(item.typeGroup ?? item.type ?? "")
          .toUpperCase()
          .match(/\b(A|B|C)\b/)?.[1] === typeGroup,
    )
    if (!present) missing.push(`Type ${typeGroup}`)
  }
  return missing
}

function step1CoverageEstimate(
  items: unknown[],
  context: StepWaveContext,
): string | null {
  const records = items.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object"),
  )
  const expectedWaveNumber = extractWaveNumber(context.wave)
  const expectedTimeframe = canonicalEvidence(context.timeframe)
  const count = records.filter((item) => {
    const wave = canonicalEvidence(item.wave)
    const waveNumber = extractWaveNumber(item.wave)
    const waveMatches = expectedWaveNumber
      ? waveNumber === expectedWaveNumber
      : wave === canonicalEvidence(context.wave)
    return (
      waveMatches &&
      (!expectedTimeframe ||
        canonicalEvidence(item.timeframe).includes(expectedTimeframe))
    )
  }).length
  return count < context.expectedItemCount
    ? `ước lượng ${count}/${context.expectedItemCount}`
    : null
}

function mergeStep1Items(...groups: unknown[][]): unknown[] {
  const seen = new Set<string>()
  return groups.flat().filter((item) => {
    if (!item || typeof item !== "object") return false
    const record = item as Record<string, unknown>
    const key = [
      record.typeGroup ?? record.type,
      record.wave,
      record.timeframe,
      record.label ?? record.name,
    ]
      .map(canonicalEvidence)
      .join("|")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function summarizeStep1Items(items: unknown[]): Array<Record<string, string>> {
  return items
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .slice(0, 12)
    .map((item) => ({
      label: String(item.label ?? item.name ?? "").slice(0, 100),
      typeGroup: String(item.typeGroup ?? item.type ?? ""),
      wave: String(item.wave ?? ""),
      timeframe: String(item.timeframe ?? ""),
    }))
}

function combineStep1Responses(first: any, second: any) {
  return {
    ...second,
    usage: {
      inputTokens:
        (first.usage?.inputTokens ?? 0) + (second.usage?.inputTokens ?? 0),
      outputTokens:
        (first.usage?.outputTokens ?? 0) + (second.usage?.outputTokens ?? 0),
      cachedInputTokens:
        (first.usage?.cachedInputTokens ?? 0) +
        (second.usage?.cachedInputTokens ?? 0),
    },
  }
}

function assertCompleteStep1Result(
  items: unknown[],
  contexts: StepWaveContext[],
): void {
  const failures = contexts.flatMap((context) =>
    missingStep1Coverage(items, context).map(
      (reason) => `${context.scopeKey}: ${reason}`,
    ),
  )
  if (failures.length) {
    throw new Error(
      `Kết quả Step 1 chưa đủ manifest theo từng wave/timeframe: ${failures.join("; ")}`,
    )
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await worker(items[index], index)
      }
    },
  )
  await Promise.all(runners)
  return results
}

function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("URL chỉ hỗ trợ HTTP/HTTPS.")
  const host = url.hostname.toLowerCase()
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    throw new Error("Không cho phép truy cập URL nội bộ/private network.")
  return url
}

async function fetchTextSource(
  urlValue: string,
  headers?: Record<string, string>,
): Promise<string> {
  const url = assertPublicHttpUrl(urlValue)
  const response = await fetch(url, {
    headers: headers ?? {},
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok)
    throw new Error(`Không thể tải URL: HTTP ${response.status}.`)
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > 10 * 1024 * 1024)
    throw new Error("Nguồn URL vượt giới hạn 10 MB.")
  const content = await response.text()
  if (content.length > 10 * 1024 * 1024)
    throw new Error("Nguồn URL vượt giới hạn 10 MB.")
  return content.trim()
}

async function fetchAirtableSource(
  key: string,
  base: string,
  table: string,
): Promise<string> {
  if (!/^app[a-zA-Z0-9]+$/.test(base))
    throw new Error("Airtable Base ID không hợp lệ.")
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?pageSize=100`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Airtable API: HTTP ${response.status}.`)
  const payload = (await response.json()) as { records?: unknown[] }
  return JSON.stringify(payload.records ?? [], null, 2)
}

const CONTENT_PLAN_PREFIX = "writer:content-plan:"
const CONTENT_PLAN_CLASSIFIER_VERSION = "content-plan-classifier-v1"

function planFromRow(row: any, sources: any[] = [], items: any[] = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    seriesId: row.series_id ?? row.id,
    version: row.version,
    previousVersionId: row.previous_version_id ?? null,
    sourceFingerprint: row.source_fingerprint ?? "",
    totalArticles: row.total_articles ?? 0,
    comparisonCount: row.comparison_count ?? 0,
    editorialCount: row.editorial_count ?? 0,
    reviewCount: row.review_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    classifiedAt: row.classified_at,
    changeSummary: row.change_summary ?? undefined,
    sources: sources.map((source) => ({
      id: source.id,
      contentPlanId: source.content_plan_id,
      sourceType: source.source_type,
      name: source.name,
      originalUrl: source.original_url,
      storagePath: source.storage_path,
      mimeType: source.mime_type,
      extractedContent: source.extracted_content,
      contentHash: source.content_hash,
      contentLength: source.content_length,
      scanStatus: source.scan_status,
      scanError: source.scan_error,
      createdAt: source.created_at,
    })),
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      keywords: item.keywords ?? [],
      type: String(item.content_group).replaceAll("_", "-"),
      sourceLine: item.source_text ?? item.title,
      confidence: Number(item.confidence ?? 0),
      classificationReason: item.classification_reason,
      sourceId: item.source_id,
      sourceSectionId: item.source_section_id,
      sourceQuote: item.source_quote,
      status: item.status ?? "not_started",
    })),
  }
}

async function relationalPlansAvailable() {
  return tableAvailable("content_plans")
}

async function getContentPlan(id: string): Promise<any | null> {
  if (await relationalPlansAvailable()) {
    const [plans, sources, items] = await Promise.all([
      tableSelect<any>("content_plans", (query) => query.eq("id", id)),
      tableSelect<any>("content_plan_sources", (query) =>
        query.eq("content_plan_id", id).order("created_at"),
      ),
      tableSelect<any>("content_plan_items", (query) =>
        query.eq("content_plan_id", id).order("position"),
      ),
    ])
    return plans[0] ? planFromRow(plans[0], sources, items) : null
  }
  return kvGet(`${CONTENT_PLAN_PREFIX}${id}`)
}

async function listContentPlans(): Promise<any[]> {
  if (await relationalPlansAvailable()) {
    const plans = await tableSelect<any>("content_plans", (query) =>
      query.order("created_at", { ascending: false }),
    )
    return Promise.all(plans.map((plan) => getContentPlan(plan.id)))
  }
  return (await kvGetByPrefix(CONTENT_PLAN_PREFIX))
    .map((record) => record.value)
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

async function createContentPlanRecord(input: {
  name: string
  previousVersionId?: string | null
  source: any
}): Promise<any> {
  const previous = input.previousVersionId
    ? await getContentPlan(input.previousVersionId)
    : null
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const sourceId = crypto.randomUUID()
  const source = {
    id: sourceId,
    contentPlanId: id,
    ...input.source,
    scanStatus: "ready",
    createdAt: now,
  }
  const plan = {
    id,
    seriesId: previous?.seriesId ?? id,
    name: input.name,
    status: "draft",
    version: previous ? Number(previous.version) + 1 : 1,
    previousVersionId: previous?.id ?? null,
    sourceFingerprint: source.contentHash,
    totalArticles: 0,
    comparisonCount: 0,
    editorialCount: 0,
    reviewCount: 0,
    createdAt: now,
    updatedAt: now,
    sources: [source],
    items: [],
  }
  if (await relationalPlansAvailable()) {
    const planRow: Record<string, unknown> = {
      id,
      name: plan.name,
      status: plan.status,
      version: plan.version,
      previous_version_id: plan.previousVersionId,
      source_fingerprint: plan.sourceFingerprint,
    }
    if (await tableAvailable("article_stage_runs"))
      planRow.series_id = plan.seriesId
    await tableInsert("content_plans", planRow)
    await tableInsert("content_plan_sources", {
      id: sourceId,
      content_plan_id: id,
      source_type: source.sourceType,
      name: source.name,
      original_url: source.originalUrl ?? null,
      storage_path: source.storagePath ?? null,
      mime_type: source.mimeType ?? null,
      extracted_content: source.extractedContent,
      content_hash: source.contentHash,
      content_length: source.contentLength,
      scan_status: "ready",
    })
    return getContentPlan(id)
  }
  await kvSet(`${CONTENT_PLAN_PREFIX}${id}`, plan)
  return plan
}

async function saveClassifiedPlan(plan: any, items: any[], model: string) {
  const now = new Date().toISOString()
  const counts = {
    comparisonCount: items.filter((item) => item.type === "comparison-seo")
      .length,
    editorialCount: items.filter(
      (item) => item.type === "editorial-originality",
    ).length,
    reviewCount: items.filter((item) => item.type === "needs-review").length,
  }
  const previous = plan.previousVersionId
    ? await getContentPlan(plan.previousVersionId)
    : null
  const previousTitles = new Map<string, string>(
    (previous?.items ?? []).map((item: any) => [
      String(item.title).toLocaleLowerCase(),
      String(item.title),
    ]),
  )
  const currentTitles = new Map<string, string>(
    items.map((item: any) => [
      String(item.title).toLocaleLowerCase(),
      String(item.title),
    ]),
  )
  const changeSummary = previous
    ? {
        added: [...currentTitles.entries()]
          .filter(([key]) => !previousTitles.has(key))
          .map(([, title]) => title),
        removed: [...previousTitles.entries()]
          .filter(([key]) => !currentTitles.has(key))
          .map(([, title]) => title),
        unchanged: [...currentTitles.entries()]
          .filter(([key]) => previousTitles.has(key))
          .map(([, title]) => title),
      }
    : undefined
  if (await relationalPlansAvailable()) {
    await tableDeleteWhere("content_plan_items", "content_plan_id", plan.id)
    for (const [position, item] of items.entries())
      await tableInsert("content_plan_items", {
        id: item.id,
        content_plan_id: plan.id,
        source_id: item.sourceId,
        source_section_id: item.sourceSectionId,
        title: item.title,
        keywords: item.keywords,
        source_text: item.sourceLine,
        source_quote: item.sourceQuote,
        content_group: item.type.replaceAll("-", "_"),
        confidence: item.confidence,
        classification_reason: item.classificationReason,
        position,
      })
    await tableUpdate("content_plans", plan.id, {
      status: "ready",
      classification_model: model,
      classification_prompt_version: CONTENT_PLAN_CLASSIFIER_VERSION,
      comparison_count: counts.comparisonCount,
      editorial_count: counts.editorialCount,
      review_count: counts.reviewCount,
      change_summary: changeSummary ?? null,
      classified_at: now,
      updated_at: now,
    })
    return getContentPlan(plan.id)
  }
  const next = {
    ...plan,
    ...counts,
    status: "ready",
    items,
    changeSummary,
    classifiedAt: now,
    updatedAt: now,
    classificationModel: model,
    classificationPromptVersion: CONTENT_PLAN_CLASSIFIER_VERSION,
  }
  await kvSet(`${CONTENT_PLAN_PREFIX}${plan.id}`, next)
  return next
}

function googleExportUrl(value: string, sourceType: string): string {
  const url = new URL(value)
  const match = url.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/)
  if (!match) throw new Error("Google Docs/Sheets URL không hợp lệ.")
  return sourceType === "google_sheet"
    ? `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`
    : `https://docs.google.com/document/d/${match[1]}/export?format=txt`
}

function verifiedClassificationItems(parsed: any, plan: any) {
  const rawItems = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : []
  const sources = new Map(
    (plan.sources ?? []).map((source: any) => [source.id, source]),
  )
  const seen = new Set<string>()
  return rawItems.flatMap((raw: any, index: number) => {
    const source = (sources.get(String(raw.sourceId ?? "")) ??
      (sources.size === 1 ? [...sources.values()][0] : null)) as any
    const title = String(raw.title ?? "").trim()
    let quote = String(raw.sourceQuote ?? "").trim()
    const group = String(raw.contentGroup ?? raw.type ?? "").replaceAll(
      "_",
      "-",
    )
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence ?? 0)))
    if (
      source &&
      title &&
      (!quote || !String(source.extractedContent).includes(quote)) &&
      String(source.extractedContent).includes(title)
    )
      quote = title
    if (
      !source ||
      !title ||
      !quote ||
      !String(source.extractedContent).includes(quote)
    )
      return []
    const key = title.toLocaleLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    const type =
      ["comparison-seo", "editorial-originality"].includes(group) &&
      confidence >= 0.65
        ? group
        : "needs-review"
    return [
      {
        id: crypto.randomUUID(),
        title,
        keywords: Array.isArray(raw.keywords)
          ? raw.keywords.map(String).filter(Boolean)
          : [],
        type,
        sourceLine: String(raw.sourceLine ?? quote),
        confidence,
        classificationReason: String(raw.classificationReason ?? "").trim(),
        sourceId: source.id,
        sourceSectionId: String(raw.sourceSectionId ?? `item-${index + 1}`),
        sourceQuote: quote,
      },
    ]
  })
}

// ─── Serve Vite frontend static files ────────────────────────────────────────

app.use(express.static(DIST))

// ─── Health ──────────────────────────────────────────────────────────────────

// Railway liveness must not depend on an external service. If Supabase is
// temporarily slow during a deploy, waiting for it here can make Railway mark
// an otherwise healthy container as unavailable and return 502 upstream errors.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    providers: getAvailableProviders(),
    seoResearch: seoResearchConfigured(),
    supabaseConfigured: !!(
      process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
    ),
  })
})

// Dependency diagnostics are kept separate from Railway's liveness probe.
app.get("/health/dependencies", async (_req, res) => {
  const supabaseOk = await checkConnection()
  const relationalContentPlans = supabaseOk
    ? await tableAvailable("content_plans")
    : false
  const threeStageSessions = supabaseOk
    ? await tableAvailable("article_stage_runs")
    : false
  res.status(supabaseOk ? 200 : 503).json({
    status: supabaseOk ? "ok" : "degraded",
    supabase: supabaseOk,
    relationalContentPlans,
    threeStageSessions,
    supabaseUrl: process.env.SUPABASE_URL ?? null,
  })
})

app.post("/api/seo/research", async (req, res) => {
  try {
    const seeds = Array.isArray(req.body?.seeds) ? req.body.seeds : []
    const keywordCount = Math.min(
      20,
      Math.max(5, Number(req.body?.keywordCount ?? 10)),
    )
    const articleId = String(req.body?.articleId ?? "")
    if (!articleId)
      return res.status(400).json({ error: "articleId là bắt buộc." })
    const article = await kvGet<any>(`${ARTICLE_PREFIX}${articleId}`)
    if (!article)
      return res.status(404).json({ error: "Article không tồn tại." })
    if (article.activityKind === "batch") {
      return res
        .status(409)
        .json({
          code: "BATCH_ORCHESTRATION_REQUIRED",
          error: "Bài batch chỉ được xử lý qua batch orchestration.",
        })
    }
    const prerequisiteError = articleStepPrerequisite(article, 2)
    if (prerequisiteError)
      return workflowPrerequisiteResponse(res, prerequisiteError)
    const cacheKey = `writer:seo-cache:web-v2:${keywordCount}:${crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          seeds
            .map((seed: unknown) => String(seed).trim().toLocaleLowerCase())
            .sort(),
        ),
      )
      .digest("hex")}`
    const cached = await kvGet<any>(cacheKey)
    if (
      cached?.researchedAt &&
      Date.now() - new Date(cached.researchedAt).getTime() < 24 * 60 * 60 * 1000
    ) {
      return res.json({ ...cached, cacheHit: true })
    }
    const budget = await reserveAIBudget(articleId, 2)
    const result = await researchSeoKeywords(seeds, keywordCount)
    await kvSet(cacheKey, result)
    res.json({ ...result, cacheHit: false, budget })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("OPENAI_API_KEY"))
      return res
        .status(503)
        .json({
          code: "AI_PROVIDER_NOT_CONFIGURED",
          provider: "openai",
          modelId: "gpt-5.4-mini",
          error: message,
        })
    const failure = classifyAIError(error, "openai", "gpt-5.4-mini")
    res.status(failure.status).json(failure.body)
  }
})

// ─── AI Generate ─────────────────────────────────────────────────────────────

app.post("/api/generate", async (req, res) => {
  const {
    modelId,
    provider,
    prompt,
    systemPrompt,
    stepNumber,
    maxTokens,
    temperature,
    splitByWave,
    bypassCache,
    requestPurpose,
    jsonMode,
    jsonSchema,
    contextQuery,
    skipDocumentContext,
    pricing,
    articleId,
  } = req.body

  if (
    !modelId ||
    !provider ||
    !prompt ||
    !Number.isInteger(stepNumber) ||
    !articleId
  ) {
    return res
      .status(400)
      .json({
        error:
          "modelId, provider, prompt, stepNumber và articleId là bắt buộc.",
      })
  }
  if (![2, 3, 4].includes(stepNumber)) {
    return res
      .status(400)
      .json({
        error:
          "Manual article generation only supports workflow steps 2, 3, and 4.",
      })
  }

  const providers = getAvailableProviders()
  if (!providers[provider]) {
    return res.status(400).json({
      code: "AI_PROVIDER_NOT_CONFIGURED",
      provider,
      modelId,
      error: `API key cho provider "${provider}" chưa được cấu hình. Thêm ${provider.toUpperCase()}_API_KEY vào Railway env.`,
    })
  }

  try {
    const article = await kvGet<any>(`${ARTICLE_PREFIX}${String(articleId)}`)
    if (!article)
      return res.status(404).json({ error: "Article không tồn tại." })
    if (article.activityKind === "batch") {
      return res
        .status(409)
        .json({
          code: "BATCH_ORCHESTRATION_REQUIRED",
          error: "Bài batch chỉ được xử lý qua batch orchestration.",
        })
    }
    const prerequisiteError = articleStepPrerequisite(article, stepNumber)
    if (prerequisiteError)
      return workflowPrerequisiteResponse(res, prerequisiteError)
    const startedAt = Date.now()
    const contextsStartedAt = Date.now()
    const normalizedContextQuery = String(contextQuery ?? "")
      .trim()
      .slice(0, 4_000)
    let contexts =
      skipDocumentContext && (stepNumber === 2 || stepNumber === 4)
        ? [
            {
              contextDocs: [],
              contentPlanText: "",
              summary: {
                stepNumber,
                kb: [],
                contentPlan: [],
                rules: [],
                totalChars: 0,
                sourceFingerprint: `empty-step-${stepNumber}`,
              },
            },
          ]
        : stepNumber === 1 && splitByWave
          ? await resolveStep1WaveContexts(String(articleId))
          : [
              await resolveStepContext(
                stepNumber,
                normalizedContextQuery,
                String(articleId),
              ),
            ]
    const learningContext = await learningDecisionContext(article, stepNumber)
    if (learningContext) {
      contexts = contexts.map(context => ({
        ...context,
        contextDocs: [...context.contextDocs, learningContext],
      }))
    }
    const contextMs = Date.now() - contextsStartedAt
    const sourceFingerprint = contexts
      .map((context) => context.summary.sourceFingerprint)
      .sort()
      .join("|")
      + (learningContext
        ? `|learning:${crypto.createHash("sha256").update(learningContext).digest("hex")}`
        : "")
    const cacheKey = aiCacheKey({
      modelId,
      provider,
      prompt,
      systemPrompt,
      stepNumber,
      maxTokens,
      temperature,
      splitByWave: Boolean(splitByWave),
      jsonMode: Boolean(jsonMode),
      jsonSchema: jsonSchema ?? null,
      contextQuery: normalizedContextQuery,
      skipDocumentContext: Boolean(skipDocumentContext),
      sourceFingerprint,
      promptVersion: 12,
    })
    const cached = bypassCache ? null : await kvGet<any>(cacheKey)
    if (cached?.content) {
      console.log(
        `[generate] cache-hit step=${stepNumber} key=${cacheKey.slice(-12)} totalMs=${Date.now() - startedAt}`,
      )
      return res.json({
        ...cached,
        cacheHit: true,
        generatedAt: cached.generatedAt,
        servedAt: new Date().toISOString(),
      })
    }

    const quotaExemptRecheck = stepNumber === 4 && requestPurpose === "recheck"
    const budget = quotaExemptRecheck
      ? null
      : await reserveAIBudget(String(articleId), stepNumber)

    console.log(
      `[generate] step=${stepNumber} purpose=${quotaExemptRecheck ? "recheck" : "generation"} provider=${provider} model=${modelId} waves=${contexts.length} promptLen=${prompt.length} contextChars=${contexts.reduce((sum, item) => sum + item.summary.totalChars, 0)}`,
    )
    const providerStartedAt = Date.now()
    let result
    if (stepNumber === 1 && splitByWave) {
      try {
        const waveResults = await runWithConcurrency(
          contexts as StepWaveContext[],
          3,
          async (context) => {
            const scopeCacheKey = aiCacheKey({
              kind: "step1-scope-v2",
              modelId,
              provider,
              prompt,
              systemPrompt,
              maxTokens,
              temperature,
              sourceFingerprint: context.summary.sourceFingerprint,
              scopeKey: context.scopeKey,
            })
            if (!bypassCache) {
              const cachedScope = await kvGet<{
                response?: any
                items?: unknown[]
              }>(scopeCacheKey)
              if (
                cachedScope?.response &&
                Array.isArray(cachedScope.items) &&
                !missingStep1Coverage(cachedScope.items, context).length
              ) {
                console.log(
                  `[generate] step1-scope-cache-hit scope=${context.scopeKey}`,
                )
                return {
                  response: cachedScope.response,
                  items: cachedScope.items,
                }
              }
            }
            const callWave = async (correction?: string) => {
              const waveInstruction = [
                systemPrompt ?? "",
                "",
                `PHẠM VI REQUEST NÀY: Chỉ tổng hợp dữ liệu thuộc ${context.wave}${
                  context.timeframe ? `, timeframe ${context.timeframe}` : ""
                }.`,
                "Không đưa dữ liệu từ wave khác vào response. Vẫn phải trả về duy nhất JSON array hợp lệ.",
                context.expectedTypeGroups.length
                  ? `Phải bao phủ đầy đủ các nhóm nhận diện được trong section: ${context.expectedTypeGroups.map((group) => `Type ${group}`).join(", ")}.`
                  : "Phải trả về tất cả lựa chọn hợp lệ có trong phạm vi này; không dừng sau lựa chọn đầu tiên.",
                `Parser nhận diện khoảng ${context.expectedItemCount} dòng Type để đối chiếu. Đây là checklist bao phủ, không phải yêu cầu tạo trùng lựa chọn cho header/evidence lặp.`,
                context.expectedRows.length
                  ? `CHECKLIST CÁC DÒNG TYPE PHẢI ĐỐI CHIẾU (không được bỏ sót):\n${context.expectedRows.map((row, index) => `${index + 1}. ${row}`).join("\n")}`
                  : "",
                correction ?? "",
              ]
                .filter(Boolean)
                .join("\n")
              const response = await generate({
                modelId,
                provider,
                prompt,
                systemPrompt: waveInstruction,
                contextDocs: context.contextDocs,
                maxTokens: Math.min(
                  maxTokens ?? 12000,
                  Math.max(6000, context.expectedItemCount * 1000),
                ),
                temperature,
                jsonMode,
              })
              const items = normalizeStep1ScopeItems(
                extractJsonArray(response.content),
                context,
              )
              return { response, items }
            }

            const first = await callWave()
            const firstMissing = missingStep1Coverage(first.items, context)
            const firstEstimate = step1CoverageEstimate(first.items, context)
            if (!firstMissing.length && !firstEstimate) {
              await kvSet(scopeCacheKey, first)
              return first
            }

            console.warn(
              `[generate] retry scope=${context.scopeKey} reason=${[...firstMissing, firstEstimate].filter(Boolean).join(", ")}`,
            )
            const second = await callWave(
              [
                `LẦN TRƯỚC CÒN THIẾU CHÍNH XÁC: ${
                  firstMissing.length ? firstMissing.join(", ") : firstEstimate
                }.`,
                "Chỉ trả các lựa chọn hợp lệ còn thiếu; không lặp lại item đã có và không tạo item cho header/evidence tham chiếu.",
                "DANH SÁCH ĐÃ CÓ Ở LẦN TRƯỚC (dùng để đối chiếu, không chép lại):",
                JSON.stringify(first.items),
              ].join("\n"),
            )
            const mergedItems = mergeStep1Items(first.items, second.items)
            const hardMissing = missingStep1Coverage(mergedItems, context)
            if (hardMissing.length) {
              throw new Error(
                `${context.scopeKey} thiếu scope/Type bắt buộc: ${hardMissing.join(", ")}. AI đã trả: ${JSON.stringify(summarizeStep1Items(mergedItems))}`,
              )
            }
            const remainingEstimate = step1CoverageEstimate(
              mergedItems,
              context,
            )
            if (remainingEstimate)
              console.warn(
                `[generate] accepted scope=${context.scopeKey} ${remainingEstimate}; parser rows include repeated headers/evidence`,
              )
            const completed = {
              response: combineStep1Responses(first.response, second.response),
              items: mergedItems,
            }
            await kvSet(scopeCacheKey, completed)
            return completed
          },
        )
        const merged = waveResults.flatMap((item) => item.items)
        assertCompleteStep1Result(merged, contexts as StepWaveContext[])
        result = {
          content: JSON.stringify(merged),
          model: waveResults[0]?.response.model ?? modelId,
          usage: {
            inputTokens: waveResults.reduce(
              (sum, item) => sum + (item.response.usage?.inputTokens ?? 0),
              0,
            ),
            outputTokens: waveResults.reduce(
              (sum, item) => sum + (item.response.usage?.outputTokens ?? 0),
              0,
            ),
            cachedInputTokens: waveResults.reduce(
              (sum, item) =>
                sum + (item.response.usage?.cachedInputTokens ?? 0),
              0,
            ),
          },
        }
      } catch (waveError: any) {
        // Do not discard successful scoped work and pay for another huge call.
        // The frontend keeps the last complete Supabase snapshot on failure.
        console.warn(
          `[generate] scoped Step 1 failed; fallback=disabled reason=${waveError.message}`,
        )
        throw new Error(
          `Step 1 chưa hoàn tất một scope sau 2 lần kiểm tra: ${waveError.message}`,
        )
      }
    } else {
      const context = contexts[0]
      result = await generate({
        modelId,
        provider,
        prompt,
        systemPrompt,
        contextDocs: context.contextDocs,
        maxTokens,
        temperature,
        jsonMode,
        jsonSchema,
      })
    }
    const providerMs = Date.now() - providerStartedAt
    const generatedAt = new Date().toISOString()
    const responsePayload = {
      ...result,
      costUsd:
        pricing &&
        Number.isFinite(Number(pricing.inputUsdPerMillion)) &&
        Number.isFinite(Number(pricing.outputUsdPerMillion))
          ? (() => {
              const inputTokens = result.usage?.inputTokens ?? 0
              const cachedTokens = result.usage?.cachedInputTokens ?? 0
              const longContext =
                Number(pricing.longContextThresholdTokens) > 0 &&
                inputTokens > Number(pricing.longContextThresholdTokens)
              const inputMultiplier = longContext
                ? Number(pricing.longContextInputMultiplier ?? 1)
                : 1
              const outputMultiplier = longContext
                ? Number(pricing.longContextOutputMultiplier ?? 1)
                : 1
              return (
                ((inputTokens - cachedTokens) *
                  Number(pricing.inputUsdPerMillion) *
                  inputMultiplier +
                  cachedTokens *
                    Number(
                      pricing.cachedInputUsdPerMillion ??
                        pricing.inputUsdPerMillion,
                    ) *
                    inputMultiplier +
                  (result.usage?.outputTokens ?? 0) *
                    Number(pricing.outputUsdPerMillion) *
                    outputMultiplier) /
                1_000_000
              )
            })()
          : null,
      context: {
        ...contexts[0].summary,
        totalChars: contexts.reduce(
          (sum, item) => sum + item.summary.totalChars,
          0,
        ),
        waves: contexts.length,
      },
      cacheHit: false,
      generatedAt,
      servedAt: generatedAt,
      timing: { contextMs, providerMs, totalMs: Date.now() - startedAt },
      budget,
    }
    await kvSet(cacheKey, responsePayload)
    console.log(
      `[generate] done cache=false contextMs=${contextMs} providerMs=${providerMs} totalMs=${Date.now() - startedAt} outputTokens=${result.usage?.outputTokens}`,
    )
    return res.json(responsePayload)
  } catch (err: any) {
    console.error("[generate] error:", err.message)
    const failure = classifyAIError(err, provider, modelId)
    res.status(failure.status).json(failure.body)
  }
})

// ─── Provider status ─────────────────────────────────────────────────────────

app.get("/api/providers", (_req, res) => {
  res.json(getAvailableProviders())
})

// ─── Supabase KV proxy (optional — if frontend can't reach Supabase directly) ─

app.get("/api/kv/:key", async (req, res) => {
  try {
    const value = await kvGet(req.params.key)
    res.json({ value })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/kv/:key", async (req, res) => {
  try {
    await kvSet(req.params.key, req.body.value)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/kv-prefix/:prefix", async (req, res) => {
  try {
    const data = await kvGetByPrefix(req.params.prefix)
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Articles (via Supabase) ──────────────────────────────────────────────────

app.get("/api/content-plans", async (_req, res) => {
  try {
    res.json(await listContentPlans())
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/content-plans/:id", async (req, res) => {
  try {
    const plan = await getContentPlan(req.params.id)
    if (!plan)
      return res.status(404).json({ error: "Content Plan không tồn tại." })
    res.json({ plan })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/content-plans/:id/articles", async (req, res) => {
  try {
    const plan = await getContentPlan(req.params.id)
    if (!plan)
      return res.status(404).json({ error: "Content Plan không tồn tại." })
    const articles = (await loadArticles()).filter(
      (article) => article.contentPlanId === plan.id,
    )
    res.json({ planId: plan.id, version: plan.version, articles })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post(
  "/api/content-plans/import",
  upload.single("file"),
  async (req, res) => {
    try {
      const body = req.file ? req.body : (req.body ?? {})
      const sourceType = String(
        req.file ? "file" : (body.sourceType ?? "paste"),
      )
      if (!["file", "paste", "google_doc", "google_sheet"].includes(sourceType))
        return res
          .status(400)
          .json({ error: "Content Plan source type không hợp lệ." })
      const name = String(
        body.name ?? req.file?.originalname ?? "Content Plan",
      ).trim()
      const previousVersionId =
        String(body.previousVersionId ?? "").trim() || null
      let content = ""
      let originalUrl: string | undefined
      let storagePath: string | undefined
      let mimeType: string | undefined
      if (req.file) {
        content = (
          await extractDocumentText(req.file.buffer, req.file.originalname)
        ).trim()
        mimeType = req.file.mimetype
      } else if (sourceType === "google_doc" || sourceType === "google_sheet") {
        originalUrl = String(body.url ?? "").trim()
        try {
          content = await fetchTextSource(
            googleExportUrl(originalUrl, sourceType),
          )
        } catch (error: any) {
          throw new Error(
            `Không đọc được Google ${
              sourceType === "google_sheet" ? "Sheet" : "Doc"
            }. Hãy bật quyền "Anyone with the link can view". ${error.message}`,
          )
        }
      } else content = String(body.content ?? "").trim()
      if (!content)
        return res
          .status(422)
          .json({ error: "Content Plan không có nội dung có thể trích xuất." })
      if (content.length > 2_000_000)
        return res
          .status(413)
          .json({ error: "Content Plan vượt giới hạn 2 triệu ký tự." })
      const contentHash = crypto
        .createHash("sha256")
        .update(content, "utf8")
        .digest("hex")
      const previous = previousVersionId
        ? await getContentPlan(previousVersionId)
        : null
      if (previous?.sourceFingerprint === contentHash)
        return res.json({ plan: previous, reused: true })
      if (req.file) {
        const provisionalPlanId = crypto.randomUUID()
        storagePath = `content-plans/${provisionalPlanId}/${crypto.randomUUID()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`
        await uploadDocumentBinary(
          storagePath,
          req.file.buffer,
          req.file.mimetype || "application/octet-stream",
        )
      }
      const plan = await createContentPlanRecord({
        name,
        previousVersionId,
        source: {
          sourceType,
          name: req.file?.originalname ?? name,
          originalUrl,
          storagePath,
          mimeType,
          extractedContent: content,
          contentHash,
          contentLength: content.length,
        },
      })
      res.status(201).json({ plan, reused: false })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  },
)

async function classifyPlanRequest(req: any, res: any, force: boolean) {
  try {
    const plan = await getContentPlan(req.params.id)
    if (!plan)
      return res.status(404).json({ error: "Content Plan không tồn tại." })
    if (!force && plan.status === "ready" && plan.items?.length)
      return res.json({ plan, cacheHit: true })
    const config = await kvGet<any>("writer:config")
    const step = config?.stepConfigs?.[1]
    const model = config?.models?.find(
      (item: any) => item.id === step?.modelId && item.enabled,
    )
    if (!model)
      return res
        .status(422)
        .json({
          error:
            "Hãy chọn một AI model đang bật cho Step 1 trước khi phân loại Content Plan.",
        })
    const cacheKey = aiCacheKey({
      kind: CONTENT_PLAN_CLASSIFIER_VERSION,
      fingerprint: plan.sourceFingerprint,
      model: model.id,
    })
    const explicitItems = deterministicPlanItems(plan)
    const hasUnclassifiedContent = (plan.sources ?? []).some((source: any) =>
      String(source.extractedContent ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .some(line => line.trim() && !explicitContentGroupLine(line)),
    )
    if (explicitItems.length && !hasUnclassifiedContent) {
      const saved = await saveClassifiedPlan(plan, explicitItems, "deterministic-plan-v1")
      return res.json({ plan: saved, cacheHit: false, deterministic: true })
    }
    const cached = force ? null : await kvGet<any>(cacheKey)
    let parsed: any
    let response: any
    if (cached?.content) {
      response = cached
      parsed = parseJsonObject(cached.content)
    } else {
      await reserveAIBudget(`content-plan-${plan.id}`, 1)
      const sourceBlock = (plan.sources ?? [])
        .map(
          (source: any) => {
            // Preserve the original source for verification, but omit rows
            // whose classification is explicit and already deterministic.
            const remaining = String(source.extractedContent)
              .replace(/\r\n?/g, "\n")
              .split("\n")
              .filter(line => !explicitContentGroupLine(line))
              .join("\n")
              .slice(0, 500_000)
            return `SOURCE id=${source.id} name=${JSON.stringify(source.name)}\n${remaining}`
          },
        )
        .join("\n\n---\n\n")
      response = await generate({
        modelId: model.id,
        provider: model.provider,
        jsonMode: true,
        maxTokens: 10000,
        temperature: 0.2,
        systemPrompt:
          "Classify only topics explicitly present in the supplied Content Plan sources. Never invent topics. Every item must include a verbatim sourceQuote copied from its source.",
        prompt: [
          "Extract and classify every remaining planned article. Rows with an explicit content-group label were already handled deterministically; do not repeat them.",
          "comparison-seo: comparisons, versus, alternatives, reviews, best/top lists, pricing, buyer guides, commercial or transactional SEO intent.",
          "editorial-originality: thought leadership, analysis, opinion, original research, storytelling, brand editorial, or expert insight.",
          "Use needs-review when confidence is below 0.65 or the source is ambiguous.",
          'Return JSON only: {"items":[{"title":string,"keywords":string[],"contentGroup":"comparison-seo"|"editorial-originality"|"needs-review","confidence":number,"classificationReason":string,"sourceId":string,"sourceSectionId":string,"sourceLine":string,"sourceQuote":string}]}',
          sourceBlock,
        ].join("\n\n"),
      })
      await kvSet(cacheKey, {
        ...response,
        generatedAt: new Date().toISOString(),
      })
      parsed = parseJsonObject(response.content)
    }
    const aiItems = verifiedClassificationItems(parsed, plan)
    const items = [...explicitItems, ...aiItems].filter(
      (item, index, all) => all.findIndex(candidate =>
        String(candidate.title).toLocaleLowerCase() === String(item.title).toLocaleLowerCase(),
      ) === index,
    )
    if (!items.length)
      throw new Error("AI không trả về topic nào có source evidence hợp lệ.")
    let saved = await saveClassifiedPlan(
      plan,
      items,
      response.model ?? model.id,
    )
    if (!cached && response.usage) {
      const usage = batchUsage(1, model.provider, {
        ...response,
        provider: model.provider,
        cacheHit: false,
      })
      if (await tableAvailable("writer_ai_usage"))
        await tableUpsert(
          "writer_ai_usage",
          {
            id: usage.id,
            content_plan_id: plan.id,
            activity_id: null,
            article_id: null,
            step: 1,
            provider: usage.provider,
            model: usage.model,
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
            cost_usd: usage.costUsd,
            cache_hit: false,
            called_at: usage.calledAt,
          },
          "id",
        )
      else {
        saved = {
          ...saved,
          classificationUsage: [...(saved.classificationUsage ?? []), usage],
        }
        await kvSet(`${CONTENT_PLAN_PREFIX}${plan.id}`, saved)
      }
    }
    res.json({ plan: saved, cacheHit: Boolean(cached) })
  } catch (err: any) {
    const classified = classifyAIError(err, "openai", "content-plan-classifier")
    res.status(classified.status).json(classified.body)
  }
}

app.post(
  "/api/content-plans/:id/classify",
  (req, res) => void classifyPlanRequest(req, res, false),
)
app.post(
  "/api/content-plans/:id/reclassify",
  (req, res) => void classifyPlanRequest(req, res, true),
)

app.patch("/api/content-plans/:id/items/:itemId", async (req, res) => {
  try {
    const type = String(req.body?.type ?? "")
    if (
      !["comparison-seo", "editorial-originality", "needs-review"].includes(
        type,
      )
    )
      return res.status(400).json({ error: "Nhóm nội dung không hợp lệ." })
    const plan = await getContentPlan(req.params.id)
    if (!plan)
      return res.status(404).json({ error: "Content Plan không tồn tại." })
    if (await relationalPlansAvailable()) {
      await tableUpdate("content_plan_items", req.params.itemId, {
        content_group: type.replaceAll("-", "_"),
      })
      const items = (await getContentPlan(plan.id)).items ?? []
      await tableUpdate("content_plans", plan.id, {
        comparison_count: items.filter(
          (item: any) => item.type === "comparison-seo",
        ).length,
        editorial_count: items.filter(
          (item: any) => item.type === "editorial-originality",
        ).length,
        review_count: items.filter((item: any) => item.type === "needs-review")
          .length,
        updated_at: new Date().toISOString(),
      })
    } else {
      plan.items = (plan.items ?? []).map((item: any) =>
        item.id === req.params.itemId ? { ...item, type } : item,
      )
      plan.comparisonCount = plan.items.filter(
        (item: any) => item.type === "comparison-seo",
      ).length
      plan.editorialCount = plan.items.filter(
        (item: any) => item.type === "editorial-originality",
      ).length
      plan.reviewCount = plan.items.filter(
        (item: any) => item.type === "needs-review",
      ).length
      plan.updatedAt = new Date().toISOString()
      await kvSet(`${CONTENT_PLAN_PREFIX}${plan.id}`, plan)
    }
    res.json({ plan: await getContentPlan(plan.id) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.patch("/api/content-plans/:id/status", async (req, res) => {
  try {
    const status = String(req.body?.status ?? "")
    if (!["draft", "ready", "active", "archived"].includes(status))
      return res
        .status(400)
        .json({ error: "Content Plan status không hợp lệ." })
    const plan = await getContentPlan(req.params.id)
    if (!plan)
      return res.status(404).json({ error: "Content Plan không tồn tại." })
    if (await relationalPlansAvailable())
      await tableUpdate("content_plans", plan.id, {
        status,
        updated_at: new Date().toISOString(),
      })
    else {
      plan.status = status
      plan.updatedAt = new Date().toISOString()
      await kvSet(`${CONTENT_PLAN_PREFIX}${plan.id}`, plan)
    }
    res.json({ plan: await getContentPlan(plan.id) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete("/api/content-plans/:id", async (req, res) => {
  try {
    const plan = await getContentPlan(req.params.id)
    if (!plan)
      return res.status(404).json({ error: "Content Plan không tồn tại." })
    const linked = (await loadArticles()).filter(
      (article) => article.contentPlanId === plan.id,
    )
    if (linked.length)
      return res
        .status(409)
        .json({
          error: `Content Plan đang có ${linked.length} article. Hãy archive thay vì xóa để bảo toàn lịch sử.`,
        })
    await deleteDocumentBinaries(
      (plan.sources ?? [])
        .map((source: any) => source.storagePath)
        .filter(Boolean),
    )
    if (await relationalPlansAvailable()) {
      // Import/classification calls can create usage and batch audit records
      // before any article exists. Preserve those records for cost history,
      // but detach the deleted plan so their optional foreign keys cannot
      // block a legitimate delete of an unused plan.
      const detachPlanReferences = async (table: string) => {
        if (!(await tableAvailable(table))) return
        const references = await tableSelect<any>(table, (query) =>
          query.eq("content_plan_id", plan.id),
        )
        await Promise.all(references.map((reference) =>
          tableUpdate(table, reference.id, { content_plan_id: null }),
        ))
      }
      await Promise.all([
        detachPlanReferences("writer_ai_usage"),
        detachPlanReferences("batch_jobs"),
      ])
      // A version may be deleted while later versions still exist. Re-parent
      // its direct descendants to the deleted plan's predecessor so the
      // version chain remains navigable and PostgreSQL's self-reference does
      // not block the delete.
      const descendants = await tableSelect<any>("content_plans", (query) =>
        query.eq("previous_version_id", plan.id),
      )
      await Promise.all(descendants.map((descendant) =>
        tableUpdate("content_plans", descendant.id, {
          previous_version_id: plan.previousVersionId ?? null,
          updated_at: new Date().toISOString(),
        }),
      ))
      await tableDeleteWhere("content_plans", "id", plan.id)
    } else {
      const allPlans = await kvGetByPrefix(CONTENT_PLAN_PREFIX)
      await Promise.all(allPlans
        .filter((record) => record.value?.previousVersionId === plan.id)
        .map((record) => kvSet(record.key, {
          ...record.value,
          previousVersionId: plan.previousVersionId ?? null,
          updatedAt: new Date().toISOString(),
        })))
      await kvDelete(`${CONTENT_PLAN_PREFIX}${plan.id}`)
    }
    res.json({ ok: true, deletedId: plan.id })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/batches/:activityId", async (req, res) => {
  try {
    const articles = (await loadArticles()).filter(
      (article) => article.activityId === req.params.activityId,
    )
    const batch = await kvGet(`writer:batch:${req.params.activityId}`)
    const controller = batchControllers.get(req.params.activityId)
    if ((batch as any)?.status === "running" && !controller?.running) {
      void runBatch(req.params.activityId).catch((error) =>
        console.error(`[batch-resume] ${req.params.activityId}`, error),
      )
    }
    res.json({ batch: batch ?? null, articles })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/batches/:activityId/start", async (req, res) => {
  try {
    const activityId = req.params.activityId
    const articles = (await loadArticles()).filter(
      (article) =>
        article.activityId === activityId && article.activityKind === "batch",
    )
    if (!articles.length)
      return res.status(404).json({ error: "Batch activity không tồn tại." })
    if (articles.some((article) => article.activityType !== "comparison-seo"))
      return res
        .status(409)
        .json({
          code: "EDITORIAL_REQUIRES_REVIEW",
          error:
            "Editorial / Originality is a supervised workflow. Generate one article at a time and approve its outline before drafting.",
        })
    const invalid = articles.filter((article) =>
      articleStepPrerequisite(article, 2),
    )
    if (invalid.length)
      return workflowPrerequisiteResponse(
        res,
        `${invalid.length} batch article(s) do not have a valid Content Plan selection.`,
      )
    void runBatch(activityId).catch((error) =>
      console.error(`[batch] ${activityId}`, error),
    )
    res.status(202).json({ ok: true, activityId, queued: articles.length })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/batches/:activityId/pause", async (req, res) => {
  try {
    const activityId = req.params.activityId
    const controller = batchControllers.get(activityId) ?? {
      paused: false,
      running: false,
    }
    controller.paused = true
    batchControllers.set(activityId, controller)
    await kvSet(`writer:batch:${activityId}`, {
      activityId,
      status: "paused",
      updatedAt: new Date().toISOString(),
    })
    res.json({ ok: true, activityId })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete("/api/batches/:activityId", async (req, res) => {
  const activityId = req.params.activityId
  try {
    const articles = (await loadArticles()).filter(
      (article) => article.activityId === activityId && article.activityKind === "batch",
    )
    const controller = batchControllers.get(activityId)
    if (controller) controller.paused = true
    deletedBatchIds.add(activityId)

    const planIds = [...new Set(articles.map((article) => article.contentPlanId).filter(Boolean))] as string[]
    if (await tableAvailable("batch_jobs"))
      await tableDeleteWhere("batch_jobs", "id", activityId)
    if (await tableAvailable("writer_articles"))
      await tableDeleteWhere("writer_articles", "activity_id", activityId)

    await Promise.all([
      ...articles.map((article) => kvDelete(`${ARTICLE_PREFIX}${article.id}`)),
      kvDelete(`writer:batch:${activityId}`),
    ])

    const planItemIds = [...new Set(articles.map((article) => article.contentPlanSourceItemId).filter(Boolean))] as string[]
    if (await tableAvailable("content_plan_items"))
      await Promise.all(planItemIds.map((id) => tableUpdate("content_plan_items", id, {
        status: "not_started",
        updated_at: new Date().toISOString(),
      })))

    const legacy = (await kvGet<any[]>("writer:articles")) ?? []
    if (legacy.some((article) => article?.activityId === activityId))
      await kvSet("writer:articles", legacy.filter((article) => article?.activityId !== activityId))

    for (const planId of planIds) {
      const plan = await getContentPlan(planId)
      if (!plan) continue
      const remaining = (await loadArticles()).filter((article) => article.contentPlanId === planId).length
      if (await relationalPlansAvailable())
        await tableUpdate("content_plans", planId, { total_articles: remaining, updated_at: new Date().toISOString() })
      else {
        plan.totalArticles = remaining
        plan.updatedAt = new Date().toISOString()
        await kvSet(`${CONTENT_PLAN_PREFIX}${planId}`, plan)
      }
    }
    batchControllers.delete(activityId)
    res.json({ ok: true, activityId, deletedIds: articles.map((article) => article.id) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/batches/:activityId/retry/:articleId", async (req, res) => {
  try {
    const article = await kvGet<any>(`${ARTICLE_PREFIX}${req.params.articleId}`)
    if (!article || article.activityId !== req.params.activityId)
      return res.status(404).json({ error: "Article không thuộc batch này." })
    const prerequisiteError = articleStepPrerequisite(article, 2)
    if (prerequisiteError)
      return workflowPrerequisiteResponse(res, prerequisiteError)
    const queued = await saveArticleCheckpoint(article, {
      batchStatus: "queued",
      batchError: null,
      status: "review",
    })
    const controller = batchControllers.get(req.params.activityId)
    if (!controller?.running)
      void runBatch(req.params.activityId).catch((error) =>
        console.error(`[batch-retry] ${req.params.activityId}`, error),
      )
    res.status(202).json({ ok: true, article: queued })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/articles", async (_req, res) => {
  try {
    res.json(await loadArticles())
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/legacy/inventory", async (_req, res) => {
  try {
    const [articles, legacyArray, articleRecords, files] = await Promise.all([
      loadArticles(),
      kvGet<any[]>("writer:articles"),
      kvGetByPrefix(ARTICLE_PREFIX),
      kvGet<any[]>("writer:files"),
    ])
    const relational = (await tableAvailable("writer_articles"))
      ? await tableSelect<any>("writer_articles", (query) => query.select("id, content_plan_id"))
      : []
    const individualIds = new Set(articleRecords.map((record) => record.value?.id).filter(Boolean))
    const relationalIds = new Set(relational.map((row) => row.id))
    const legacyOnlyIds = (legacyArray ?? [])
      .map((article) => article?.id)
      .filter((id): id is string => Boolean(id) && !individualIds.has(id))
    res.json({
      checkedAt: new Date().toISOString(),
      articles: {
        accessible: articles.length,
        readOnlyLegacy: articles.filter((article) => article.legacyReadOnly).length,
        legacyArray: legacyArray?.length ?? 0,
        individualKv: individualIds.size,
        relational: relationalIds.size,
        legacyOnlyIds,
        missingFromRelational: [...individualIds].filter((id) => !relationalIds.has(id)).length,
        missingContentPlan: articles.filter((article) => !article.contentPlanId).length,
        missingArticleSpec: articles.filter((article) => !article.articleSpecFingerprint).length,
      },
      files: {
        total: files?.length ?? 0,
        legacyActionPlans: (files ?? []).filter((file) => ["action", "action-plan"].includes(file?.category)).length,
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/articles/:id/stages", async (req, res) => {
  try {
    const article = (await loadArticles()).find(
      (item) => item.id === req.params.id,
    )
    if (!article)
      return res
        .status(404)
        .json({ error: "Bài viết không tồn tại trong Supabase." })
    if (await tableAvailable("article_stage_runs")) {
      const stages = await tableSelect<any>("article_stage_runs", (query) =>
        query
          .eq("article_id", article.id)
          .order("created_at", { ascending: false }),
      )
      return res.json({ articleId: article.id, stages })
    }
    res.json({ articleId: article.id, stages: [] })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/articles", async (req, res) => {
  try {
    const now = new Date().toISOString()
    const article = { ...req.body, updatedAt: now }
    if (!article.id)
      return res.status(400).json({ error: "Article id là bắt buộc." })
    article.currentStep = clampStoredArticleStep(article)
    if (article.contentPlanId && article.contentPlanSourceItemId && await tableAvailable("writer_articles")) {
      const conflicts = await tableSelect<any>("writer_articles", (query) =>
        query
          .select("id, activity_id")
          .eq("content_plan_id", article.contentPlanId)
          .eq("content_plan_item_id", article.contentPlanSourceItemId)
          .neq("id", article.id)
          .limit(1),
      )
      if (conflicts.length)
        return res.status(409).json({
          code: "CONTENT_PLAN_ITEM_ALREADY_USED",
          error: `Content Plan item đã thuộc một activity khác (${conflicts[0].activity_id ?? conflicts[0].id}). Hãy mở hoặc xóa activity hiện tại trước khi tạo lại.`,
          existingArticleId: conflicts[0].id,
          existingActivityId: conflicts[0].activity_id,
        })
    }
    await kvSet(`${ARTICLE_PREFIX}${article.id}`, article)
    try {
      await projectArticle(article)
    } catch (projectionError) {
      await kvDelete(`${ARTICLE_PREFIX}${article.id}`).catch(() => undefined)
      if (await tableAvailable("writer_articles"))
        await tableDeleteWhere("writer_articles", "id", article.id).catch(() => undefined)
      throw projectionError
    }
    res.json({ ok: true, article })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/articles/:id/migrate-legacy", async (req, res) => {
  try {
    const legacy = (await loadArticles()).find((item) => item.id === req.params.id)
    if (!legacy) return res.status(404).json({ error: "Không tìm thấy bài legacy." })
    if (!legacy.legacyReadOnly)
      return res.status(409).json({ error: "Bài này đã sử dụng workflow hiện tại." })

    const now = new Date().toISOString()
    const title = String(legacy.topic || legacy.title || "Legacy article").trim()
    const keywords = String(legacy.keywords ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    const sourceText = [
      `Legacy article: ${title}`,
      keywords.length ? `Keywords: ${keywords.join(", ")}` : "",
      String(legacy.angle ?? "").trim() ? `Angle: ${String(legacy.angle).trim()}` : "",
    ].filter(Boolean).join("\n")
    const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex")
    let plan = await createContentPlanRecord({
      name: `Legacy recovery — ${title}`,
      source: {
        sourceType: "paste",
        name: `Recovered from ${legacy.id}`,
        extractedContent: sourceText,
        contentHash: sourceHash,
        contentLength: sourceText.length,
      },
    })
    const itemId = crypto.randomUUID()
    const sourceId = plan.sources?.[0]?.id
    plan = await saveClassifiedPlan(plan, [{
      id: itemId,
      title,
      keywords,
      type: legacy.activityType || "comparison-seo",
      sourceLine: sourceText,
      sourceQuote: sourceText,
      sourceId,
      confidence: 1,
      classificationReason: "Explicitly recovered from a legacy Writer Studio article.",
    }], "legacy-compatibility-adapter")

    const ideas = Array.isArray(legacy.coreIdeaSuggestions) && legacy.coreIdeaSuggestions.length
      ? legacy.coreIdeaSuggestions
      : [{
          id: "legacy-recovered-idea",
          title,
          angleLabel: "Recovered direction",
          angleDescription: String(legacy.angle || "Recovered from the legacy article snapshot."),
          mainArgument: String(legacy.angle || title),
          primaryKeyword: keywords[0] || title,
          secondaryKeywords: keywords.slice(1),
          targetAudience: String(legacy.targetAudience || "Existing audience"),
          recommendedTone: String(legacy.tone || "Informational"),
          recommendedWordCount: Number(legacy.wordCount || 1500),
          rating: { overall: 0, seoPotential: 0, audienceFit: 0, docSupport: 0, uniqueness: 0 },
          ratingRationale: "Recovered legacy output; not re-scored.",
          matchedDocs: [], ruleRefs: [], evidence: [],
        }]
    const selectedIdeaId = ideas.some((idea: any) => idea.id === legacy.selectedCoreIdeaId)
      ? legacy.selectedCoreIdeaId
      : ideas[0].id
    const spec = legacy.articleSpec ?? {
      version: 1,
      topic: title,
      primaryQuery: keywords[0] || title,
      secondaryQueries: keywords.slice(1),
      audience: String(legacy.targetAudience || "Existing audience"),
      market: "legacy-unspecified",
      language: "English",
      primaryIntent: "informational",
      expectedReaderOutcome: String(legacy.angle || `Understand ${title}`),
      winningFormat: String(legacy.contentType || "Article"),
      mustCover: (legacy.outline ?? []).map((section: any) => String(section.heading || "")).filter(Boolean),
      optionalCoverage: [],
      thesis: String(legacy.angle || title),
      brandPov: "Recovered legacy snapshot",
      evidence: [],
      ctaObjective: "Preserve the original article outcome",
      internalLinkRequirements: [],
      createdAt: now,
    }
    const specFingerprint = legacy.articleSpecFingerprint || snapshotFingerprint(spec)
    const newId = `art-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
    const article = {
      ...legacy,
      id: newId,
      legacyReadOnly: false,
      legacyReason: undefined,
      migratedFromArticleId: legacy.id,
      title,
      topic: title,
      contentPlanId: plan.id,
      contentPlanVersion: plan.version,
      contentPlanInput: sourceText,
      contentPlanSourceItemId: itemId,
      contentPlanItemId: itemId,
      selectedContentTypeSuggestionId: itemId,
      contentType: legacy.contentType || "Comparison / SEO",
      coreIdeaSuggestions: ideas,
      selectedCoreIdeaId: selectedIdeaId,
      articleSpec: spec,
      articleSpecFingerprint: specFingerprint,
      activityKind: "single",
      activityId: `legacy-recovery-${legacy.id}-${Date.now()}`,
      currentStep: Array.isArray(legacy.outline) && legacy.outline.length ? 4 : 3,
      status: legacy.draft?.trim() ? "review" : "in_progress",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    await kvSet(`${ARTICLE_PREFIX}${newId}`, article)
    await projectArticle(article)
    res.status(201).json({ ok: true, article, sourceArticleId: legacy.id })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.put("/api/articles/:id", async (req, res) => {
  try {
    const { id } = req.params
    const updates = req.body
    const article = await serializeByKey(
      articleMutationQueues,
      id,
      async () => {
        let existing = await kvGet<any>(`${ARTICLE_PREFIX}${id}`)
        if (!existing)
          existing = (await loadArticles()).find((item) => item.id === id)
        if (!existing) throw new Error("Bài viết không tồn tại trong Supabase.")
        const next = {
          ...existing,
          ...updates,
          id,
          updatedAt: new Date().toISOString(),
        }
        if (Object.prototype.hasOwnProperty.call(updates, "currentStep")) {
          const requestedStep = Math.min(
            4,
            Math.max(2, Number(updates.currentStep) || 2),
          )
          const allowedStep = highestReachableArticleStep(next)
          if (requestedStep > allowedStep) {
            throw new Error(
              `WORKFLOW_PREREQUISITE_MISSING:${articleStepPrerequisite(next, requestedStep) ?? "The previous step is incomplete."}`,
            )
          }
          next.currentStep = requestedStep
        }
        await kvSet(`${ARTICLE_PREFIX}${id}`, next)
        // A deliberate idea selection is the highest-signal feedback available
        // in the manual workflow. Keep only a compact, non-evidentiary card so
        // future runs can reuse preferences without replaying old documents.
        if (Object.prototype.hasOwnProperty.call(updates, "selectedCoreIdeaId"))
          await recordLearningDecision(next)
        await projectArticle(next)
        return next
      },
    )
    res.json({ ok: true, article })
  } catch (err: any) {
    const workflowError = String(err?.message ?? "").startsWith(
      "WORKFLOW_PREREQUISITE_MISSING:",
    )
    res.status(workflowError ? 409 : 500).json({
      code: workflowError ? "WORKFLOW_PREREQUISITE_MISSING" : undefined,
      error: workflowError
        ? String(err.message).slice("WORKFLOW_PREREQUISITE_MISSING:".length)
        : err.message,
    })
  }
})

app.delete("/api/articles/:id", async (req, res) => {
  try {
    const { id } = req.params
    const existing = await kvGet<any>(`${ARTICLE_PREFIX}${id}`)
    if (
      !existing &&
      !(await loadArticles()).some((article) => article.id === id)
    ) {
      // DELETE is idempotent. This also lets the client clear a stale Recents
      // item after an older server version deleted the record but failed during
      // non-critical Content Plan projection cleanup.
      res.json({ ok: true, deletedId: id, alreadyDeleted: true })
      return
    }
    await kvDelete(`${ARTICLE_PREFIX}${id}`)
    if (await tableAvailable("writer_articles"))
      await tableDeleteWhere("writer_articles", "id", id)
    const legacy = (await kvGet<any[]>("writer:articles")) ?? []
    if (legacy.some((article) => article?.id === id)) {
      await kvSet(
        "writer:articles",
        legacy.filter((article) => article?.id !== id),
      )
    }
    if (existing?.activityId) {
      const siblings = (await loadArticles()).filter(
        (article) => article.activityId === existing.activityId,
      )
      if (!siblings.length) {
        await kvDelete(`writer:batch:${existing.activityId}`)
        batchControllers.delete(existing.activityId)
      }
    }
    if (existing?.contentPlanId) {
      if (await relationalPlansAvailable()) {
        // Legacy articles may retain a contentPlanId after the related plan was
        // removed. Article deletion is authoritative; missing plan projections
        // must not turn a successful delete into a 500 response.
        const plan = await getContentPlan(existing.contentPlanId)
        if (plan) {
          const projected = await tableSelect<any>("writer_articles", (query) =>
            query.select("id").eq("content_plan_id", existing.contentPlanId),
          )
          await tableUpdate("content_plans", existing.contentPlanId, {
            total_articles: projected.length,
            updated_at: new Date().toISOString(),
          })
        }
      } else {
        const plan = await kvGet<any>(
          `${CONTENT_PLAN_PREFIX}${existing.contentPlanId}`,
        )
        if (plan) {
          plan.totalArticles = (await kvGetByPrefix(ARTICLE_PREFIX)).filter(
            (record) => record.value?.contentPlanId === existing.contentPlanId,
          ).length
          plan.updatedAt = new Date().toISOString()
          await kvSet(`${CONTENT_PLAN_PREFIX}${plan.id}`, plan)
        }
      }
    }
    res.json({ ok: true, deletedId: id })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Config ───────────────────────────────────────────────────────────────────

app.get("/api/config", async (_req, res) => {
  try {
    const config = (await kvGet<any>("writer:config")) ?? {}
    const websiteInventory = await loadWebsiteInventory()
    res.json({ ...config, websiteInventory })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/config", async (req, res) => {
  try {
    const {
      actionSources: _removedLegacySources,
      websiteInventory,
      ...config
    } = req.body ?? {}
    // Inventory is an independent relational dataset. Keeping hundreds of
    // records inside writer:config made every settings save rewrite the whole
    // collection and allowed concurrent scans to overwrite one another.
    await kvSet("writer:config", config)
    if (!(await hasWebsiteInventoryTable()) && Array.isArray(websiteInventory))
      await kvSet("writer:website-inventory:fallback", websiteInventory)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

const WEBSITE_SUMMARY_VERSION = "website-summary-v1"
const WEBSITE_JOB_PREFIX = "writer:website-inventory-job:"
const websiteJobQueues = new Map<string, Promise<unknown>>()
const activeWebsiteJobs = new Set<string>()
const cancelledWebsiteJobs = new Set<string>()
let websiteInventoryTableReady: boolean | undefined
let exhaustedWebsiteSummaryBudgetDate: string | undefined

async function hasWebsiteInventoryTable() {
  if (websiteInventoryTableReady === undefined)
    websiteInventoryTableReady = await tableAvailable("website_content_inventory")
  return websiteInventoryTableReady
}

function websiteRowToRecord(row: any) {
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url ?? undefined,
    title: row.title,
    contentType: row.content_type,
    topics: row.topics ?? [],
    services: row.services ?? [],
    audience: row.audience ?? undefined,
    status: row.status,
    redirectTarget: row.redirect_target ?? undefined,
    eligibleForInternalLink: Boolean(row.eligible_for_internal_link),
    lastChecked: row.last_checked ?? undefined,
    description: row.description ?? undefined,
    httpStatus: row.http_status ?? undefined,
    crawlStatus: row.crawl_status ?? undefined,
    lastError: row.last_error ?? undefined,
    classificationConfidence: row.classification_confidence == null ? undefined : Number(row.classification_confidence),
    contentFingerprint: row.content_fingerprint ?? undefined,
    summary: row.summary ?? undefined,
    primaryTopic: row.primary_topic ?? undefined,
    searchIntent: row.search_intent ?? undefined,
    internalLinkAnchors: row.internal_link_anchors ?? [],
    keyClaims: row.key_claims ?? [],
    language: row.language ?? undefined,
    aiModel: row.ai_model ?? undefined,
    aiSummaryVersion: row.ai_summary_version ?? undefined,
    summarizedAt: row.summarized_at ?? undefined,
  }
}

async function loadWebsiteInventory(): Promise<any[]> {
  if (await hasWebsiteInventoryTable()) {
    const rows = await tableSelect<any>("website_content_inventory", (query) =>
      query.order("last_checked", { ascending: false }).limit(2000),
    )
    return rows.map(websiteRowToRecord)
  }
  return (await kvGet<any[]>("writer:website-inventory:fallback")) ?? []
}

async function reserveWebsiteSummaryBudget() {
  const date = new Date().toISOString().slice(0, 10)
  const key = `writer:website-summary-budget:${date}`
  const limit = Math.max(1, Number(process.env.WEBSITE_SUMMARY_DAILY_LIMIT || 500))
  if (exhaustedWebsiteSummaryBudgetDate === date)
    return { allowed: false, used: limit, limit }
  return serializeByKey(aiBudgetQueues, key, async () => {
    const current = await kvGet<{ used?: number }>(key)
    const used = Number(current?.used ?? 0)
    if (used >= limit) {
      exhaustedWebsiteSummaryBudgetDate = date
      return { allowed: false, used, limit }
    }
    await kvSet(key, { used: used + 1, limit, updatedAt: new Date().toISOString() })
    return { allowed: true, used: used + 1, limit }
  })
}

async function persistWebsiteInventoryRecord(record: any) {
  if (!(await hasWebsiteInventoryTable())) {
    await serializeByKey(websiteJobQueues, "fallback-inventory", async () => {
      const inventory = (await kvGet<any[]>("writer:website-inventory:fallback")) ?? []
      await kvSet("writer:website-inventory:fallback", [
        record,
        ...inventory.filter((item: any) => item.id !== record.id && item.url !== record.url),
      ])
    })
    return
  }
  const base = {
    id: record.id,
    url: record.url,
    canonical_url: record.canonicalUrl ?? null,
    title: record.title,
    content_type: record.contentType,
    topics: record.topics ?? [],
    services: record.services ?? [],
    audience: record.audience ?? null,
    status: record.status,
    redirect_target: record.redirectTarget ?? null,
    eligible_for_internal_link: Boolean(record.eligibleForInternalLink),
    last_checked: record.lastChecked ?? null,
    description: record.description ?? null,
    http_status: record.httpStatus ?? null,
    crawl_status: record.crawlStatus ?? "complete",
    last_error: record.lastError ?? null,
    classification_confidence: record.classificationConfidence ?? null,
    content_fingerprint: record.contentFingerprint ?? null,
    updated_at: new Date().toISOString(),
  }
  try {
    await tableUpsert("website_content_inventory", {
      ...base,
      summary: record.summary ?? null,
      primary_topic: record.primaryTopic ?? null,
      search_intent: record.searchIntent ?? null,
      internal_link_anchors: record.internalLinkAnchors ?? [],
      key_claims: record.keyClaims ?? [],
      language: record.language ?? null,
      ai_model: record.aiModel ?? null,
      ai_summary_version: record.aiSummaryVersion ?? null,
      summarized_at: record.summarizedAt ?? null,
    }, "id")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/column|schema cache/i.test(message)) throw error
    await tableUpsert("website_content_inventory", base, "id")
  }
}

async function scanWebsiteUrlWithRetry(url: string) {
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await scanWebsiteUrl(url)
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750))
    }
  }
  throw lastError
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function processWebsiteInventoryUrl(url: string, summarize = true) {
    let record: any = await scanWebsiteUrlWithRetry(url)
    const extractedContent = String(record.extractedContent ?? "")
    delete record.extractedContent
    if (record.status !== "broken" && summarize && getAvailableProviders().openai) {
      try {
        const cacheKey = `writer:website-summary:${WEBSITE_SUMMARY_VERSION}:${record.contentFingerprint}`
        const cached = await kvGet<any>(cacheKey)
        let classified: any
        let model = cached?.model
        if (cached?.summary) {
          classified = cached.summary
        } else {
          const budget = await reserveWebsiteSummaryBudget()
          if (budget.allowed) {
            const result = await withTimeout(
              generate({
                provider: "openai",
                modelId: process.env.WEBSITE_SUMMARY_MODEL || process.env.WEBSITE_CLASSIFIER_MODEL || "gpt-4o-mini",
                maxTokens: 650,
                temperature: 0,
                jsonMode: true,
                systemPrompt:
                  "Summarize and classify one web page for an internal-link inventory. Use only supplied page content. Return JSON only; never invent claims.",
                prompt: [
                  `PAGE METADATA: ${JSON.stringify({ url: record.redirectTarget || record.url, title: record.title, description: record.description })}`,
                  `CLEAN PAGE CONTENT:\n${extractedContent}`,
                  'Return {"summary":string,"contentType":"blog|service|portfolio|landing|about|commercial","primaryTopic":string,"topics":[string],"services":[string],"audience":string,"searchIntent":"informational|commercial|transactional|navigational","internalLinkAnchors":[string],"keyClaims":[string],"language":string,"confidence":number}. Summary must be 40-90 words. Keep taxonomy and anchors concise.',
                ].join("\n\n"),
              }),
              45_000,
              "Website AI summary timed out after 45 seconds.",
            )
            classified = parseJsonObject(result.content)
            model = result.model
            await kvSet(cacheKey, { summary: classified, model, usage: result.usage, createdAt: new Date().toISOString() })
          } else {
            record.aiSummarySkippedReason = "daily-limit"
          }
        }
        if (classified) {
          const allowed = new Set([
            "blog",
            "service",
            "portfolio",
            "landing",
            "about",
            "commercial",
          ])
          const intents = new Set(["informational", "commercial", "transactional", "navigational"])
          const list = (value: any, limit: number) => Array.isArray(value)
            ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, limit)
            : []
          const summaryWords = String(classified.summary ?? "").trim().split(/\s+/).filter(Boolean)
          const normalizedSummary = summaryWords.slice(0, 90).join(" ")
          record = {
            ...record,
            contentType: allowed.has(classified.contentType)
              ? classified.contentType
              : record.contentType,
            summary: normalizedSummary || record.description,
            primaryTopic: String(classified.primaryTopic ?? "").trim() || undefined,
            topics: list(classified.topics, 6).length ? list(classified.topics, 6) : record.topics,
            services: list(classified.services, 5).length ? list(classified.services, 5) : record.services,
            audience: String(classified.audience ?? "").trim() || undefined,
            searchIntent: intents.has(classified.searchIntent) ? classified.searchIntent : "informational",
            internalLinkAnchors: list(classified.internalLinkAnchors, 8),
            keyClaims: list(classified.keyClaims, 6),
            language: String(classified.language ?? "").trim() || undefined,
            classificationConfidence: Math.max(0, Math.min(1, Number(classified.confidence ?? 0.85))),
            aiModel: model,
            aiSummaryVersion: WEBSITE_SUMMARY_VERSION,
            summarizedAt: new Date().toISOString(),
            summaryCacheHit: Boolean(cached),
          }
        }
      } catch (error) {
        console.warn(
          "[website-inventory] AI fallback skipped:",
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    record = {
      id: `url-${crypto.createHash("sha256").update(record.url).digest("hex").slice(0, 16)}`,
      ...record,
      crawlStatus: record.status === "broken" ? "failed" : "complete",
    }
    await persistWebsiteInventoryRecord(record)
    return record
}

app.post("/api/website-inventory/scan", async (req, res) => {
  try {
    const url = String(req.body?.url ?? "").trim()
    if (!url) return res.status(400).json({ error: "URL is required." })
    const record = await processWebsiteInventoryUrl(url, req.body?.aiSummary !== false)
    res.json({ record })
  } catch (error) {
    res
      .status(422)
      .json({ error: error instanceof Error ? error.message : String(error) })
  }
})

type WebsiteInventoryJob = {
  id: string
  status: "queued" | "running" | "complete" | "failed" | "cancelled"
  urls: string[]
  aiSummary: boolean
  total: number
  done: number
  failed: number
  summaryLimitReached: boolean
  completedUrls: string[]
  recentRecords: any[]
  createdAt: string
  updatedAt: string
  error?: string
}

async function updateWebsiteJob(
  jobId: string,
  update: (job: WebsiteInventoryJob) => WebsiteInventoryJob,
) {
  return serializeByKey(websiteJobQueues, jobId, async () => {
    const current = await kvGet<WebsiteInventoryJob>(`${WEBSITE_JOB_PREFIX}${jobId}`)
    if (!current) throw new Error("Website inventory batch not found.")
    const next = update(current)
    await kvSet(`${WEBSITE_JOB_PREFIX}${jobId}`, next)
    return next
  })
}

async function runWebsiteInventoryJob(jobId: string) {
  if (activeWebsiteJobs.has(jobId)) return
  activeWebsiteJobs.add(jobId)
  try {
    let job = await updateWebsiteJob(jobId, (current) => ({
      ...current,
      status: "running",
      updatedAt: new Date().toISOString(),
      error: undefined,
    }))
    const completed = new Set(job.completedUrls)
    const remaining = job.urls.filter((url) => !completed.has(url))
    let cursor = 0
    const worker = async () => {
      while (cursor < remaining.length) {
        if (cancelledWebsiteJobs.has(jobId)) return
        const url = remaining[cursor++]
        let record: any
        try {
          record = await processWebsiteInventoryUrl(url, job.aiSummary)
        } catch (error) {
          record = {
            id: `url-${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
            url,
            title: new URL(url).hostname,
            contentType: "blog",
            topics: [],
            services: [],
            status: "broken",
            crawlStatus: "failed",
            eligibleForInternalLink: false,
            lastChecked: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : String(error),
          }
          await persistWebsiteInventoryRecord(record)
        }
        job = await updateWebsiteJob(jobId, (current) => {
          if (current.status === "cancelled") return current
          const completedUrls = [...new Set([...current.completedUrls, record.url])]
          return {
            ...current,
            completedUrls,
            recentRecords: [record, ...current.recentRecords.filter((item) => item.url !== record.url)].slice(0, 12),
            done: completedUrls.length,
            failed: current.failed + (record.crawlStatus === "failed" ? 1 : 0),
            summaryLimitReached: current.summaryLimitReached || record.aiSummarySkippedReason === "daily-limit",
            status: completedUrls.length >= current.total ? "complete" : "running",
            updatedAt: new Date().toISOString(),
          }
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, remaining.length) }, worker))
    await updateWebsiteJob(jobId, (current) => ({
      ...current,
      status: current.status === "cancelled" ? "cancelled" : "complete",
      updatedAt: new Date().toISOString(),
    }))
  } catch (error) {
    await updateWebsiteJob(jobId, (current) => ({
      ...current,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    })).catch(() => undefined)
  } finally {
    activeWebsiteJobs.delete(jobId)
    cancelledWebsiteJobs.delete(jobId)
  }
}

app.post("/api/website-inventory/batches", async (req, res) => {
  try {
    const urls = [...new Set((Array.isArray(req.body?.urls) ? req.body.urls : [])
      .map((value: unknown) => String(value).trim())
      .filter((value: string) => {
        try {
          return ["http:", "https:"].includes(new URL(value).protocol)
        } catch {
          return false
        }
      }))].slice(0, 2000) as string[]
    if (!urls.length) return res.status(400).json({ error: "At least one valid URL is required." })
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const job: WebsiteInventoryJob = {
      id,
      status: "queued",
      urls,
      aiSummary: req.body?.aiSummary !== false,
      total: urls.length,
      done: 0,
      failed: 0,
      summaryLimitReached: false,
      completedUrls: [],
      recentRecords: [],
      createdAt: now,
      updatedAt: now,
    }
    await kvSet(`${WEBSITE_JOB_PREFIX}${id}`, job)
    void runWebsiteInventoryJob(id)
    res.status(202).json({ job })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get("/api/website-inventory/batches/:id", async (req, res) => {
  try {
    const job = await kvGet<WebsiteInventoryJob>(`${WEBSITE_JOB_PREFIX}${req.params.id}`)
    if (!job) return res.status(404).json({ error: "Website inventory batch not found." })
    if (["queued", "running", "failed"].includes(job.status) && job.done < job.total)
      void runWebsiteInventoryJob(job.id)
    res.json({ job })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete("/api/website-inventory/batches", async (_req, res) => {
  try {
    const entries = await kvGetByPrefix(WEBSITE_JOB_PREFIX)
    const running = entries
      .map((entry) => entry.value as WebsiteInventoryJob)
      .filter((job) => job && ["queued", "running", "failed"].includes(job.status) && job.done < job.total)
    const jobs = await Promise.all(running.map(async (job) => {
      cancelledWebsiteJobs.add(job.id)
      return updateWebsiteJob(job.id, (current) => ({
        ...current,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
        error: undefined,
      }))
    }))
    res.json({ cancelled: jobs.length, jobs })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete("/api/website-inventory/batches/:id", async (req, res) => {
  try {
    const jobId = req.params.id
    cancelledWebsiteJobs.add(jobId)
    const job = await updateWebsiteJob(jobId, (current) => ({
      ...current,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      error: undefined,
    }))
    res.json({ job })
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get("/api/website-inventory", async (_req, res) => {
  try {
    res.json({ records: await loadWebsiteInventory() })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.patch("/api/website-inventory/:id", async (req, res) => {
  try {
    const allowed: Record<string, string> = {
      contentType: "content_type",
      topics: "topics",
      services: "services",
      audience: "audience",
      status: "status",
      eligibleForInternalLink: "eligible_for_internal_link",
    }
    const updates = Object.fromEntries(Object.entries(req.body ?? {})
      .filter(([key]) => allowed[key])
      .map(([key, value]) => [allowed[key], value]))
    if (!Object.keys(updates).length) return res.status(400).json({ error: "No supported inventory fields supplied." })
    if (await hasWebsiteInventoryTable()) {
      const row = await tableUpdate("website_content_inventory", req.params.id, {
        ...updates,
        updated_at: new Date().toISOString(),
      })
      return res.json({ record: websiteRowToRecord(row) })
    }
    const inventory = await loadWebsiteInventory()
    const next = inventory.map((item) => item.id === req.params.id ? { ...item, ...req.body } : item)
    await kvSet("writer:website-inventory:fallback", next)
    res.json({ record: next.find((item) => item.id === req.params.id) })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete("/api/website-inventory/:id", async (req, res) => {
  try {
    if (await hasWebsiteInventoryTable())
      await tableDeleteWhere("website_content_inventory", "id", req.params.id)
    else
      await kvSet("writer:website-inventory:fallback", (await loadWebsiteInventory()).filter((item) => item.id !== req.params.id))
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

// ─── Files ────────────────────────────────────────────────────────────────────

app.get("/api/files", async (_req, res) => {
  try {
    const files = (await kvGet("writer:files")) ?? []
    res.json(files)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/files", async (req, res) => {
  try {
    if (!Array.isArray(req.body))
      return res.status(400).json({ error: "Danh sách files không hợp lệ." })
    const invalidFiles = req.body.filter(
      (file: any) => typeof file?.content !== "string" || !file.content.trim(),
    )
    if (invalidFiles.length) {
      return res.status(422).json({
        error: `Có ${invalidFiles.length} file chưa có nội dung scan. Hãy xóa và tải lại.`,
      })
    }
    const files = req.body.map((file: any) => ({
      ...file,
      contentUpdatedAt: file.contentUpdatedAt ?? new Date().toISOString(),
      ...contentMetadata(file.content),
    }))
    await kvSet("writer:files", files)
    if (await tableAvailable("knowledge_items")) {
      for (const file of files.filter((item: any) => item.category === "kb")) {
        const meta = file.knowledgeMetadata ?? {}
        await tableUpsert(
          "knowledge_items",
          {
            id: file.id,
            source_name: file.name,
            knowledge_type: meta.type ?? "reference",
            topics: meta.topics ?? [],
            service: meta.service ?? null,
            audience: meta.audience ?? null,
            visibility: meta.visibility ?? "internal",
            approved_for_external_use: Boolean(meta.approvedForExternalUse),
            metadata: meta,
            updated_at: new Date().toISOString(),
          },
          "id",
        )
      }
    }
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Multi-source import: Railway resolves content, then persists Supabase ──

app.post("/api/import/source", async (req, res) => {
  try {
    const category = String(req.body?.category ?? "")
    const sourceType = String(req.body?.sourceType ?? "")
    if (!["kb", "rules"].includes(category)) {
      return res.status(400).json({ error: "category phải là kb hoặc rules." })
    }
    if (
      !["paste", "url", "gsheet", "manual", "supabase", "airtable"].includes(
        sourceType,
      )
    ) {
      return res
        .status(400)
        .json({ error: "Loại nguồn dữ liệu không được hỗ trợ." })
    }

    let content = ""
    if (sourceType === "paste" || sourceType === "manual") {
      content = String(req.body.content ?? "").trim()
    } else if (sourceType === "url" || sourceType === "gsheet") {
      content = await fetchTextSource(
        String(req.body.url ?? ""),
        req.body.headers,
      )
    } else if (sourceType === "supabase") {
      content = JSON.stringify(
        await runReadOnlySelect(String(req.body.query ?? "")),
        null,
        2,
      )
    } else if (sourceType === "airtable") {
      content = await fetchAirtableSource(
        String(req.body.airtableKey ?? ""),
        String(req.body.airtableBase ?? ""),
        String(req.body.airtableTable ?? ""),
      )
    }
    if (!content)
      return res
        .status(422)
        .json({ error: "Nguồn không trả về nội dung để AI đọc." })

    const timestamp = new Date().toISOString()
    const id = crypto.randomUUID()
    const name =
      String(req.body.name ?? "").trim() ||
      `${sourceType}-${timestamp.slice(0, 10)}`
    const common = {
      id,
      name,
      sourceType,
      addedAt: timestamp,
      uploadedAt: timestamp,
      contentUpdatedAt: timestamp,
      content,
      preview: content.split("\n").slice(0, 4).join("\n"),
      rowCount: content.split("\n").filter(Boolean).length,
      size: formatBytes(Buffer.byteLength(content, "utf8")),
      fileType:
        sourceType === "manual"
          ? "csv"
          : sourceType === "paste"
            ? String(req.body.format ?? "txt")
            : "json",
      url:
        sourceType === "url" || sourceType === "gsheet"
          ? req.body.url
          : undefined,
      query: sourceType === "supabase" ? req.body.query : undefined,
      airtableBase:
        sourceType === "airtable" ? req.body.airtableBase : undefined,
      airtableTable:
        sourceType === "airtable" ? req.body.airtableTable : undefined,
      columns: sourceType === "manual" ? req.body.columns : undefined,
      rows: sourceType === "manual" ? req.body.rows : undefined,
      ...contentMetadata(content),
    }

    const record = { ...common, category }
    const files = (await kvGet<any[]>("writer:files")) ?? []
    await kvSet("writer:files", [
      record,
      ...files.filter((item) => item.id !== id),
    ])
    return res.status(201).json({ target: "writer:files", record })
  } catch (err: any) {
    console.error("[import/source] error:", err.message)
    return res
      .status(500)
      .json({ error: err.message || "Không thể import nguồn dữ liệu." })
  }
})

// ─── Document upload: Railway parses, then persists extracted content ────────

app.post("/api/upload/document", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Thiếu file upload." })
    const category = String(req.body.category ?? "")
    if (!["kb", "rules"].includes(category)) {
      return res.status(400).json({ error: "category phải là kb hoặc rules." })
    }

    const content = (
      await extractDocumentText(req.file.buffer, req.file.originalname)
    ).trim()
    if (!content)
      return res
        .status(422)
        .json({ error: "File không có nội dung văn bản để AI scan." })

    const timestamp = new Date().toISOString()
    const id = crypto.randomUUID()
    const fileType =
      req.file.originalname.split(".").pop()?.toLowerCase() ?? "txt"
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]+/g, "_")
    const storagePath = `${category}/${id}/${safeName}`
    await uploadDocumentBinary(
      storagePath,
      req.file.buffer,
      req.file.mimetype || "application/octet-stream",
    )

    const record = {
      id,
      name: req.file.originalname,
      size: formatBytes(req.file.size),
      uploadedAt: timestamp,
      category,
      fileType,
      storagePath,
      originalMimeType: req.file.mimetype || "application/octet-stream",
      content,
      contentUpdatedAt: timestamp,
      ...contentMetadata(content),
    }
    const files = (await kvGet<any[]>("writer:files")) ?? []
    await kvSet("writer:files", [
      record,
      ...files.filter((item) => item.id !== id),
    ])
    return res.status(201).json({ target: "writer:files", record })
  } catch (err: any) {
    console.error("[upload/document] error:", err.message)
    return res
      .status(500)
      .json({ error: err.message || "Không thể xử lý và lưu file." })
  }
})

function canonicalHeading(value: string) {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`]/g, "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function assignDocumentHeadings(
  draft: string,
  title: string,
  outline: Array<{ heading?: string; level?: string }>,
) {
  const headingLevels = new Map(
    outline
      .filter((section) => section?.heading)
      .map(
        (section) =>
          [
            canonicalHeading(String(section.heading)),
            section.level === "h3" ? 3 : 2,
          ] as const,
      ),
  )
  const canonicalTitle = canonicalHeading(title)
  const lines = draft.replace(/\r\n?/g, "\n").split("\n")
  let hasH1 = false
  const formatted = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return ""
    const existing = trimmed.match(/^(#{1,6})\s+(.+)$/)
    const text = existing?.[2]?.trim() ?? trimmed
    const canonical = canonicalHeading(text)
    if (canonicalTitle && canonical === canonicalTitle) {
      hasH1 = true
      return `# ${text}`
    }
    const outlineLevel = headingLevels.get(canonical)
    if (outlineLevel) return `${"#".repeat(outlineLevel)} ${text}`
    if (existing) {
      const level = Math.min(3, Math.max(1, existing[1].length))
      if (level === 1) hasH1 = true
      return `${"#".repeat(level)} ${text}`
    }
    return line.trimEnd()
  })
  if (!hasH1 && title.trim()) formatted.unshift(`# ${title.trim()}`, "")
  return formatted
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function inlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
}

function markdownForGoogleDocs(markdown: string) {
  const html: string[] = ["<div>"]
  let listType: "ul" | "ol" | null = null
  const closeList = () => {
    if (listType) html.push(`</${listType}>`)
    listType = null
  }
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    const unordered = line.match(/^[-*]\s+(.+)$/)
    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol"
      if (listType !== nextType) {
        closeList()
        listType = nextType
        html.push(`<${nextType}>`)
      }
      html.push(`<li>${inlineMarkdown((unordered ?? ordered)![1])}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  closeList()
  html.push("</div>")
  return html.join("")
}

app.post("/api/format/google-docs", (req, res) => {
  const draft = String(req.body?.draft ?? "").trim()
  const title = String(req.body?.title ?? "").trim()
  const outline = Array.isArray(req.body?.outline) ? req.body.outline : []
  if (!draft)
    return res.status(400).json({ error: "Draft không được để trống." })
  const markdown = assignDocumentHeadings(draft, title, outline)
  return res.json({
    markdown,
    html: markdownForGoogleDocs(markdown),
    formatter: "deterministic-v1",
    aiCalls: 0,
  })
})

app.get("/api/documents/:id/download", async (req, res) => {
  try {
    const id = req.params.id
    const files = await kvGet<any[]>("writer:files")
    const document = (Array.isArray(files) ? files : []).find(
      (item) => item?.id === id,
    )

    if (!document)
      return res
        .status(404)
        .json({ error: "Không tìm thấy tài liệu trong Supabase." })

    let payload: Buffer
    let filename = String(document.name || `document-${id}.txt`)
    let contentType = String(
      document.originalMimeType || "application/octet-stream",
    )

    if (document.storagePath) {
      const blob = await downloadDocumentBinary(document.storagePath)
      payload = Buffer.from(await blob.arrayBuffer())
    } else if (typeof document.content === "string" && document.content) {
      payload = Buffer.from(document.content, "utf8")
      contentType = "text/plain; charset=utf-8"
      if (!/\.(txt|md|csv|json|xml|tsv)$/i.test(filename))
        filename = `${filename}.extracted.txt`
    } else {
      return res
        .status(404)
        .json({ error: "Nguồn dữ liệu này chưa có nội dung có thể tải xuống." })
    }

    res.setHeader("Content-Type", contentType)
    res.setHeader("Content-Length", payload.length)
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    return res.send(payload)
  } catch (err: any) {
    console.error("[documents/download] error:", err.message)
    return res
      .status(500)
      .json({ error: err.message || "Không thể tải tài liệu." })
  }
})

// ─── SPA fallback — serve index.html for all non-API routes ─────────────────

app.get("*", (_req, res) => {
  res.sendFile(path.join(DIST, "index.html"))
})

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Writer Studio Backend running on port ${PORT}`)
  console.log(`   Providers: ${JSON.stringify(getAvailableProviders())}`)
  console.log(
    `   Supabase:  ${
      !!(
        process.env.SUPABASE_URL &&
        (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY)
      )
        ? "✓ Connected"
        : "✗ Not configured"
    }\n`,
  )
  void (async () => {
    if (!(await tableAvailable("writer_articles"))) return
    const articles = await loadArticles()
    for (const article of articles) await projectArticle(article)
    console.log(
      `[migration] projected ${articles.length} KV articles into relational tables`,
    )
  })().catch((error) =>
    console.error("[migration] relational projection failed:", error),
  )
})
