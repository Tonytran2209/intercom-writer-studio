import { useState, useEffect, useCallback, useRef } from "react"
import type {
  AICallUsage,
  Article,
  AppConfig,
  ContentPlan,
  ContentPlanItem,
  DocumentFile,
} from "./types"
import { DEFAULT_CONFIG, mergeWithLatestModelCatalog } from "./lib/defaultData"
import * as db from "./lib/db"
import Sidebar from "./components/Sidebar"
import BrandMark from "./components/BrandMark"
import StepNav from "./components/StepNav"
import VerticalWorkflowRail from "./components/VerticalWorkflowRail"
import ConfigModal from "./components/config/ConfigModal"
import Step2CoreIdea from "./components/workspace/Step2CoreIdea"
import Step3Outline from "./components/workspace/Step3Outline"
import Step4Draft from "./components/workspace/Step4Draft"
import WorkspaceNotificationHost, { notifyWorkspace } from "./components/workspace/WorkspaceNotification"
import LegacyArticleView from "./components/workspace/LegacyArticleView"
import { useI18n } from "./lib/i18n"
import ActivityLauncher from "./components/ActivityLauncher"
import BatchActivity from "./components/BatchActivity"
import LoginScreen from "./components/LoginScreen"
import { clampArticleStep, gateArticleStep, gateStepCompletion } from "./lib/workflowGuards"
import { isLegacyArticle } from "./lib/legacyCompatibility"
import { isShellMode, shellUser } from "./lib/appMode"
import EbWorkingSpace from "./components/EbWorkingSpace"

