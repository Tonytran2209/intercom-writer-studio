import type express from "express"
import multer from "multer"
import { jsonrepair } from "jsonrepair"
import { generate } from "./providers.ts"
import {
  tableAvailable,
  tableDeleteWhere,
  tableInsert,
  tableSelect,
  tableUpdate,
  tableUpsert,
} from "./supabase.ts"
import { extractDocumentText } from "./documentParser.ts"
import { collectDiscoveryResearch } from "./discoveryResearch.ts"

type AuthRequest = express.Request & {
  auth?: { userId: string; email: string; role: "user" | "admin" }
}
type ModelInput = { provider?: string; modelId?: string }
const stages = {
  brief: "extract_mapping",
  article: ["article_spec", "outline", "draft"],
  adapt: "channel_adaptation",
  review: "repetition_check",
} as const
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
})

function text(value: unknown) {
  return String(value ?? "").trim()
}
function librarySlug(filename: string) {
  const normalized = filename
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const slug = normalized.replace(/-md$/, "")
  return [
    "pillar-library",
    "persona-library",
    "article-library",
    "channel-rules",
  ].includes(slug)
    ? slug
    : null
}
function modelFrom(body: any, key = "model"): Required<ModelInput> | null {
  const input = body?.[key] ?? body?.model ?? {}
  const provider = text(input.provider)
  const modelId = text(input.id ?? input.modelId)
  return provider && modelId ? { provider, modelId } : null
}
async function one<T>(table: string, id: string): Promise<T | null> {
  return (
    (await tableSelect<T>(table, (query) => query.eq("id", id).limit(1)))[0] ??
    null
  )
}
async function libraryContext(slugs?: string[]) {
  const documents = await tableSelect<any>("eb_v2_library_documents", (query) =>
    query.eq("status", "ready"),
  )
  return documents
    .filter((item) => !slugs?.length || slugs.includes(item.slug))
    .map((item) => `${item.name}\n${String(item.content).slice(0, 12000)}`)
}
function ruleAppliesToGate(
  rule: any,
  gate: "brief" | "article" | "adapt" | "review",
) {
  let configuredGates: string[] = []
  try {
    const advanced = JSON.parse(text(rule?.advanced) || "{}")
    configuredGates = Array.isArray(advanced?.gates)
      ? advanced.gates.map(text)
      : []
  } catch {}
  if (configuredGates.length) return configuredGates.includes(gate)
  const id = text(rule?.id).toLowerCase()
  if (
    id === "input-validation" ||
    id === "discovery-routing" ||
    id === "classification"
  )
    return gate === "brief"
  if (id === "channel-constraints") return gate === "adapt"
  if (id === "approval-gates")
    return ["brief", "article", "review"].includes(gate)
  return true
}
async function workflowRuleContext(
  gate: "brief" | "article" | "adapt" | "review",
) {
  const settings = (
    await tableSelect<any>("eb_v2_app_settings", (query) => query.limit(1))
  )[0]?.settings?.ebWorkflowSettings
  const rules = Array.isArray(settings?.rules)
    ? settings.rules.filter(
        (rule: any) =>
          rule?.enabled &&
          text(rule?.instruction) &&
          ruleAppliesToGate(rule, gate),
      )
    : []
  const snapshot = rules.map((rule: any) => ({
    id: text(rule.id),
    title: text(rule.title),
    enforcement: text(rule.enforcement) || "guided",
    instruction: text(rule.instruction),
    advanced: text(rule.advanced) || "{}",
  }))
  if (!rules.length) return { prompt: "", snapshot }
  return {
    prompt: `EB WORKFLOW RULES FOR ${gate.toUpperCase()}\n${snapshot.map((rule: { enforcement: string; title: string; instruction: string; advanced: string }) => `[${rule.enforcement.toUpperCase()}] ${rule.title}: ${rule.instruction}${rule.advanced !== "{}" ? `\nParameters: ${rule.advanced}` : ""}`).join("\n\n")}`,
    snapshot,
  }
}
async function learningContext(
  gate: "brief" | "article" | "adapt" | "review",
  channel?: string,
) {
  const learningGate = gate === "adapt" ? "review" : gate
  if (!(["article", "review"] as string[]).includes(learningGate)) return ""
  // The feedback migration may be deployed independently of the application.
  // Existing content generation must keep working until it is available.
  if (!(await tableAvailable("eb_v2_learning_signals"))) return ""
  const signals = await tableSelect<any>("eb_v2_learning_signals", (query) =>
    query.eq("active", true).eq("gate", learningGate).order("created_at", { ascending: false }).limit(12),
  )
  const applicable = signals
    .filter((signal) => !signal.channel || !channel || signal.channel === channel)
    .slice(0, 4)
    .map((signal) => text(signal.instruction))
    .filter(Boolean)
  return applicable.length
    ? `APPROVED EDITORIAL LEARNINGS\n${applicable.map((instruction, index) => `${index + 1}. ${instruction}`).join("\n")}`
    : ""
}
function executionContract(gate: "brief" | "article" | "adapt" | "review") {
  if (gate === "brief")
    return `BRIEF OUTPUT CONTRACT\nAlways produce a usable brief; never refuse, pause, or ask the user to reply. Mark unavailable facts as N/A. Return concise Markdown only with: ## Brief summary, ## Evidence & gaps (only material gaps), ## Suggested EVP pillar, ## Suggested persona, and ## Article angle.`
  if (gate === "article")
    return `ARTICLE OUTPUT CONTRACT\nUse the approved brief as the source of truth. Do not ask for additional input; retain unknown facts as N/A and never invent them.`
  if (gate === "review")
    return `REVIEW OUTPUT CONTRACT\nReturn a concise evidence-based repetition assessment. Do not make a publishing decision; a human reviewer decides.`
  return `OUTPUT CONTRACT\nReturn only the requested, channel-ready content. Do not ask the user follow-up questions.`
}
function adaptTask(channel: string, article: string) {
  const channelContract = channel === "threads"
    ? `THREADS DELIVERY CONTRACT\nWrite in Vietnamese only. Do not include English translation, English headings, or explanatory notes. Return exactly two labelled variants: Variant A — Company account and Variant B — Employee-shareable. Each variant must be at most 500 characters, be ready to publish, and preserve the approved article's factual limits.`
    : channel === "facebook"
      ? `FACEBOOK DELIVERY CONTRACT\nReturn a Vietnamese post first, followed by its English translation. Keep the tone reflective and publish-ready. Do not add process notes.`
      : `LINKEDIN DELIVERY CONTRACT\nWrite in English only. Return one credibility-led, publish-ready LinkedIn post without process notes.`
  return `Adapt this approved fab.careers article for ${channel}. Follow the relevant Channel Rules.\n\n${channelContract}\n\nAPPROVED ARTICLE:\n${article}`
}
async function runGate(
  packageId: string,
  gate: "brief" | "article" | "adapt" | "review",
  stage: string,
  prompt: string,
  model: Required<ModelInput>,
  contextDocs: string[],
  ruleSnapshot: Record<string, unknown> = {},
) {
  const startedAt = new Date().toISOString()
  const run = await tableInsert<any>("eb_v2_gate_runs", {
    package_id: packageId,
    gate,
    stage,
    status: "running",
    input_snapshot: { prompt },
    rule_snapshot: ruleSnapshot,
    model_provider: model.provider,
    model_id: model.modelId,
    started_at: startedAt,
  })
  try {
    const [rules, learnings] = await Promise.all([
      workflowRuleContext(gate),
      learningContext(gate, stage.split(":")[1]),
    ])
    const compiledPrompt = [
      rules.prompt,
      learnings,
      executionContract(gate),
      "--- TASK ---",
      prompt,
    ]
      .filter(Boolean)
      .join("\n\n")
    await tableUpdate("eb_v2_gate_runs", run.id, {
      input_snapshot: { prompt, compiledPrompt },
      rule_snapshot: { ...ruleSnapshot, rules: rules.snapshot },
    })
    let response = await generate({
      provider: model.provider,
      modelId: model.modelId,
      prompt: compiledPrompt,
      contextDocs,
      maxTokens: gate === "article" && ["draft", "feedback"].includes(stage) ? 2600 : 1400,
      temperature: 0.65,
    })
    // A provider can occasionally report token usage while returning an empty text
    // segment. Never persist that as a successfully generated channel output.
    if (!text(response.content))
      response = await generate({
        provider: model.provider,
        modelId: model.modelId,
        prompt: `${compiledPrompt}\n\nFINAL RESPONSE REQUIREMENT: return the requested text now. Do not return an empty response.`,
        contextDocs,
        maxTokens: gate === "article" && ["draft", "feedback"].includes(stage) ? 2600 : 1400,
        temperature: 0.45,
      })
    if (
      !text(response.content) &&
      model.provider === "openai" &&
      model.modelId !== "gpt-5.4-mini"
    ) {
      response = await generate({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        prompt: `${compiledPrompt}\n\nFINAL RESPONSE REQUIREMENT: return the requested text now. Do not return an empty response.`,
        contextDocs,
        maxTokens: gate === "article" && ["draft", "feedback"].includes(stage) ? 2600 : 1400,
        temperature: 0.45,
      })
    }
    if (!text(response.content))
      throw new Error(
        `${gate}/${stage} completed without returned text after retry and fallback.`,
      )
    const usage = response.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    }
    await tableUpdate("eb_v2_gate_runs", run.id, {
      status: "completed",
      output_snapshot: { content: response.content },
      model_id: response.model,
      input_tokens: usage.inputTokens ?? 0,
      cached_input_tokens: usage.cachedInputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      completed_at: new Date().toISOString(),
    })
    return { content: response.content, model: response.model, usage }
  } catch (error) {
    await tableUpdate("eb_v2_gate_runs", run.id, {
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
    })
    throw error
  }
}
async function workspace() {
  const [packages, articles, channels, discovery, runs] = await Promise.all([
    tableSelect<any>("eb_v2_packages", (query) =>
      query.order("updated_at", { ascending: false }),
    ),
    tableSelect<any>("eb_v2_articles", (query) =>
      query.order("revision", { ascending: false }),
    ),
    tableSelect<any>("eb_v2_channel_outputs", (query) =>
      query.order("updated_at", { ascending: false }),
    ),
    tableSelect<any>("eb_v2_discovery_items", (query) =>
      query.order("updated_at", { ascending: false }),
    ),
    tableSelect<any>("eb_v2_gate_runs", (query) =>
      query.order("created_at", { ascending: false }),
    ),
  ])
  return {
    packages,
    articles: articles.filter((row) => !row.quality_report?.feedbackPending),
    channels: channels.filter(
      (row) => row.status !== "superseded" && !row.content?.archived,
    ),
    discovery,
    runs,
  }
}
async function archiveOutputs(packageId: string) {
  const outputs = await tableSelect<any>("eb_v2_channel_outputs", (query) =>
    query.eq("package_id", packageId),
  )
  await Promise.all(
    outputs
      .filter((output) => !output.content?.archived)
      .map((output) =>
        tableUpdate("eb_v2_channel_outputs", output.id, {
          // eb_v2_channel_outputs has a database check constraint and does not
          // permit the article-only `superseded` status. Keep the old revision
          // as a valid review state and hide it by its archival marker instead.
          status: "rejected",
          content: {
            ...(output.content ?? {}),
            archived: true,
            archivedAt: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        }),
      ),
  )
}
async function archiveArticles(packageId: string) {
  const articles = await tableSelect<any>("eb_v2_articles", (query) =>
    query.eq("package_id", packageId),
  )
  await Promise.all(
    articles
      .filter((article) => article.status !== "superseded")
      .map((article) =>
        tableUpdate("eb_v2_articles", article.id, {
          status: "superseded",
          updated_at: new Date().toISOString(),
        }),
      ),
  )
}
async function reopenLatestArticle(packageId: string) {
  const articles = await tableSelect<any>("eb_v2_articles", (query) =>
    query.eq("package_id", packageId).order("revision", { ascending: false }),
  )
  const article = articles.find((candidate) => text(candidate.body_markdown))
  if (!article) return null
  if (article.status !== "draft")
    await tableUpdate("eb_v2_articles", article.id, {
      status: "draft",
      approved_at: null,
      updated_at: new Date().toISOString(),
    })
  return article
}
async function reserveArticleRevision(packageId: string) {
  const latest = (
    await tableSelect<any>("eb_v2_articles", (query) =>
      query
        .eq("package_id", packageId)
        .order("revision", { ascending: false })
        .limit(1),
    )
  )[0]
  return tableInsert<any>("eb_v2_articles", {
    package_id: packageId,
    revision: Number(latest?.revision ?? 0) + 1,
    status: "draft",
    article_spec: {},
    outline: [],
    body_markdown: "",
    quality_report: { generationStatus: "running" },
  })
}
async function repetitionModel(fallback: Required<ModelInput>) {
  const settings =
    (await tableSelect<any>("eb_v2_app_settings", (query) => query.limit(1)))[0]
      ?.settings ?? {}
  const runtime = settings.ebRuntimeSettings ?? {}
  if (!runtime.enableAiRepetitionCheck) return null
  const configuredId = text(runtime.repetitionModelId)
  const configured = Array.isArray(settings.models)
    ? settings.models.find(
        (model: any) => model?.enabled && text(model.id) === configuredId,
      )
    : null
  return configured
    ? { provider: text(configured.provider), modelId: text(configured.id) }
    : fallback
}

export function registerEbV2Routes(app: express.Express) {
  app.get("/api/eb-v2/health", async (_req, res) => {
    const tables = [
      "eb_v2_library_documents",
      "eb_v2_packages",
      "eb_v2_package_inputs",
      "eb_v2_discovery_items",
      "eb_v2_discovery_runs",
      "eb_v2_discovery_sources",
      "eb_v2_gate_runs",
      "eb_v2_articles",
      "eb_v2_channel_outputs",
      "eb_v2_review_actions",
      "eb_v2_app_settings",
    ]
    try {
      const availability = Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [table, await tableAvailable(table)]),
        ),
      )
      const ok = Object.values(availability).every(Boolean)
      res
        .status(ok ? 200 : 503)
        .json({ status: ok ? "ok" : "degraded", tables: availability })
    } catch (error) {
      res
        .status(503)
        .json({
          status: "degraded",
          error:
            error instanceof Error
              ? error.message
              : "Unable to inspect EB V2 tables.",
        })
    }
  })
  app.get("/api/eb-v2/settings", async (_req, res) => {
    try {
      const row =
        (
          await tableSelect<any>("eb_v2_app_settings", (query) =>
            query.limit(1),
          )
        )[0] ?? null
      res.json({ settings: row?.settings ?? null })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to load EB V2 settings.",
        })
    }
  })
  app.get("/api/eb-v2/library-documents", async (_req, res) => {
    try {
      res.json({
        documents: await tableSelect<any>("eb_v2_library_documents", (query) =>
          query.order("updated_at", { ascending: false }),
        ),
      })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to load EB Library.",
        })
    }
  })
  app.post(
    "/api/eb-v2/library-documents/upload",
    upload.single("file"),
    async (req, res) => {
      const file = req.file
      if (!file) return res.status(400).json({ error: "A file is required." })
      const slug = librarySlug(file.originalname)
      if (!slug)
        return res
          .status(400)
          .json({
            error:
              "EB Library accepts only pillar-library.md, persona-library.md, article-library.md, or channel-rules.md.",
          })
      try {
        const content = (
          await extractDocumentText(file.buffer, file.originalname)
        ).trim()
        if (!content)
          return res
            .status(422)
            .json({ error: "The uploaded file did not contain readable text." })
        await tableUpsert(
          "eb_v2_library_documents",
          {
            slug,
            name: file.originalname,
            content,
            source_path: `settings-upload/${file.originalname}`,
            status: "ready",
            metadata: {
              mimeType: file.mimetype,
              byteSize: file.size,
              uploadedAt: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          },
          "slug",
        )
        const document = (
          await tableSelect<any>("eb_v2_library_documents", (query) =>
            query.eq("slug", slug).limit(1),
          )
        )[0]
        res
          .status(201)
          .json({ target: "eb_v2_library_documents", record: document })
      } catch (error) {
        res
          .status(500)
          .json({
            error:
              error instanceof Error
                ? error.message
                : "Unable to save the EB Library document.",
          })
      }
    },
  )
  app.post("/api/eb-v2/settings", async (req: AuthRequest, res) => {
    try {
      const settings = req.body?.settings
      if (!settings || typeof settings !== "object" || Array.isArray(settings))
        return res.status(400).json({ error: "Settings must be an object." })
      await tableUpsert(
        "eb_v2_app_settings",
        {
          id: true,
          settings,
          updated_by: req.auth?.userId ?? null,
          updated_at: new Date().toISOString(),
        },
        "id",
      )
      res.json({ settings })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to save EB V2 settings.",
        })
    }
  })
  app.get("/api/eb-v2/workspace", async (_req, res) => {
    try {
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to load EB workspace.",
        })
    }
  })
  app.get("/api/eb-v2/discovery/:id/details", async (req, res) => {
    try {
      const item = await one<any>("eb_v2_discovery_items", text(req.params.id))
      if (!item)
        return res
          .status(404)
          .json({ error: "Discovery suggestion not found." })
      const run = item.run_id
        ? await one<any>("eb_v2_discovery_runs", item.run_id)
        : null
      const sources = item.run_id
        ? await tableSelect<any>("eb_v2_discovery_sources", (query) =>
            query
              .eq("run_id", item.run_id)
              .order("created_at", { ascending: true }),
          )
        : []
      res.json({ item, run, sources })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to load Discovery detail.",
        })
    }
  })
  app.delete("/api/eb-v2/discovery/:id", async (req, res) => {
    try {
      await tableDeleteWhere("eb_v2_discovery_items", "id", text(req.params.id))
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to delete Discovery suggestion.",
        })
    }
  })
  app.delete("/api/eb-v2/discovery", async (_req, res) => {
    try {
      await tableDeleteWhere("eb_v2_discovery_items", "status", "suggested")
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to clear Discovery suggestions.",
        })
    }
  })
  app.get("/api/eb-v2/activity/:id", async (req, res) => {
    try {
      const kind = text(req.query.kind)
      const channel =
        kind === "channel"
          ? await one<any>("eb_v2_channel_outputs", text(req.params.id))
          : null
      const packageId = channel?.package_id ?? text(req.params.id)
      const item = await one<any>("eb_v2_packages", packageId)
      if (!item) return res.status(404).json({ error: "Package not found." })
      const [inputs, runs, articles, channels, discoveries] = await Promise.all(
        [
          tableSelect<any>("eb_v2_package_inputs", (query) =>
            query
              .eq("package_id", packageId)
              .order("created_at", { ascending: false }),
          ),
          tableSelect<any>("eb_v2_gate_runs", (query) =>
            query
              .eq("package_id", packageId)
              .order("created_at", { ascending: false }),
          ),
          tableSelect<any>("eb_v2_articles", (query) =>
            query
              .eq("package_id", packageId)
              .order("revision", { ascending: false }),
          ),
          tableSelect<any>("eb_v2_channel_outputs", (query) =>
            query
              .eq("package_id", packageId)
              .order("updated_at", { ascending: false }),
          ),
          tableSelect<any>("eb_v2_discovery_items", (query) =>
            query
              .eq("package_id", packageId)
              .order("updated_at", { ascending: false }),
          ),
        ],
      )
      const ids = new Set(channels.map((row) => row.id))
      const actions = (
        await tableSelect<any>("eb_v2_review_actions", (query) =>
          query.order("created_at", { ascending: false }),
        )
      ).filter((row) => ids.has(row.channel_output_id))
      const feedback = (await tableAvailable("eb_v2_feedback_threads"))
        ? await tableSelect<any>("eb_v2_feedback_threads", (query) =>
            query.eq("package_id", packageId).order("created_at", { ascending: true }),
          )
        : []
      res.json({
        package: item,
        selectedChannel: channel,
        inputs,
        runs,
        articles,
        channels,
        discoveries,
        actions,
        feedback,
      })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to load package activity.",
        })
    }
  })

  app.post("/api/eb-v2/feedback", async (req: AuthRequest, res) => {
    const itemId = text(req.body?.itemId)
    const kind = text(req.body?.kind)
    const message = text(req.body?.message)
    const model = modelFrom(req.body)
    if (!itemId || !["article", "channel"].includes(kind) || !message)
      return res.status(400).json({ error: "Choose an item and enter feedback." })
    if (!model)
      return res.status(400).json({ error: "Choose a configured AI model before refining." })
    if (!(await tableAvailable("eb_v2_feedback_threads")))
      return res.status(409).json({ error: "Feedback storage is not ready. Apply migration 009_eb_v2_feedback_learning.sql first." })
    try {
      let article = kind === "article" ? await one<any>("eb_v2_articles", itemId) : null
      // Workspace Gate 2 cards are keyed by package id, while the article itself
      // has a separate revision id. Accept either identifier without forcing the
      // client to guess which revision is active.
      if (!article && kind === "article")
        article = (
          await tableSelect<any>("eb_v2_articles", (query) =>
            query.eq("package_id", itemId).order("revision", { ascending: false }),
          )
        ).find((candidate) => !candidate.quality_report?.feedbackPending && text(candidate.body_markdown)) ?? null
      const channel = kind === "channel" ? await one<any>("eb_v2_channel_outputs", itemId) : null
      const packageId = article?.package_id ?? channel?.package_id
      if (!packageId)
        return res.status(404).json({ error: "The item to refine was not found." })
      const gate = kind === "article" ? "article" : "review"
      const userRequest = await tableInsert<any>("eb_v2_feedback_threads", {
        package_id: packageId,
        article_id: article?.id ?? channel?.article_id ?? null,
        channel_output_id: channel?.id ?? null,
        gate,
        channel: channel?.channel ?? null,
        role: "user",
        message_markdown: message,
        status: "completed",
        model_provider: model.provider,
        model_id: model.modelId,
      })
      const assistantResponse = await tableInsert<any>("eb_v2_feedback_threads", {
        package_id: packageId,
        article_id: article?.id ?? channel?.article_id ?? null,
        channel_output_id: channel?.id ?? null,
        parent_feedback_id: userRequest.id,
        gate,
        channel: channel?.channel ?? null,
        role: "assistant",
        status: "running",
        model_provider: model.provider,
        model_id: model.modelId,
      })
      void (async () => {
        try {
          if (article) {
            const staged = await reserveArticleRevision(packageId)
            await tableUpdate("eb_v2_articles", staged.id, {
              quality_report: { generationStatus: "feedback-running", feedbackPending: true, parentArticleId: article.id },
            })
            const result = await runGate(
              packageId,
              "article",
              "feedback",
              `Revise the website article below according to the editor feedback. Return the complete replacement article in Markdown only. Preserve supported facts; do not add process notes.\n\nCURRENT ARTICLE:\n${article.body_markdown}\n\nEDITOR FEEDBACK:\n${message}`,
              model,
              [],
              { feedbackRequestId: userRequest.id, parentArticleId: article.id },
            )
            await tableUpdate("eb_v2_articles", staged.id, {
              body_markdown: result.content,
              quality_report: { generationStatus: "feedback-ready", feedbackPending: true, parentArticleId: article.id },
            })
            await tableUpdate("eb_v2_feedback_threads", assistantResponse.id, {
              status: "completed",
              message_markdown: result.content,
              result_article_id: staged.id,
              model_id: result.model,
              input_tokens: result.usage.inputTokens ?? 0,
              output_tokens: result.usage.outputTokens ?? 0,
              total_tokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
            })
          } else if (channel) {
            const articleForChannel = channel.article_id
              ? await one<any>("eb_v2_articles", channel.article_id)
              : null
            const revisions = await tableSelect<any>("eb_v2_channel_outputs", (query) =>
              query.eq("package_id", packageId).eq("channel", channel.channel).order("revision", { ascending: false }).limit(1),
            )
            const staged = await tableInsert<any>("eb_v2_channel_outputs", {
              package_id: packageId,
              article_id: channel.article_id,
              channel: channel.channel,
              revision: Number(revisions[0]?.revision ?? 0) + 1,
              status: "ready_for_review",
              content: { archived: true, feedbackPending: true },
              model_provider: model.provider,
              model_id: model.modelId,
            })
            const result = await runGate(
              packageId,
              "adapt",
              `feedback:${channel.channel}`,
              `Revise this ${channel.channel} channel output according to the editor feedback. Return the complete replacement channel-ready output only. Follow all channel requirements and preserve supported facts.\n\nAPPROVED ARTICLE:\n${articleForChannel?.body_markdown ?? ""}\n\nCURRENT CHANNEL OUTPUT:\n${channel.content?.text ?? ""}\n\nEDITOR FEEDBACK:\n${message}`,
              model,
              await libraryContext(["channel-rules"]),
              { feedbackRequestId: userRequest.id, parentChannelOutputId: channel.id },
            )
            await tableUpdate("eb_v2_channel_outputs", staged.id, {
              content: { text: result.content, archived: true, feedbackPending: true, parentChannelOutputId: channel.id },
              generated_at: new Date().toISOString(),
            })
            await tableUpdate("eb_v2_feedback_threads", assistantResponse.id, {
              status: "completed",
              message_markdown: result.content,
              result_channel_output_id: staged.id,
              model_id: result.model,
              input_tokens: result.usage.inputTokens ?? 0,
              output_tokens: result.usage.outputTokens ?? 0,
              total_tokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
            })
          }
        } catch (error) {
          await tableUpdate("eb_v2_feedback_threads", assistantResponse.id, {
            status: "failed",
            error_message: error instanceof Error ? error.message : String(error),
          })
        }
      })()
      res.status(201).json({ request: userRequest, response: assistantResponse })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Unable to start feedback refinement." })
    }
  })

  app.post("/api/eb-v2/feedback/:id/accept", async (_req, res) => {
    try {
      const feedback = await one<any>("eb_v2_feedback_threads", text(_req.params.id))
      if (!feedback || feedback.role !== "assistant" || feedback.status !== "completed")
        return res.status(404).json({ error: "A completed feedback response was not found." })
      if (feedback.result_article_id) {
        const staged = await one<any>("eb_v2_articles", feedback.result_article_id)
        if (!staged) return res.status(404).json({ error: "The feedback article revision was not found." })
        const articles = await tableSelect<any>("eb_v2_articles", (query) => query.eq("package_id", feedback.package_id))
        await Promise.all(articles.filter((article) => article.id !== staged.id && article.status !== "superseded").map((article) => tableUpdate("eb_v2_articles", article.id, { status: "superseded" })))
        await tableUpdate("eb_v2_articles", staged.id, { status: "draft", quality_report: { ...(staged.quality_report ?? {}), feedbackPending: false, acceptedFeedbackId: feedback.id } })
        await tableUpdate("eb_v2_packages", feedback.package_id, { state: "article" })
      }
      if (feedback.result_channel_output_id) {
        const staged = await one<any>("eb_v2_channel_outputs", feedback.result_channel_output_id)
        if (!staged) return res.status(404).json({ error: "The feedback channel revision was not found." })
        const outputs = await tableSelect<any>("eb_v2_channel_outputs", (query) => query.eq("package_id", feedback.package_id).eq("channel", staged.channel))
        await Promise.all(outputs.filter((output) => output.id !== staged.id && !output.content?.archived).map((output) => tableUpdate("eb_v2_channel_outputs", output.id, { status: "rejected", content: { ...(output.content ?? {}), archived: true, archivedAt: new Date().toISOString() } })))
        await tableUpdate("eb_v2_channel_outputs", staged.id, { content: { ...(staged.content ?? {}), archived: false, feedbackPending: false, acceptedFeedbackId: feedback.id }, status: "ready_for_review" })
        await tableUpdate("eb_v2_packages", feedback.package_id, { state: "review" })
      }
      const parent = feedback.parent_feedback_id ? await one<any>("eb_v2_feedback_threads", feedback.parent_feedback_id) : null
      await tableUpdate("eb_v2_feedback_threads", feedback.id, { status: "accepted" })
      await tableUpsert("eb_v2_learning_signals", {
        feedback_id: feedback.id,
        package_id: feedback.package_id,
        gate: feedback.gate,
        channel: feedback.channel,
        instruction: text(parent?.message_markdown),
        active: true,
      }, "feedback_id")
      res.json(await workspace())
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Unable to accept feedback revision." })
    }
  })

  app.get("/api/eb-v2/learning-signals", async (_req, res) => {
    try {
      if (!(await tableAvailable("eb_v2_learning_signals")))
        return res.status(409).json({ error: "Feedback storage is not ready. Apply migration 009_eb_v2_feedback_learning.sql first." })
      res.json({ signals: await tableSelect<any>("eb_v2_learning_signals", (query) => query.order("created_at", { ascending: false })) })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Unable to load editorial learnings." })
    }
  })
  app.patch("/api/eb-v2/learning-signals/:id", async (req, res) => {
    try {
      const signal = await tableUpdate("eb_v2_learning_signals", text(req.params.id), {
        ...(typeof req.body?.active === "boolean" ? { active: req.body.active } : {}),
        ...(text(req.body?.instruction) ? { instruction: text(req.body.instruction) } : {}),
      })
      res.json({ signal })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Unable to update editorial learning." })
    }
  })
  app.delete("/api/eb-v2/learning-signals/:id", async (req, res) => {
    try {
      await tableDeleteWhere("eb_v2_learning_signals", "id", text(req.params.id))
      res.status(204).end()
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Unable to delete editorial learning." })
    }
  })

  app.post("/api/eb-v2/packages", async (req: AuthRequest, res) => {
    const inputText = text(req.body?.inputText)
    const title =
      text(req.body?.title) || inputText.slice(0, 120) || "Untitled EB package"
    const model = modelFrom(req.body)
    if (!inputText)
      return res.status(400).json({ error: "Input text is required." })
    if (!model)
      return res
        .status(400)
        .json({
          error: "Choose a configured Brief AI model before analysing input.",
        })
    try {
      const item = await tableInsert<any>("eb_v2_packages", {
        title,
        state: "brief",
        source_type: text(req.body?.sourceType) || "input",
        created_by: req.auth?.userId ?? null,
      })
      await tableInsert("eb_v2_package_inputs", {
        package_id: item.id,
        input_text: inputText,
        raw_snapshot: { sourceType: req.body?.sourceType ?? "input" },
      })
      if (
        text(req.body?.sourceType) === "discovery" &&
        text(req.body?.discoveryId)
      )
        await tableUpdate("eb_v2_discovery_items", text(req.body.discoveryId), {
          status: "used",
          package_id: item.id,
        })
      void (async () => {
        try {
          await runGate(
            item.id,
            "brief",
            stages.brief,
            `Extract and validate this employer-brand writing input. Return a concise brief with evidence, missing facts, suggested EVP pillar, persona, and article angle.\n\nINPUT:\n${inputText}`,
            model,
            await libraryContext(),
          )
          await tableUpdate("eb_v2_packages", item.id, {
            title,
            updated_at: new Date().toISOString(),
          })
        } catch (error) {
          console.error("[eb-v2] brief failed:", error)
        }
      })()
      res.status(201).json({ package: item })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error ? error.message : "Unable to create Brief.",
        })
    }
  })
  app.post(
    "/api/eb-v2/packages/upload",
    upload.single("file"),
    async (req: AuthRequest, res) => {
      const file = req.file
      const model = {
        provider: text(req.body?.provider),
        modelId: text(req.body?.modelId),
      }
      if (!file) return res.status(400).json({ error: "A file is required." })
      if (!model.provider || !model.modelId)
        return res
          .status(400)
          .json({ error: "Choose a Brief AI model before analysing a file." })
      try {
        const inputText = await extractDocumentText(
          file.buffer,
          file.originalname,
        )
        if (!inputText.trim())
          return res
            .status(400)
            .json({ error: "The uploaded file did not contain readable text." })
        const item = await tableInsert<any>("eb_v2_packages", {
          title: file.originalname,
          state: "brief",
          source_type: "upload",
          created_by: req.auth?.userId ?? null,
        })
        await tableInsert("eb_v2_package_inputs", {
          package_id: item.id,
          input_text: inputText,
          upload_name: file.originalname,
          raw_snapshot: { mimeType: file.mimetype, byteSize: file.size },
        })
        void (async () => {
          try {
            await runGate(
              item.id,
              "brief",
              stages.brief,
              `Extract and validate this employer-brand input from ${file.originalname}. Return a concise brief with evidence, missing facts, suggested EVP pillar, persona, and article angle.\n\nINPUT:\n${inputText.slice(0, 60000)}`,
              model,
              await libraryContext(),
            )
          } catch (error) {
            console.error("[eb-v2] uploaded brief failed:", error)
          }
        })()
        res.status(201).json({ package: item })
      } catch (error) {
        res
          .status(500)
          .json({
            error:
              error instanceof Error
                ? error.message
                : "Unable to analyse uploaded file.",
          })
      }
    },
  )
  app.post("/api/eb-v2/discovery", async (req, res) => {
    const model = modelFrom(req.body)
    if (!model)
      return res
        .status(400)
        .json({ error: "Choose a Brief AI model before running Discovery." })
    try {
      const settingsRow = (
        await tableSelect<any>("eb_v2_app_settings", (query) => query.limit(1))
      )[0]
      const runtime = settingsRow?.settings?.ebRuntimeSettings ?? {}
      const extraUrls = Array.isArray(req.body?.sourceUrls)
        ? req.body.sourceUrls
            .map(text)
            .filter((value: string) => /^https?:\/\//i.test(value))
            .slice(
              0,
              Math.min(
                12,
                Math.max(1, Number(runtime.discoveryMaxUserUrls) || 8),
              ),
            )
        : []
      const run = await tableInsert<any>("eb_v2_discovery_runs", {
        model_provider: model.provider,
        model_id: model.modelId,
        requested_sources: [
          "Brands Vietnam",
          "Vietcetera",
          "Google News VN",
          "Reddit",
          ...extraUrls,
        ],
      })
      const terms = (value: unknown) =>
        String(value ?? "")
          .split(/[\n,]/)
          .map(text)
          .filter(Boolean)
      const googleQueries = terms(runtime.discoveryGoogleQueries)
      const redditQueries = terms(runtime.discoveryRedditQueries)
      const research = await collectDiscoveryResearch(extraUrls, {
        windowMonths: Number(runtime.discoveryWindowMonths) || 4,
        redditMinUpvotes: Number(runtime.discoveryRedditMinUpvotes) || 20,
        redditMinReplies: Number(runtime.discoveryRedditMinReplies) || 5,
        timeoutMs: Number(runtime.discoveryTimeoutMs) || 9000,
        ...(googleQueries.length ? { googleQueries } : {}),
        ...(redditQueries.length ? { redditQueries } : {}),
        fitIncludeTerms: terms(runtime.discoveryFitIncludeTerms),
        fitExcludeTerms: terms(runtime.discoveryFitExcludeTerms),
        sources: runtime.discoverySources,
      })
      const savedSources = await Promise.all(
        research.sources.map((source) =>
          tableInsert<any>("eb_v2_discovery_sources", {
            run_id: run.id,
            source_type: source.sourceType,
            source_name: source.sourceName,
            url: source.url,
            title: source.title,
            excerpt: source.excerpt ?? null,
            language: source.language,
            published_at: source.publishedAt ?? null,
            engagement: source.engagement ?? {},
            eligibility: source.eligibility,
          }),
        ),
      )
      const eligible = savedSources.filter(
        (source) => source.eligibility === "eligible",
      )
      const library = await libraryContext()
      const prompt = `Use ONLY the dated source records below. A topic is trending only when it cites at least two independent source IDs, including one Vietnamese source. Return JSON only: {"trending":[{"title":"","sourceIds":["uuid"],"reason":"","ebAngle":"","pillarCandidate":""}]}. Return at most 5; use an empty list if evidence is thin. Use the EB library only to judge fit and pillar; never cite it as trend proof.\n\nSOURCES:\n${eligible.map((source) => `[${source.id}] ${source.source_name} | ${source.language} | ${source.published_at} | ${source.title} | ${source.excerpt ?? ""}`).join("\n")}\n\nEB LIBRARY:\n${library.join("\n\n")}`
      const result = eligible.length
        ? await generate({
            provider: model.provider,
            modelId: model.modelId,
            maxTokens: 1100,
            temperature: 0.25,
            prompt,
          })
        : { content: '{"trending":[]}', usage: null }
      let topics: any[] = []
      try {
        const parsed = JSON.parse(
          jsonrepair(
            String(result.content)
              .replace(/^```(?:json)?|```$/g, "")
              .trim(),
          ),
        )
        topics = Array.isArray(parsed?.trending) ? parsed.trending : []
      } catch {}
      const sourceById = new Map(
        savedSources.map((source) => [source.id, source]),
      )
      const items: any[] = []
      for (const topic of topics.slice(
        0,
        Math.min(5, Math.max(1, Number(runtime.discoveryMaxTopics) || 5)),
      )) {
        const ids: string[] = Array.isArray(topic?.sourceIds)
          ? topic.sourceIds.filter(
              (id: unknown): id is string =>
                typeof id === "string" && sourceById.has(id),
            )
          : []
        const sources: any[] = ids.map((id: string) => sourceById.get(id)!)
        if (
          !text(topic?.title) ||
          new Set(sources.map((source: any) => source.source_name)).size < 2 ||
          !sources.some((source: any) => source.language === "vi")
        )
          continue
        // Insert independently so a later invalid topic or persistence failure never removes
        // suggestions that have already passed the evidence gate in this Discovery run.
        items.push(
          await tableInsert<any>("eb_v2_discovery_items", {
            run_id: run.id,
            title: text(topic.title).slice(0, 220),
            source_summary: text(topic.reason),
            pillar_candidate: text(topic.pillarCandidate) || null,
            status: "suggested",
            evidence: [
              {
                kind: "research_topic",
                sourceIds: ids,
                ebAngle: text(topic.ebAngle),
              },
              {
                kind: "ai_run",
                provider: model.provider,
                modelId: model.modelId,
                prompt,
                generatedAt: new Date().toISOString(),
                usage: result.usage ?? null,
                output: result.content,
              },
            ],
          }),
        )
      }
      const uncategorized = savedSources
        .filter((source) => source.eligibility === "undated")
        .slice(0, 5)
        .map((source) => ({
          id: source.id,
          title: source.title,
          url: source.url,
          sourceName: source.source_name,
          excerpt: source.excerpt,
          classification: "uncategorized",
        }))
      await tableUpdate("eb_v2_discovery_runs", run.id, {
        coverage: research.coverage,
        prompt,
        raw_output: String(result.content),
        completed_at: new Date().toISOString(),
      })
      res
        .status(201)
        .json({
          items,
          uncategorized,
          coverage: research.coverage,
          runId: run.id,
        })
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error ? error.message : "Unable to run Discovery.",
        })
    }
  })

  app.post("/api/eb-v2/packages/:id/approve-brief", async (req, res) => {
    const model = modelFrom(req.body)
    if (!model)
      return res.status(400).json({ error: "Choose a Gate 2 AI model." })
    try {
      const item = await one<any>("eb_v2_packages", req.params.id)
      if (!item) return res.status(404).json({ error: "Package not found." })
      await tableUpdate("eb_v2_packages", item.id, {
        state: "article",
        brief_approved_at: new Date().toISOString(),
      })
      await archiveArticles(item.id)
      const articleRevision = await reserveArticleRevision(item.id)
      void (async () => {
        try {
          const input = (
            await tableSelect<any>("eb_v2_package_inputs", (query) =>
              query
                .eq("package_id", item.id)
                .order("created_at", { ascending: false })
                .limit(1),
            )
          )[0]
          const briefRuns = await tableSelect<any>("eb_v2_gate_runs", (query) =>
            query
              .eq("package_id", item.id)
              .eq("gate", "brief")
              .eq("status", "completed")
              .order("created_at", { ascending: false })
              .limit(1),
          )
          const brief = briefRuns[0]?.output_snapshot?.content ?? ""
          const source = input?.input_text ?? item.title
          const docs = await libraryContext()
          const spec = await runGate(
            item.id,
            "article",
            stages.article[0],
            `Create an Article Spec for fab.careers from this approved brief.\nBRIEF:\n${brief}\nSOURCE:\n${source}`,
            model,
            docs,
          )
          const outline = await runGate(
            item.id,
            "article",
            stages.article[1],
            `Create a structured, evidence-led outline using this Article Spec.\n${spec.content}`,
            model,
            [],
          )
          const draft = await runGate(
            item.id,
            "article",
            stages.article[2],
            `Write the fab.careers article in Markdown from this outline. Do not invent facts.\nOUTLINE:\n${outline.content}`,
            model,
            [],
          )
          await tableUpdate("eb_v2_articles", articleRevision.id, {
            article_spec: { content: spec.content },
            outline: [{ content: outline.content }],
            body_markdown: draft.content,
            quality_report: { generationStatus: "completed" },
            updated_at: new Date().toISOString(),
          })
        } catch (error) {
          await tableUpdate("eb_v2_articles", articleRevision.id, {
            quality_report: { generationStatus: "failed", error: error instanceof Error ? error.message : String(error) },
            updated_at: new Date().toISOString(),
          })
          console.error("[eb-v2] article draft failed:", error)
        }
      })()
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to generate website article.",
        })
    }
  })

  app.post("/api/eb-v2/packages/:id/approve-article", async (req, res) => {
    const model = modelFrom(req.body, "adaptModel")
    if (!model)
      return res.status(400).json({ error: "Choose an Adapt AI model." })
    try {
      const item = await one<any>("eb_v2_packages", req.params.id)
      if (!item) return res.status(404).json({ error: "Package not found." })
      let article = (
        await tableSelect<any>("eb_v2_articles", (query) =>
          query
            .eq("package_id", item.id)
            .eq("status", "draft")
            .order("revision", { ascending: false })
            .limit(1),
        )
      )[0]
      // Back-to-Article reuses the latest saved draft and costs no AI tokens.
      if (!article) article = await reopenLatestArticle(item.id)
      if (!article)
        return res
          .status(409)
          .json({
            error:
              "No saved website article is available. Regenerate Gate 2 to create one.",
          })
      await tableUpdate("eb_v2_articles", article.id, {
        status: "approved",
        approved_at: new Date().toISOString(),
      })
      const outputs = await Promise.all(
        ["threads", "facebook", "linkedin"].map((channel) =>
          tableInsert<any>("eb_v2_channel_outputs", {
            package_id: item.id,
            article_id: article.id,
            channel,
            revision: 1,
            status: "queued",
            content: {},
            model_provider: model.provider,
            model_id: model.modelId,
          }),
        ),
      )
      await tableUpdate("eb_v2_packages", item.id, {
        state: "adapt",
        article_approved_at: new Date().toISOString(),
      })
      void (async () => {
        const docs = await libraryContext(["channel-rules"])
        try {
          await Promise.all(
            outputs.map(async (output) => {
              await tableUpdate("eb_v2_channel_outputs", output.id, {
                status: "generating",
              })
              const result = await runGate(
                item.id,
                "adapt",
                `${stages.adapt}:${output.channel}`,
                adaptTask(output.channel, article.body_markdown),
                model,
                docs,
              )
              await tableUpdate("eb_v2_channel_outputs", output.id, {
                status: "ready_for_review",
                content: { text: result.content },
                generated_at: new Date().toISOString(),
              })
            }),
          )
          const reviewModel = await repetitionModel(model)
          if (reviewModel) {
            const completed = await tableSelect<any>(
              "eb_v2_channel_outputs",
              (query) =>
                query
                  .eq("package_id", item.id)
                  .eq("status", "ready_for_review"),
            )
            await runGate(
              item.id,
              "review",
              stages.review,
              `Check these channel outputs against the approved article for repetition of the idea, hook, claims and format. List concrete overlaps and a short recommendation for the human reviewer.\n\nARTICLE:\n${article.body_markdown}\n\nCHANNEL OUTPUTS:\n${completed.map((output) => `${output.channel}: ${output.content?.text ?? ""}`).join("\n\n")}`,
              reviewModel,
              docs,
            )
          }
          await tableUpdate("eb_v2_packages", item.id, { state: "review" })
        } catch (error) {
          console.error("[eb-v2] channel adaptation failed:", error)
        }
      })()
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to adapt channels.",
        })
    }
  })

  app.post("/api/eb-v2/packages/:id/regenerate", async (req, res) => {
    const stage = text(req.body?.stage)
    const model = modelFrom(req.body)
    if (!["brief", "article"].includes(stage))
      return res
        .status(400)
        .json({ error: "Choose Brief or Website article to regenerate." })
    if (!model)
      return res
        .status(400)
        .json({ error: "Choose a configured AI model before regenerating." })
    try {
      const item = await one<any>("eb_v2_packages", text(req.params.id))
      if (!item) return res.status(404).json({ error: "Package not found." })
      if (stage === "brief") {
        await archiveOutputs(item.id)
        await archiveArticles(item.id)
        await tableUpdate("eb_v2_packages", item.id, {
          state: "brief",
          updated_at: new Date().toISOString(),
        })
        void (async () => {
          try {
            const input = (
              await tableSelect<any>("eb_v2_package_inputs", (query) =>
                query
                  .eq("package_id", item.id)
                  .order("created_at", { ascending: false })
                  .limit(1),
              )
            )[0]
            await runGate(
              item.id,
              "brief",
              stages.brief,
              `Extract and validate this employer-brand writing input. Return a concise brief with evidence, missing facts, suggested EVP pillar, persona, and article angle.\n\nINPUT:\n${input?.input_text ?? item.title}`,
              model,
              await libraryContext(),
            )
          } catch (error) {
            console.error("[eb-v2] brief regeneration failed:", error)
          }
        })()
      } else {
        await archiveOutputs(item.id)
        await archiveArticles(item.id)
        const articleRevision = await reserveArticleRevision(item.id)
        await tableUpdate("eb_v2_packages", item.id, {
          state: "article",
          updated_at: new Date().toISOString(),
        })
        void (async () => {
          try {
            const input = (
              await tableSelect<any>("eb_v2_package_inputs", (query) =>
                query
                  .eq("package_id", item.id)
                  .order("created_at", { ascending: false })
                  .limit(1),
              )
            )[0]
            const briefRuns = await tableSelect<any>(
              "eb_v2_gate_runs",
              (query) =>
                query
                  .eq("package_id", item.id)
                  .eq("gate", "brief")
                  .eq("status", "completed")
                  .order("created_at", { ascending: false })
                  .limit(1),
            )
            const brief = briefRuns[0]?.output_snapshot?.content ?? ""
            const docs = await libraryContext()
            const spec = await runGate(
              item.id,
              "article",
              stages.article[0],
              `Create an Article Spec for fab.careers from this approved brief.\nBRIEF:\n${brief}\nSOURCE:\n${input?.input_text ?? item.title}`,
              model,
              docs,
            )
            const outline = await runGate(
              item.id,
              "article",
              stages.article[1],
              `Create a structured, evidence-led outline using this Article Spec.\n${spec.content}`,
              model,
              [],
            )
            const draft = await runGate(
              item.id,
              "article",
              stages.article[2],
              `Write the fab.careers article in Markdown from this outline. Do not invent facts.\nOUTLINE:\n${outline.content}`,
              model,
              [],
            )
            await tableUpdate("eb_v2_articles", articleRevision.id, {
              article_spec: { content: spec.content },
              outline: [{ content: outline.content }],
              body_markdown: draft.content,
              quality_report: { generationStatus: "completed" },
              updated_at: new Date().toISOString(),
            })
          } catch (error) {
            await tableUpdate("eb_v2_articles", articleRevision.id, {
              quality_report: { generationStatus: "failed", error: error instanceof Error ? error.message : String(error) },
              updated_at: new Date().toISOString(),
            })
            console.error("[eb-v2] article regeneration failed:", error)
          }
        })()
      }
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to regenerate package.",
        })
    }
  })

  app.post("/api/eb-v2/packages/:id/move", async (req, res) => {
    const target = text(req.body?.target)
    if (!["brief", "article"].includes(target))
      return res
        .status(400)
        .json({ error: "Choose Brief or Website article as the destination." })
    try {
      const item = await one<any>("eb_v2_packages", text(req.params.id))
      if (!item) return res.status(404).json({ error: "Package not found." })
      await archiveOutputs(item.id)
      if (target === "brief") await archiveArticles(item.id)
      if (target === "article") await reopenLatestArticle(item.id)
      await tableUpdate("eb_v2_packages", item.id, {
        state: target,
        updated_at: new Date().toISOString(),
      })
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error ? error.message : "Unable to move package.",
        })
    }
  })

  app.post("/api/eb-v2/channel-outputs/:id/regenerate", async (req, res) => {
    const model = modelFrom(req.body)
    if (!model)
      return res
        .status(400)
        .json({ error: "Choose an Adapt AI model before regenerating." })
    try {
      const output = await one<any>(
        "eb_v2_channel_outputs",
        text(req.params.id),
      )
      if (!output)
        return res.status(404).json({ error: "Channel output not found." })
      const article = output.article_id
        ? await one<any>("eb_v2_articles", output.article_id)
        : (
            await tableSelect<any>("eb_v2_articles", (query) =>
              query
                .eq("package_id", output.package_id)
                .order("revision", { ascending: false })
                .limit(1),
            )
          )[0]
      if (!article)
        return res
          .status(409)
          .json({ error: "No website article is available for this channel." })
      await tableUpdate("eb_v2_channel_outputs", output.id, {
        status: "rejected",
        content: {
          ...(output.content ?? {}),
          archived: true,
          archivedAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      const replacement = await tableInsert<any>("eb_v2_channel_outputs", {
        package_id: output.package_id,
        article_id: article.id,
        channel: output.channel,
        revision: Number(output.revision ?? 0) + 1,
        status: "generating",
        content: {},
        model_provider: model.provider,
        model_id: model.modelId,
      })
      void (async () => {
        try {
          const result = await runGate(
            output.package_id,
            "adapt",
            `${stages.adapt}:${output.channel}`,
            adaptTask(output.channel, article.body_markdown),
            model,
            await libraryContext(["channel-rules"]),
          )
          await tableUpdate("eb_v2_channel_outputs", replacement.id, {
            status: "ready_for_review",
            content: { text: result.content },
            model_provider: model.provider,
            model_id: result.model,
            generated_at: new Date().toISOString(),
          })
        } catch (error) {
          await tableUpdate("eb_v2_channel_outputs", replacement.id, {
            status: "failed",
            updated_at: new Date().toISOString(),
          })
          console.error("[eb-v2] channel regeneration failed:", error)
        }
      })()
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to regenerate channel output.",
        })
    }
  })

  app.post(
    "/api/eb-v2/channel-outputs/:id/review",
    async (req: AuthRequest, res) => {
      const action = text(req.body?.action)
      if (!["done", "reject", "recheck"].includes(action))
        return res.status(400).json({ error: "Invalid review action." })
      try {
        const output = await one<any>(
          "eb_v2_channel_outputs",
          text(req.params.id),
        )
        if (!output)
          return res.status(404).json({ error: "Channel output not found." })
        await tableInsert("eb_v2_review_actions", {
          channel_output_id: output.id,
          action,
          note: text(req.body?.note) || null,
          created_by: req.auth?.userId ?? null,
        })
        await tableUpdate("eb_v2_channel_outputs", output.id, {
          status:
            action === "done"
              ? "done"
              : action === "reject"
                ? "rejected"
                : "recheck",
          completed_at: action === "done" ? new Date().toISOString() : null,
        })
        res.json(await workspace())
      } catch (error) {
        res
          .status(500)
          .json({
            error:
              error instanceof Error
                ? error.message
                : "Unable to save review action.",
          })
      }
    },
  )

  // Deleting a package is scoped to V2 only; foreign-key cascades remove its
  // inputs, runs, article revisions, channel outputs and review actions.
  app.delete("/api/eb-v2/packages/:id", async (req, res) => {
    try {
      await tableDeleteWhere("eb_v2_packages", "id", text(req.params.id))
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to delete EB package.",
        })
    }
  })
  // A reviewer may remove one channel output without deleting its package.
  app.delete("/api/eb-v2/channel-outputs/:id", async (req, res) => {
    try {
      await tableDeleteWhere("eb_v2_channel_outputs", "id", text(req.params.id))
      res.json(await workspace())
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to delete channel output.",
        })
    }
  })
}