function generateId() {
  return `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function createNewArticle(): Article {
  return {
    id: generateId(),
    title: "Bài viết mới",
    currentStep: 1,
    status: "planning",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function hasPasswordRecoveryLink() {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery"
}

type SyncStatus = "idle" | "loading" | "saving" | "error"
type ArticleUpdateOptions = { silent?: boolean }

export default function App() {
  const { tr } = useI18n()
  const [authSession, setAuthSession] = useState<db.AuthSession | null>(() => {
    if (isShellMode) return { accessToken: "shell", expiresAt: null, user: shellUser }
    if (hasPasswordRecoveryLink()) {
      db.clearAuthSession()
      return null
    }
    return db.getAuthSession()
  })
  const [articles, setArticles] = useState<Article[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [files, setFiles] = useState<DocumentFile[]>([])
  const [showConfig, setShowConfig] = useState(false)
  const [showBatchOverview, setShowBatchOverview] = useState(true)
  const [launcherHistoryOpen, setLauncherHistoryOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("loading")
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null)
  const [articleActionError, setArticleActionError] = useState<string | null>(
    null,
  )
  useEffect(() => {
    if (articleActionError) notifyWorkspace(articleActionError, "error")
  }, [articleActionError])
  const [completionSavingId, setCompletionSavingId] = useState<string | null>(
    null,
  )
  const [deletingArticleId, setDeletingArticleId] = useState<string | null>(
    null,
  )
  const [migratingLegacyId, setMigratingLegacyId] = useState<string | null>(null)
  const [visibleWorkflowStep, setVisibleWorkflowStep] = useState<2 | 3 | 4>(2)
  const workflowStepRefs = useRef(new Map<2 | 3 | 4, HTMLElement>())
  const articleMutationQueues = useRef(new Map<string, Promise<void>>())
  const failedArticleMutations = useRef(new Set<string>())
  const articlesRef = useRef<Article[]>([])
  const activeIdRef = useRef<string | null>(null)
  articlesRef.current = articles
  activeIdRef.current = activeId

  const scrollToWorkflowStep = useCallback((step: 2 | 3 | 4) => {
    const target = workflowStepRefs.current.get(step)
    if (!target) return
    setVisibleWorkflowStep(step)
    target.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  useEffect(() => {
    setVisibleWorkflowStep(2)
  }, [activeId])

  const enqueueArticleMutation = useCallback(
    (articleId: string, operation: () => Promise<Article>): Promise<Article> => {
      const currentQueue = articleMutationQueues.current.get(articleId) ?? Promise.resolve()
      const result = currentQueue.then(operation, operation)
      const settled = result.then(
        () => undefined,
        () => undefined,
      )
      articleMutationQueues.current.set(articleId, settled)
      void settled.then(() => {
        if (articleMutationQueues.current.get(articleId) === settled)
          articleMutationQueues.current.delete(articleId)
      })
      return result
    },
    [],
  )

  const waitForArticleMutations = useCallback((articleId: string) =>
    articleMutationQueues.current.get(articleId) ?? Promise.resolve(), [])

  // Shell mode intentionally has no external data source. Keep all edits in
  // React state so UX work cannot affect the existing production database.
  useEffect(() => {
    if (isShellMode) {
      setSyncStatus("idle")
      return
    }
    if (!authSession) {
      setSyncStatus("idle")
      return
    }
    const load = async () => {
      setSyncStatus("loading")
      setInitialLoadError(null)
      let loaded = false
      try {
        const [remoteArticles, remoteConfig, remoteFiles] = await Promise.all([
          db.fetchArticles(),
          db.fetchConfig(),
          db.fetchFiles(),
        ])

        if (remoteArticles?.length) {
          setArticles(remoteArticles.map((item) => isLegacyArticle(item)
            ? { ...item, legacyReadOnly: true }
            : { ...item, currentStep: clampArticleStep(item) }))
        }
        if (remoteConfig) {
          setConfig(mergeWithLatestModelCatalog(remoteConfig))
          // Restore railwayUrl to localStorage for aiService
          if (remoteConfig.railwayUrl) {
            localStorage.setItem("writer:railwayUrl", remoteConfig.railwayUrl)
          }
        }
        if (remoteFiles?.length) setFiles(remoteFiles)
        loaded = true
      } catch (error: unknown) {
        setInitialLoadError(
          error instanceof Error ? error.message : String(error),
        )
        setSyncStatus("error")
      } finally {
        if (loaded) setSyncStatus("idle")
      }
    }
    load()
  }, [authSession])

  const handleUpdateArticle = useCallback(
    (id: string, updates: Partial<Article>, options: ArticleUpdateOptions = {}) => {
      const previous = articlesRef.current.find((article) => article.id === id)
      setArticles((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, ...updates, updatedAt: new Date().toISOString() }
            : a,
        ),
      )
      if (!options.silent) setSyncStatus("saving")
      return enqueueArticleMutation(id, () => isShellMode
        ? Promise.resolve({ ...(previous ?? createNewArticle()), ...updates, id })
        : db.updateArticle(id, updates))
        .then(() => {
          failedArticleMutations.current.delete(id)
          if (!options.silent) setSyncStatus("idle")
          return true
        })
        .catch((error: unknown) => {
          failedArticleMutations.current.add(id)
          if (previous) {
            setArticles((current) => current.map((article) => {
              if (article.id !== id) return article
              const rollback = Object.fromEntries(
                Object.entries(updates)
                  .filter(([key, value]) => Object.is((article as unknown as Record<string, unknown>)[key], value))
                  .map(([key]) => [key, (previous as unknown as Record<string, unknown>)[key]]),
              ) as Partial<Article>
              return { ...article, ...rollback }
            }))
          }
          setArticleActionError(
            `Không đồng bộ được bài viết với Supabase: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          setSyncStatus("error")
          return false
        })
    },
    [enqueueArticleMutation],
  )

  useEffect(() => {
    const recordUsage = (event: Event) => {
      const usage = (event as CustomEvent<AICallUsage>).detail
      const articleId = usage?.articleId ?? activeIdRef.current
      const current = articlesRef.current.find((item) => item.id === articleId)
      if (!articleId || !current || !usage) return
      try {
        const summary = JSON.parse(
          localStorage.getItem("writer:usage-summary") ?? "{}",
        ) as Record<string, AICallUsage[]>
        summary[String(usage.step)] = [
          ...(summary[String(usage.step)] ?? []),
          usage,
        ].slice(-500)
        localStorage.setItem("writer:usage-summary", JSON.stringify(summary))
      } catch {
        /* usage persistence in the article remains authoritative */
      }
      const previous = current.aiUsageByStep?.[usage.step] ?? []
      const aiUsageByStep = {
        ...current.aiUsageByStep,
        [usage.step]: [...previous, usage].slice(-50),
      }
      const updated = articlesRef.current.map((item) =>
        item.id === articleId
          ? { ...item, aiUsageByStep, updatedAt: new Date().toISOString() }
          : item,
      )
      articlesRef.current = updated
      setArticles(updated)
      if (isShellMode) return
      enqueueArticleMutation(articleId, () =>
        db.updateArticle(articleId, { aiUsageByStep }),
      ).catch((error: unknown) => {
        setArticleActionError(
          `Không lưu được usage AI: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        setSyncStatus("error")
      })
    }
    window.addEventListener("writer:ai-usage", recordUsage)
    return () => window.removeEventListener("writer:ai-usage", recordUsage)
  }, [enqueueArticleMutation])

  const handleCreateActivity = async (
    type: "comparison-seo" | "editorial-originality",
    plan: ContentPlan,
    items: ContentPlanItem[],
    batchSize?: 5 | 10 | 15 | 20,
  ) => {
    const activityId = `activity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const isBatch = items.length > 1
    setArticleActionError(null)
    setSyncStatus("saving")
    const saved: Article[] = []
    try {
      const records = items.map((item, index): Article => {
        const snapshot = {
          id: item.id,
          label: item.title,
          description: item.sourceLine,
          keywords: item.keywords,
          typeGroup: type === "comparison-seo" ? "A" as const : "C" as const,
          wave: "Current activity",
          timeframe: new Date().toISOString().slice(0, 10),
          contentPlanEvidence: item.sourceLine,
          scheduleEvidence: item.sourceLine,
        }
        return {
          ...createNewArticle(),
          id: `art-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
          title: item.title,
          topic: item.title,
          keywords: item.keywords.join(", "),
          activityType: type,
          activityKind: isBatch ? "batch" : "single",
          activityId,
          contentPlanId: plan.id,
          contentPlanVersion: plan.version,
          contentPlanInput: (plan.sources ?? [])
            .map((source) => source.extractedContent)
            .join("\n\n---\n\n"),
          contentPlanSourceItemId: item.id,
          contentPlanItemId: item.id,
          batchSize,
          batchStatus: isBatch ? "queued" : undefined,
          contentType:
            type === "comparison-seo"
              ? "Comparison / SEO"
              : "Editorial / Originality",
          selectedContentTypeSuggestionId: item.id,
          selectedContentTypeSnapshot: snapshot,
          contentTypeSuggestions: [snapshot],
          currentStep: 2,
        }
      })
      for (const record of records)
        saved.push(await enqueueArticleMutation(record.id, () => isShellMode ? Promise.resolve(record) : db.saveArticle(record)))
      setArticles((current) => [...saved, ...current])
      setActiveId(saved[0]?.id ?? null)
      setShowBatchOverview(isBatch)
      if (isBatch && !isShellMode) await db.startBatch(activityId)
      setSyncStatus("idle")
    } catch (error: unknown) {
      if (saved.length) {
        const createdActivityId = saved[0]?.activityId
        if (createdActivityId && saved[0]?.activityKind === "batch")
          await db.deleteBatch(createdActivityId).catch(() => undefined)
        else
          await Promise.allSettled(saved.map((item) => db.deleteArticle(item.id)))
      }
      setArticleActionError(
        `Không tạo được activity trong Supabase: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      setSyncStatus("error")
    }
  }

  const handleToggleComplete = useCallback(
    async (target: Article) => {
      if (completionSavingId) return
      const isDone = target.status === "done"
      const updates: Partial<Article> = isDone
        ? { status: "review", completedAt: null }
        : {
            status: "done",
            currentStep: 4,
            completedAt: new Date().toISOString(),
          }

      setArticleActionError(null)
      setCompletionSavingId(target.id)
      setSyncStatus("saving")
      try {
        const savedArticle = await enqueueArticleMutation(target.id, () =>
          isShellMode ? Promise.resolve({ ...target, ...updates }) : db.updateArticle(target.id, updates),
        )
        setArticles((prev) =>
          prev.map((item) => (item.id === target.id ? savedArticle : item)),
        )
        setSyncStatus("idle")
        notifyWorkspace(isDone ? "Đã mở lại bài viết." : "Đã đánh dấu bài viết hoàn thành.", "success")
      } catch (error: unknown) {
        setArticleActionError(
          `Không lưu được trạng thái bài viết vào Supabase: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        setSyncStatus("error")
      } finally {
        setCompletionSavingId(null)
      }
    },
    [completionSavingId, enqueueArticleMutation],
  )

  const handleMigrateLegacy = useCallback(async (target: Article) => {
    if (migratingLegacyId) return
    setMigratingLegacyId(target.id)
    setArticleActionError(null)
    try {
      const copy = await db.migrateLegacyArticle(target.id)
      setArticles((current) => [copy, ...current])
      setActiveId(copy.id)
      setShowBatchOverview(false)
    } catch (error) {
      setArticleActionError(
        `${tr("Không tạo được bản workflow mới", "Could not create current-workflow copy")}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setMigratingLegacyId(null)
    }
  }, [migratingLegacyId, tr])

  const handleDeleteArticle = useCallback(
    async (target: Article) => {
      if (deletingArticleId) return
      const targets =
        target.activityKind === "batch" && target.activityId
          ? articles.filter((item) => item.activityId === target.activityId)
          : [target]
      const confirmed = window.confirm(
        targets.length > 1
          ? `Xoá vĩnh viễn batch gồm ${targets.length} bài khỏi Supabase? Thao tác này không thể hoàn tác.`
          : isLegacyArticle(target)
            ? `Xoá vĩnh viễn bài legacy “${target.title || target.topic}” khỏi cả kho lưu trữ cũ và Supabase? Thao tác này không thể hoàn tác.`
            : `Xoá vĩnh viễn bài viết “${target.title}” khỏi Supabase? Thao tác này không thể hoàn tác.`,
      )
      if (!confirmed) return

      setArticleActionError(null)
      setDeletingArticleId(target.id)
      setSyncStatus("saving")
      const previousArticles = articles
      const previousActiveId = activeId
      const targetIds = new Set(targets.map((item) => item.id))
      const remaining = articles.filter((item) => !targetIds.has(item.id))
      setArticles(remaining)
      if (activeId && targetIds.has(activeId)) setActiveId(remaining[0]?.id ?? null)
      try {
        // Finish any content save already queued before deleting the database record.
        await Promise.all(targets.map((item) => waitForArticleMutations(item.id)))
        if (!isShellMode && target.activityKind === "batch" && target.activityId)
          await db.deleteBatch(target.activityId)
        else if (!isShellMode)
          await db.deleteArticle(target.id)
        setSyncStatus("idle")
        notifyWorkspace(targets.length > 1 ? `Đã xóa batch gồm ${targets.length} bài.` : "Đã xóa bài viết.", "success")
      } catch (error: unknown) {
        setArticles(previousArticles)
        setActiveId(previousActiveId)
        setArticleActionError(
          `Không xoá được bài viết khỏi Supabase: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        setSyncStatus("error")
      } finally {
        setDeletingArticleId(null)
      }
    },
    [activeId, articles, deletingArticleId, waitForArticleMutations],
  )

  const handleSaveConfig = async (
    newConfig: AppConfig,
    newFiles: DocumentFile[],
  ) => {
    setConfig(newConfig)
    setFiles(newFiles)
    if (!isShellMode && newConfig.railwayUrl)
      localStorage.setItem("writer:railwayUrl", newConfig.railwayUrl)
    setSyncStatus("saving")
    try {
      if (!isShellMode) await Promise.all([
        db.saveConfig(newConfig),
        db.saveFiles(newFiles, newConfig.railwayUrl),
      ])
      setSyncStatus("idle")
    } catch {
      setSyncStatus("error")
    }
  }

  const handleComposerModelChange = (modelId: string) => {
    const next = {
      ...config,
      // Storage step 1 is now the Content Plan classifier, not an article step.
      stepConfigs: {
        ...config.stepConfigs,
        1: { ...config.stepConfigs[1], modelId },
      },
    }
    setConfig(next)
    if (!isShellMode) void db
      .saveConfig(next)
      .catch((error) =>
        setArticleActionError(
          `Không lưu được model: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
  }

  const article = activeId
    ? (articles.find((a) => a.id === activeId) ?? null)
    : null

  useEffect(() => {
    const workspace = document.querySelector<HTMLElement>(".continuous-workspace")
    if (!workspace) return
    let frame = 0
    const updateActiveStep = () => {
      frame = 0
      const anchor = workspace.getBoundingClientRect().top + Math.min(180, workspace.clientHeight * 0.24)
      const sections = [...workflowStepRefs.current.entries()]
        .filter(([, node]) => node.isConnected)
        .sort(([, left], [, right]) => left.offsetTop - right.offsetTop)
      if (!sections.length) return
      const current = sections.reduce((selected, candidate) =>
        candidate[1].getBoundingClientRect().top <= anchor ? candidate : selected,
      sections[0])
      setVisibleWorkflowStep(current[0])
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateActiveStep)
    }
    updateActiveStep()
    workspace.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      workspace.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [article?.id, article?.selectedCoreIdeaId, article?.outline?.length])
  const activeBatchIds = Array.from(new Set(
    articles
      .filter((item) => item.activityKind === "batch" && item.activityId && !["completed", "failed"].includes(item.batchStatus ?? "queued"))
      .map((item) => item.activityId as string),
  )).sort().join(",")

  useEffect(() => {
    const activityIds = activeBatchIds.split(",").filter(Boolean)
    if (isShellMode || !activityIds.length) return
    let stopped = false
    const refresh = async () => {
      try {
        const results = await Promise.all(activityIds.map((activityId) => db.fetchBatch(activityId)))
        if (stopped) return
        setArticles((current) => {
          const remoteArticles = results.flatMap((result) => result.articles)
          const remoteById = new Map(remoteArticles.map((item) => [item.id, item]))
          const currentIds = new Set(current.map((item) => item.id))
          let changed = false
          const merged = current.map((item) => {
            const remote = remoteById.get(item.id)
            if (!remote || remote.updatedAt === item.updatedAt) return item
            changed = true
            return remote
          })
          const added = remoteArticles.filter((item) => !currentIds.has(item.id))
          if (added.length) changed = true
          return changed ? [...added, ...merged] : current
        })
      } catch {
        /* retain the last durable snapshot while Railway reconnects */
      }
    }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [activeBatchIds])

  const handleStepChange = async (step: number) => {
    if (!article) return
    const requestedStep = Math.min(4, Math.max(2, step)) as 2 | 3 | 4
    if (requestedStep === article.currentStep) return
    const movingForward = requestedStep > article.currentStep
    const gate = gateArticleStep(article, requestedStep)
    if (!gate.allowed) {
      setArticleActionError(tr(gate.reasonVi, gate.reason))
      return
    }
    if (movingForward) await waitForArticleMutations(article.id)
    if (movingForward && failedArticleMutations.current.has(article.id)) {
      setArticleActionError(tr("Không thể chuyển bước vì dữ liệu của thao tác trước chưa được lưu vào Supabase.", "Cannot change steps because the previous update was not saved to Supabase."))
      return
    }
    setArticleActionError(null)
    await handleUpdateArticle(article.id, { currentStep: requestedStep }, { silent: true })
  }

  const handleNext = async () => {
    if (!article) return
    const currentStep = Math.min(4, Math.max(2, article.currentStep)) as 2 | 3 | 4
    const completion = gateStepCompletion(article, currentStep)
    if (!completion.allowed) {
      setArticleActionError(tr(completion.reasonVi, completion.reason))
      return
    }
    const next = Math.min(Math.max(article.currentStep, 2) + 1, 4)
    // Wait for the selected output from the current step to reach Supabase
    // before exposing the next step and its AI controls.
    await waitForArticleMutations(article.id)
    if (failedArticleMutations.current.has(article.id)) {
      setArticleActionError(tr("Không thể tiếp tục vì output hoặc lựa chọn hiện tại chưa được lưu vào Supabase.", "Cannot continue because the current output or selection was not saved to Supabase."))
      return
    }
    setArticleActionError(null)
    await handleUpdateArticle(article.id, {
      currentStep: next,
      status: next === 4 ? "review" : "in_progress",
    }, { silent: true })
  }

  const handlePrev = () => {
    if (!article) return
    const previousStep = Math.max(article.currentStep - 1, 2)
    if (previousStep === article.currentStep) return
    void handleUpdateArticle(article.id, { currentStep: previousStep }, { silent: true })
  }

  const stepCfg = article ? config.stepConfigs[article.currentStep] : null
  const currentModel =
    (stepCfg?.modelId
      ? config.models.find((m) => m.id === stepCfg.modelId && m.enabled)
      : null) ||
    config.models.find((m) => m.enabled) ||
    undefined

  // ── Loading screen ──
  if (!authSession) {
    return <LoginScreen
      onLogin={async (email, password) => setAuthSession(await db.login(email, password))}
      onSignUp={db.signUp}
      onForgotPassword={db.requestPasswordReset}
      onResetPassword={db.resetPassword}
    />
  }

  if (syncStatus === "loading") {
    return (
      <div className="codex-dark h-dvh flex items-center justify-center bg-[#141414]">
        <div className="text-center space-y-3">
          <BrandMark className="mx-auto h-10 w-10" />
          <div className="text-sm font-medium text-[#e5e5e5]">
            {tr("Đang tải Writer Studio...", "Loading Writer Studio...")}
          </div>
          <div className="w-40 h-1 bg-[#222] rounded-full overflow-hidden mx-auto">
            <div className="h-full bg-[#9ca3af] rounded-full w-3/5 animate-pulse" />
          </div>
        </div>
      </div>
    )
  }

  if (initialLoadError) {
    return (
      <div className="codex-dark h-dvh flex items-center justify-center bg-[#141414] p-4 sm:p-6">
        <div className="max-w-md w-full bg-[#1c1c1c] border border-[#2d2d2d] rounded-2xl p-6 text-center space-y-4">
          <div className="w-12 h-12 rounded-xl border border-red-900/50 bg-red-950/30 text-red-400 flex items-center justify-center text-xl mx-auto">
            !
          </div>
          <div>
            <h1 className="text-base font-medium text-[#e5e5e5]">
              {tr(
                "Không tải được dữ liệu từ Railway / Supabase",
                "Could not load data from Railway / Supabase",
              )}
            </h1>
            <p className="text-xs text-[#9ca3af] mt-2 leading-relaxed">
              {tr(
                "Ứng dụng đã khóa thao tác lưu để tránh ghi đè database bằng dữ liệu rỗng.",
                "Saving is locked to prevent overwriting the database with empty data.",
              )}
            </p>
          </div>
          <div className="bg-red-950/25 border border-red-900/50 rounded-xl px-3 py-2 text-[11px] text-red-300 font-mono break-words">
            {initialLoadError}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="bg-neutral-200 hover:bg-white text-[#141414] font-medium text-sm py-2.5 px-5 rounded-xl transition-all"
          >
            {tr("Thử tải lại", "Try again")}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="codex-dark h-dvh flex flex-col md:flex-row overflow-hidden bg-[#141414]">
      <Sidebar
        articles={articles}
        activeArticleId={activeId}
        onSelectArticle={(id) => {
          setActiveId(id)
          setShowBatchOverview(true)
        }}
        onNewArticle={() => {
          setActiveId(null)
          setShowBatchOverview(true)
          setLauncherHistoryOpen(false)
        }}
        onOpenContentPlans={() => {
          setActiveId(null)
          setShowBatchOverview(true)
          setLauncherHistoryOpen(true)
          window.setTimeout(
            () => window.dispatchEvent(new Event("writer:open-plan-history")),
            0,
          )
        }}
        onOpenConfig={() => setShowConfig(true)}
        canManageSettings={authSession.user.role === "admin"}
        currentUser={authSession.user}
        onSignOut={() => {
          if (isShellMode) return
          db.clearAuthSession(); setAuthSession(null); setArticles([]); setFiles([]); setActiveId(null)
        }}
        onToggleComplete={handleToggleComplete}
        completionSavingId={completionSavingId}
        onDeleteArticle={handleDeleteArticle}
        deletingArticleId={deletingArticleId}
      />

      <div className="flex-1 min-h-0 flex flex-col h-full overflow-hidden">
        <WorkspaceNotificationHost />
        {isShellMode && <div role="status" className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-100">
          {tr("Shell mode — dữ liệu chỉ mô phỏng trong phiên này; không kết nối Railway hoặc Supabase.", "Shell mode — data is simulated for this session only; Railway and Supabase are disconnected.")}
        </div>}
        {article && isLegacyArticle(article) ? (
          <LegacyArticleView
            article={article}
            migrating={migratingLegacyId === article.id}
            onMigrate={() => void handleMigrateLegacy(article)}
          />
        ) : article?.activityKind === "batch" && showBatchOverview ? (
          <BatchActivity
            articles={articles.filter(
              (item) => item.activityId === article.activityId,
            )}
            onOpen={(id) => {
              setActiveId(id)
              setShowBatchOverview(false)
            }}
            onStart={() =>
              !isShellMode && article.activityId
                ? db.startBatch(article.activityId)
                : Promise.resolve()
            }
            onPause={() =>
              !isShellMode && article.activityId
                ? db.pauseBatch(article.activityId)
                : Promise.resolve()
            }
            onRetry={async (id) => {
              if (isShellMode || !article.activityId) return
              const previous = articlesRef.current.find((item) => item.id === id)
              setArticles((current) =>
                current.map((item) => item.id === id
                  ? {
                      ...item,
                      batchStatus: "queued",
                      batchError: null,
                      updatedAt: new Date().toISOString(),
                    }
                  : item),
              )
              try {
                const queued = await db.retryBatchArticle(article.activityId, id)
                setArticles((current) =>
                  current.map((item) => item.id === queued.id ? queued : item),
                )
              } catch (error) {
                if (previous)
                  setArticles((current) =>
                    current.map((item) => item.id === id ? previous : item),
                  )
                throw error
              }
            }}
          />
        ) : article ? (
          <>
            <StepNav
              currentStep={visibleWorkflowStep}
              onStepChange={handleStepChange}
              articleTitle={article.title || article.topic}
              currentModel={currentModel}
              syncStatus={syncStatus}
              canAccessStep={(step) => {
                const gate = gateArticleStep(article, step)
                return { allowed: gate.allowed, reason: tr(gate.reasonVi, gate.reason) }
              }}
            />
            <main className="continuous-workspace flex-1 min-h-0 overflow-y-auto p-2.5 md:p-5">
              <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)_2.25rem] gap-2 sm:grid-cols-[minmax(0,1fr)_2.5rem] sm:gap-3 lg:grid-cols-[minmax(0,1fr)_6.5rem] lg:gap-4">
                <div className="min-w-0 space-y-6">
                  <section ref={(node) => { if (node) workflowStepRefs.current.set(2, node); else workflowStepRefs.current.delete(2) }} data-workflow-step="2" className="workflow-section scroll-mt-4">
                    <Step2CoreIdea
                      embedded
                      article={article}
                      config={config}
                      files={files}
                      model={currentModel || config.models[0]}
                      railwayUrl={config.railwayUrl}
                      onUpdate={(u) => handleUpdateArticle(article.id, u)}
                      onNext={async () => { await handleStepChange(3); window.setTimeout(() => scrollToWorkflowStep(3), 80) }}
                      onPrev={() => { setActiveId(null); setLauncherHistoryOpen(true) }}
                    />
                  </section>
                  {(article.currentStep ?? 2) >= 3 && gateArticleStep(article, 3).allowed && (
                    <section ref={(node) => { if (node) workflowStepRefs.current.set(3, node); else workflowStepRefs.current.delete(3) }} data-workflow-step="3" className="workflow-section scroll-mt-4">
                      <Step3Outline
                        embedded
                        article={article}
                        config={config}
                        files={files}
                        model={currentModel || config.models[0]}
                        railwayUrl={config.railwayUrl}
                        onUpdate={(u) => handleUpdateArticle(article.id, u)}
                        onNext={async () => { await handleStepChange(4); window.setTimeout(() => scrollToWorkflowStep(4), 80) }}
                        onPrev={() => scrollToWorkflowStep(2)}
                      />
                    </section>
                  )}
                  {(article.currentStep ?? 2) >= 4 && gateArticleStep(article, 4).allowed && (
                    <section ref={(node) => { if (node) workflowStepRefs.current.set(4, node); else workflowStepRefs.current.delete(4) }} data-workflow-step="4" className="workflow-section scroll-mt-4">
                      <Step4Draft
                        embedded
                        article={article}
                        config={config}
                        files={files}
                        model={currentModel || config.models[0]}
                        railwayUrl={config.railwayUrl}
                        onUpdate={(u) => handleUpdateArticle(article.id, u)}
                        onPrev={() => scrollToWorkflowStep(3)}
                        onToggleComplete={() => handleToggleComplete(article)}
                        completionSaving={completionSavingId === article.id}
                      />
                    </section>
                  )}
                </div>
                <VerticalWorkflowRail article={article} activeStep={visibleWorkflowStep} onNavigate={scrollToWorkflowStep} />
              </div>
            </main>
          </>
        ) : isShellMode ? (
          <EbWorkingSpace />
        ) : (
          // Article selected from sidebar but not found (shouldn't happen)
          <ActivityLauncher
            railwayUrl={config.railwayUrl}
            models={config.models}
            modelId={config.stepConfigs[1]?.modelId ?? ""}
            recentArticles={articles}
            initialHistoryOpen={launcherHistoryOpen}
            onOpenArticle={(id) => {
              setActiveId(id)
              setShowBatchOverview(true)
            }}
            onModelChange={handleComposerModelChange}
            onCreate={handleCreateActivity}
          />
        )}
      </div>

      {showConfig && (
        <ConfigModal
          config={config}
          files={files}
          articles={articles}
          onSave={handleSaveConfig}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  )
}
