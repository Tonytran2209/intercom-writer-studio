import {
  ArrowLeft,
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Filter,
  Grid2X2,
  Lightbulb,
  List,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { AppConfig } from "../types"
import * as db from "../lib/db"
import { isShellMode } from "../lib/appMode"

type Gate = "brief" | "article" | "adapt" | "review"
type View = "grid" | "list"
type WorkspacePage = "board" | "discovery" | "library"
type Decision = "done" | "reject" | "recheck" | null
type Task = {
  id: string
  packageId?: string
  gate: Gate
  title: string
  status: "ready" | "checking" | "drafting" | "adapting" | "review"
  pillar?: string
  persona?: string
  type?: string
  channel?: "Threads" | "Facebook" | "LinkedIn"
  decision?: Decision
  source?: "input" | "discovery"
}
type DiscoveryIdea = {
  id: string
  title: string
  source_summary?: string
  pillar_candidate?: string
  persona_candidate?: string
  evidence?: any[]
  status?: string
  created_at?: string
  updated_at?: string
}

const gateConfig: Record<Gate, {
  title: string
  subtitle: string
  tone: "blue" | "amber" | "purple" | "emerald"
}> = {
  brief: {
    title: "Brief · Gate 1",
    subtitle: "Extract, checklist, pillar & persona",
    tone: "blue",
  },
  article: {
    title: "Website article · Gate 2",
    subtitle: "fab.careers draft ready for approval",
    tone: "amber",
  },
  adapt: {
    title: "Adapt channel",
    subtitle: "Threads, Facebook & LinkedIn in progress",
    tone: "purple",
  },
  review: {
    title: "Review · Gate 3",
    subtitle: "Repetition check & final channel action",
    tone: "emerald",
  },
}

function selectedModel(config: AppConfig, step: number, fallbackId?: string) {
  const id = fallbackId || config.stepConfigs[step]?.modelId
  return (
    config.models.find((model) => model.id === id && model.enabled) ??
    config.models.find((model) => model.enabled) ??
    null
  )
}
function workspaceTasks(
  data: Partial<db.EbV2Workspace> | null | undefined,
): Task[] {
  const packageRows = Array.isArray(data?.packages) ? data.packages : []
  const articleRows = (Array.isArray(data?.articles) ? data.articles : []).filter(
    (article: any) => article.status !== "superseded",
  )
  const channelRows = Array.isArray(data?.channels) ? data.channels : []
  const runRows = Array.isArray((data as any)?.runs) ? (data as any).runs : []
  const packages = new Map(packageRows.map((item) => [item.id, item]))
  const articleByPackage = new Map<string, any>()
  for (const article of articleRows)
    if (!articleByPackage.has(article.package_id))
      articleByPackage.set(article.package_id, article)
  const runningBrief = new Set(
    runRows
      .filter((run: any) => run.gate === "brief" && run.status === "running")
      .map((run: any) => run.package_id),
  )
  const runningArticle = new Set(
    runRows
      .filter((run: any) => run.gate === "article" && run.status === "running")
      .map((run: any) => run.package_id),
  )
  const tasks: Task[] = packageRows
    .filter((item) => item.state === "brief")
    .map((item) => ({
      id: item.id,
      packageId: item.id,
      gate: "brief",
      title: item.title,
      status: runningBrief.has(item.id) ? "checking" : "ready",
      source: item.source_type === "discovery" ? "discovery" : "input",
    }))
  for (const item of packageRows.filter(
    (item) => item.state === "article" && !articleByPackage.has(item.id),
  ))
    tasks.push({
      id: item.id,
      packageId: item.id,
      gate: "article",
      title: item.title,
      status: "drafting",
    })
  for (const [packageId, article] of articleByPackage) {
    const item = packages.get(packageId)
    if (!item || item.state !== "article") continue
    tasks.push({
      id: packageId,
      packageId,
      gate: "article",
      title: item.title,
      status: runningArticle.has(packageId) ? "drafting" : "ready",
      type:
        article.status === "approved"
          ? "Approved website article"
          : "Draft ready",
    })
  }
  for (const output of channelRows) {
    const item = packages.get(output.package_id)
    if (!item || !["adapt", "review"].includes(item.state)) continue
    const state =
      output.status === "generating" || output.status === "queued"
        ? "adapting"
        : "review"
    tasks.push({
      id: output.id,
      packageId: output.package_id,
      gate: state === "adapting" ? "adapt" : "review",
      title: item.title,
      status: state,
      channel:
        output.channel === "threads"
          ? "Threads"
          : output.channel === "facebook"
            ? "Facebook"
            : "LinkedIn",
      decision:
        output.status === "done"
          ? "done"
          : output.status === "rejected"
            ? "reject"
            : output.status === "recheck"
              ? "recheck"
              : null,
    })
  }
  return tasks
}

export default function EbWorkingSpace({ config }: { config: AppConfig }) {
  const [view, setView] = useState<View>("list")
  const [page, setPage] = useState<WorkspacePage>("board")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDiscovery, setSelectedDiscovery] =
    useState<DiscoveryIdea | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState("")
  const [fileName, setFileName] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [discoveryIdeas, setDiscoveryIdeas] = useState<DiscoveryIdea[]>([])
  const [discoveryStatus, setDiscoveryStatus] = useState<{
    state: "idle" | "running" | "success" | "empty" | "error"
    message?: string
  }>({ state: "idle" })
  const [syncing, setSyncing] = useState(true)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!filterRef.current?.contains(event.target as Node))
        setFilterOpen(false)
    }
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [])
  useEffect(() => {
    const open = (event: Event) => {
      const action = (event as CustomEvent<"new" | "discovery" | "library">)
        .detail
      if (action === "new") {
        setPage("board")
        setInput("")
        setFileName("")
        setSelectedId(null)
        window.setTimeout(
          () =>
            document.querySelector<HTMLTextAreaElement>("#eb-input")?.focus(),
          0,
        )
      } else setPage(action)
    }
    window.addEventListener("writer:eb-open", open)
    return () => window.removeEventListener("writer:eb-open", open)
  }, [])
  useEffect(() => {
    const openItem = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      setPage("board")
      setSelectedId(id)
    }
    window.addEventListener("writer:eb-open-item", openItem)
    return () => window.removeEventListener("writer:eb-open-item", openItem)
  }, [])
  const refresh = async () => {
    setSyncing(true)
    try {
      const data = await db.fetchEbV2Workspace()
      setTasks(workspaceTasks(data))
      setDiscoveryIdeas(
        (Array.isArray(data.discovery) ? data.discovery : [])
          .filter((item) => item.status === "suggested")
          .map((item) => ({
            ...item,
            id: String(item.id),
            title: String(item.title),
          }))
          .filter((item) => item.title),
      )
      setRuntimeError(null)
    } catch (error) {
      setTasks([])
      setRuntimeError(
        error instanceof Error
          ? error.message
          : "Unable to load EB V2 workspace.",
      )
    } finally {
      setSyncing(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    const colors: Record<Gate, string> = {
      brief: "bg-blue-500",
      article: "bg-amber-500",
      adapt: "bg-purple-500",
      review: "bg-emerald-500",
    }
    window.dispatchEvent(
      new CustomEvent("writer:eb-items", {
        detail: tasks
          .map((task) => ({
            id: task.id,
            packageId: task.packageId ?? task.id,
            gate: task.gate,
            channel: task.channel,
            title: task.title,
            color: colors[task.gate],
          }))
          .slice(0, 20),
      }),
    )
  }, [tasks])
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("writer:eb-counts", {
        detail: {
          discovery: discoveryIdeas.length,
          library: tasks.filter(
            (task) => task.decision === "done" || task.gate === "review",
          ).length,
        },
      }),
    )
  }, [tasks, discoveryIdeas])
  useEffect(() => {
    if (
      !tasks.some((task) =>
        ["checking", "drafting", "adapting"].includes(task.status),
      )
    )
      return
    const timer = window.setInterval(() => {
      void refresh()
    }, 1200)
    return () => window.clearInterval(timer)
  }, [tasks])
  const createBrief = async (
    title: string,
    source: "input" | "discovery",
    discoveryId?: string,
  ) => {
    const model = selectedModel(config, 1)
    if (!model) {
      setRuntimeError("Choose a Brief AI model in Workflow AI first.")
      return
    }
    setSyncing(true)
    try {
      await db.createEbV2Package({
        title,
        inputText: title,
        sourceType: source,
        discoveryId,
        model: { provider: model.provider, id: model.id },
      })
      await refresh()
    } catch (error) {
      setRuntimeError(
        error instanceof Error ? error.message : "Unable to analyse input.",
      )
    } finally {
      setSyncing(false)
    }
  }
  const analyze = () => {
    if (!input.trim() && !file) return
    if (file && !isShellMode) {
      const model = selectedModel(config, 1)
      if (!model) {
        setRuntimeError("Choose a Brief AI model in Workflow AI first.")
        return
      }
      setSyncing(true)
      void db
        .uploadEbV2Package(file, { provider: model.provider, id: model.id })
        .then(() => refresh())
        .catch((error) =>
          setRuntimeError(
            error instanceof Error
              ? error.message
              : "Unable to analyse uploaded file.",
          ),
        )
        .finally(() => setSyncing(false))
    } else
      void createBrief(input.trim() || `Material from ${fileName}`, "input")
    setInput("")
    setFileName("")
    setFile(null)
  }
  const runDiscovery = (sourceUrls: string[] = []) => {
    if (discoveryStatus.state === "running") return
    setDiscoveryStatus({
      state: "running",
      message:
        "Scanning configured sources and preparing evidence-backed topics…",
    })
    if (isShellMode) {
      const ideas = [
        {
          id: "shell-discovery-1",
          title: "Why young creatives value a team that explains the why",
        },
        {
          id: "shell-discovery-2",
          title: "A small habit that makes feedback easier to use",
        },
        {
          id: "shell-discovery-3",
          title: "When an informal sharing session becomes a learning system",
        },
      ]
      setDiscoveryIdeas((current) => [
        ...current,
        ...ideas.filter(
          (idea) => !current.some((saved) => saved.id === idea.id),
        ),
      ])
      setDiscoveryStatus({
        state: "success",
        message: `${ideas.length} suggestions are ready to review.`,
      })
      return
    }
    const model = selectedModel(
      config,
      1,
      config.ebRuntimeSettings?.discoveryModelId,
    )
    if (!model) {
      const message =
        "Choose a Discovery or Brief AI model in Workflow AI first."
      setRuntimeError(message)
      setDiscoveryStatus({ state: "error", message })
      return
    }
    setSyncing(true)
    void db
      .runEbV2Discovery({ provider: model.provider, id: model.id }, sourceUrls)
      .then((data) => {
        const ideas = (Array.isArray(data.items) ? data.items : [])
          .map((item) => ({
            ...item,
            id: String(item.id),
            title: String(item.title),
          }))
          .filter((item) => item.title)
        setDiscoveryIdeas((current) => [
          ...ideas,
          ...current.filter(
            (saved) => !ideas.some((idea) => idea.id === saved.id),
          ),
        ])
        setRuntimeError(null)
        setDiscoveryStatus(
          ideas.length
            ? {
                state: "success",
                message: `${ideas.length} evidence-backed suggestion${
                  ideas.length === 1 ? "" : "s"
                } saved. Your earlier suggestions remain in Discovery archive.`,
              }
            : {
                state: "empty",
                message:
                  "Scan finished, but no topics met the evidence requirements. Earlier suggestions remain saved. Try adding source links or broadening Discovery Research settings.",
              },
        )
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unable to run Discovery."
        setRuntimeError(message)
        setDiscoveryStatus({
          state: "error",
          message: `Scan could not finish: ${message}`,
        })
      })
      .finally(() => setSyncing(false))
  }
  const approveBrief = (task: Task) => {
    if (isShellMode) {
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id
            ? { ...item, gate: "article", status: "drafting" }
            : item,
        ),
      )
      return
    }
    const model = selectedModel(config, 2)
    if (!model) {
      setRuntimeError("Choose a Gate 2 AI model in Workflow AI first.")
      return
    }
    setSyncing(true)
    void db
      .approveEbV2Brief(task.id, { provider: model.provider, id: model.id })
      .then(() => refresh())
      .catch((error) =>
        setRuntimeError(
          error instanceof Error
            ? error.message
            : "Unable to generate article.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  const approveArticle = (task: Task) => {
    if (isShellMode) {
      setTasks((current) => {
        const next = current.filter((item) => item.id !== task.id)
        const channels: Task["channel"][] = ["Threads", "Facebook", "LinkedIn"]
        return [
          ...next,
          ...channels.map((channel) => ({
            id: `adapt-${task.id}-${channel}`,
            gate: "adapt" as Gate,
            status: "adapting" as const,
            title: task.title,
            channel,
          })),
        ]
      })
      return
    }
    const model = selectedModel(
      config,
      4,
      config.ebRuntimeSettings?.adaptModelId,
    )
    if (!model) {
      setRuntimeError("Choose an Adapt channel model in Workflow AI first.")
      return
    }
    setSyncing(true)
    void db
      .approveEbV2Article(task.id, { provider: model.provider, id: model.id })
      .then((data) => {
        setTasks(workspaceTasks(data))
        setRuntimeError(null)
      })
      .catch((error) =>
        setRuntimeError(
          error instanceof Error ? error.message : "Unable to adapt channels.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  const decide = (id: string, decision: Exclude<Decision, null>) => {
    if (isShellMode) {
      setTasks((current) =>
        current.map((task) => (task.id === id ? { ...task, decision } : task)),
      )
      return
    }
    setSyncing(true)
    void db
      .reviewEbV2Channel(id, decision)
      .then((data) => {
        setTasks(workspaceTasks(data))
        setRuntimeError(null)
      })
      .catch((error) =>
        setRuntimeError(
          error instanceof Error
            ? error.message
            : "Unable to save review action.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  const regenerate = (task: Task) => {
    if (isShellMode) {
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id
            ? {
                ...item,
                status:
                  task.gate === "brief"
                    ? "checking"
                    : task.gate === "article"
                      ? "drafting"
                      : "adapting",
                decision: null,
              }
            : item,
        ),
      )
      return
    }
    const step = task.gate === "brief" ? 1 : task.gate === "article" ? 2 : 4
    const model = selectedModel(
      config,
      step,
      task.gate === "adapt" || task.gate === "review"
        ? config.ebRuntimeSettings?.adaptModelId
        : undefined,
    )
    if (!model) {
      setRuntimeError(
        `Choose an AI model for ${
          task.gate === "brief"
            ? "Brief"
            : task.gate === "article"
              ? "Website article"
              : "Adapt channel"
        } first.`,
      )
      return
    }
    const pendingStatus: Task["status"] =
      task.gate === "brief"
        ? "checking"
        : task.gate === "article"
          ? "drafting"
          : "adapting"
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id
          ? { ...item, status: pendingStatus, decision: null }
          : item,
      ),
    )
    setSyncing(true)
    const request =
      task.gate === "brief" || task.gate === "article"
        ? db.regenerateEbV2Package(task.packageId ?? task.id, task.gate, {
            provider: model.provider,
            id: model.id,
          })
        : db.regenerateEbV2Channel(task.id, {
            provider: model.provider,
            id: model.id,
          })
    void request
      .then((data) => {
        setTasks(
          workspaceTasks(data).map((item) =>
            item.id === task.id
              ? { ...item, status: pendingStatus, decision: null }
              : item,
          ),
        )
        setRuntimeError(null)
      })
      .catch((error) => {
        setTasks((current) =>
          current.map((item) =>
            item.id === task.id ? { ...item, status: "ready" } : item,
          ),
        )
        setRuntimeError(
          error instanceof Error ? error.message : "Unable to regenerate item.",
        )
      })
      .finally(() => setSyncing(false))
  }
  const moveTo = (task: Task, target: "brief" | "article") => {
    const targetLabel =
      target === "brief" ? "Brief · Gate 1" : "Website article · Gate 2"
    if (
      !window.confirm(
        `Move “${task.title}” back to ${targetLabel}? Later channel outputs will be removed.`,
      )
    )
      return
    if (isShellMode) {
      setTasks((current) =>
        current
          .filter(
            (item) =>
              (item.packageId ?? item.id) !== (task.packageId ?? task.id) ||
              item.id === (task.packageId ?? task.id),
          )
          .map((item) =>
            item.id === (task.packageId ?? task.id)
              ? { ...item, gate: target, status: "ready", decision: null }
              : item,
          ),
      )
      return
    }
    setSyncing(true)
    void db
      .moveEbV2Package(task.packageId ?? task.id, target)
      .then((data) => {
        setTasks(workspaceTasks(data))
        setSelectedId(null)
        setRuntimeError(null)
      })
      .catch((error) =>
        setRuntimeError(
          error instanceof Error ? error.message : "Unable to move item.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  const remove = (task: Task) => {
    if (
      !window.confirm(
        `Delete “${
          task.channel ? `${task.title} · ${task.channel}` : task.title
        }”?`,
      )
    )
      return
    if (isShellMode) {
      setTasks((current) => current.filter((item) => item.id !== task.id))
      return
    }
    setSyncing(true)
    const request =
      task.gate === "review"
        ? db.deleteEbV2ChannelOutput(task.id)
        : db.deleteEbV2Package(task.id)
    void request
      .then((data) => {
        setTasks(workspaceTasks(data))
        setSelectedId(null)
        setRuntimeError(null)
      })
      .catch((error) =>
        setRuntimeError(
          error instanceof Error ? error.message : "Unable to delete item.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  const removeDiscovery = (item: DiscoveryIdea) => {
    if (!window.confirm(`Delete Discovery suggestion “${item.title}”?`)) return
    setSyncing(true)
    void db
      .deleteEbV2Discovery(item.id)
      .then(() => {
        setSelectedDiscovery(null)
        void refresh()
      })
      .catch((error) =>
        setRuntimeError(
          error instanceof Error
            ? error.message
            : "Unable to delete Discovery suggestion.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  const clearDiscovery = () => {
    if (
      !window.confirm(
        "Clear all pending Discovery suggestions? Used suggestions and packages will be kept.",
      )
    )
      return
    setSyncing(true)
    void db
      .clearEbV2Discovery()
      .then(() => {
        setSelectedDiscovery(null)
        void refresh()
      })
      .catch((error) =>
        setRuntimeError(
          error instanceof Error
            ? error.message
            : "Unable to clear Discovery suggestions.",
        ),
      )
      .finally(() => setSyncing(false))
  }
  useEffect(() => {
    const removeFromSidebar = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      const task = tasks.find((item) => item.id === id)
      if (task) remove(task)
    }
    window.addEventListener("writer:eb-delete", removeFromSidebar)
    return () =>
      window.removeEventListener("writer:eb-delete", removeFromSidebar)
  }, [tasks])
  const gates: Gate[] = ["brief", "article", "adapt", "review"]
  const filterGroups = [
    { label: "Workflow state", options: ["Brief · Gate 1", "Website article · Gate 2", "Adapt channel", "Review · Gate 3"] },
    { label: "Channel", options: ["Threads", "Facebook", "LinkedIn"] },
    { label: "Decision", options: ["Needs review", "Done", "Re-check", "Rejected"] },
  ]
  const toggleFilter = (filter: string) =>
    setActiveFilters((current) =>
      current.includes(filter)
        ? current.filter((item) => item !== filter)
        : [...current, filter],
    )
  const filteredTasks = tasks.filter(
    (task) =>
      !activeFilters.length ||
      activeFilters.some(
        (filter) =>
          filter === gateConfig[task.gate].title ||
          filter === task.pillar ||
          filter === task.persona ||
          filter === task.channel ||
          (filter === "Needs review" && task.gate === "review" && !task.decision) ||
          (filter === "Done" && task.decision === "done") ||
          (filter === "Re-check" && task.decision === "recheck") ||
          (filter === "Rejected" && task.decision === "reject"),
      ),
  )
  const notices = [
    { id: "connection", text: syncing ? "Synchronising V2 workspace…" : runtimeError ? "V2 workspace connection needs attention." : "V2 workspace is live.", active: true, error: Boolean(runtimeError) },
    { id: "article", text: `${tasks.filter((task) => task.gate === "article" && task.status === "drafting").length} website article(s) are being generated`, active: tasks.some((task) => task.gate === "article" && task.status === "drafting") },
    {
      id: "adapt",
      text: `${tasks.filter((task) => task.gate === "adapt").length} channel output(s) are running`,
      active: tasks.some((task) => task.gate === "adapt"),
    },
    {
      id: "review",
      text: `${tasks.filter((task) => task.gate === "review" && !task.decision).length} channel output(s) await review`,
      active: tasks.some((task) => task.gate === "review" && !task.decision),
    },
    {
      id: "discovery",
      text: `${discoveryIdeas.length} Discovery suggestion(s) saved`,
      active: discoveryIdeas.length > 0,
    },
    {
      id: "error",
      text: runtimeError ?? "",
      active: Boolean(runtimeError),
      error: true,
    },
  ].filter((item) => item.active)
  return (
    <main className="eb-workspace continuous-workspace relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 px-4">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="font-semibold text-slate-800">Content Engine</span>
          <span>/</span>
          <span>
            {page === "board"
              ? "EB Content Packages"
              : page === "discovery"
                ? "Discovery archive"
                : "Library Article"}
          </span>
          <button
            onClick={() => void refresh()}
            disabled={syncing}
            title={runtimeError || "Refresh V2 workspace"}
            aria-label={runtimeError ? "Retry V2 connection" : "Refresh V2 workspace"}
            className={`inline-flex h-6 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-medium disabled:cursor-not-allowed ${
              runtimeError
                ? "bg-red-50 text-red-600 hover:bg-red-100"
                : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
            }`}
          >
            <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
            {!syncing && (runtimeError ? "V2 error" : "V2 live")}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setNotificationOpen(true)}
            title="Notifications"
            aria-label="Notifications"
            className="relative grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200"
          >
            <Bell className="h-3.5 w-3.5" />
            {notices.length > 0 && (
              <span className="absolute -right-1 -top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-red-500 px-0.5 text-[8px] font-bold text-white">
                {notices.length}
              </span>
            )}
          </button>
        </div>
      </header>
      {runtimeError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-4 py-2">
          <p className="min-w-0 truncate text-[10px] text-red-700">
            V2 cannot load: {runtimeError}
          </p>
          <button
            onClick={() => void refresh()}
            disabled={syncing}
            className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}
      {page === "board" && <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div ref={filterRef} className="relative">
            <button
              onClick={(event) => {
                event.stopPropagation()
                setFilterOpen((value) => !value)
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700"
            >
              <Filter className="h-3.5 w-3.5" />
              Filter
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {filterOpen && (
              <div className="absolute left-0 top-[calc(100%+8px)] z-50 w-64 rounded-xl border border-slate-200 bg-white p-1.5 text-xs shadow-xl">
                <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Filter packages
                </p>
                {filterGroups.map((group) => <div key={group.label} className="mb-1 last:mb-0"><p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</p>{group.options.map((label) => <button key={label} onClick={() => toggleFilter(label)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-slate-600 hover:bg-slate-50"><span className={`filter-checkbox ${activeFilters.includes(label) ? "is-selected" : ""}`}>{activeFilters.includes(label) && <Check className="h-2.5 w-2.5" />}</span>{label}</button>)}</div>)}
                {activeFilters.length > 0 && (
                  <button
                    onClick={() => setActiveFilters([])}
                    className="mt-1 w-full rounded-lg border-t border-slate-100 px-2.5 py-2 text-left text-[10px] font-semibold text-slate-500 hover:bg-slate-50"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </div>
          {activeFilters.map((filter) => (
            <button
              key={filter}
              onClick={() => toggleFilter(filter)}
              className="hidden items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-600 sm:inline-flex"
            >
              {filter}
              <X className="h-3 w-3 text-slate-400" />
            </button>
          ))}
        </div>
        <div className="flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
          <button
            onClick={() => setView("list")}
            className={`rounded-md px-2 py-1 ${
              view === "list" ? "bg-white shadow-2xs" : ""
            }`}
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setView("grid")}
            className={`rounded-md px-2 py-1 ${
              view === "grid" ? "bg-white shadow-2xs" : ""
            }`}
          >
            <Grid2X2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>}
      <>
        {page === "board" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="bg-slate-50/30 p-3 pb-36">
              <div
                className={
                  view === "grid"
                    ? "grid items-start gap-3 xl:grid-cols-4"
                    : "space-y-4"
                }
              >
                {gates.map((gate) => (
                  <GateGroup
                    key={gate}
                    gate={gate}
                    tasks={filteredTasks.filter((task) => task.gate === gate)}
                    view={view}
                    onBrief={approveBrief}
                    onArticle={approveArticle}
                    onDecision={decide}
                    onRegenerate={regenerate}
                    onMove={moveTo}
                    onDelete={remove}
                    onOpen={setSelectedId}
                  />
                ))}
              </div>
            </section>
            <InputEngine
              input={input}
              setInput={setInput}
              fileName={fileName}
              setFileName={setFileName}
              setFile={setFile}
              analyze={analyze}
            />
          </div>
        ) : page === "discovery" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DiscoveryArchive
              ideas={discoveryIdeas}
              onBack={() => setPage("board")}
              onOpen={setSelectedDiscovery}
              onDelete={removeDiscovery}
              onClear={clearDiscovery}
              onPick={(item) => {
                void createBrief(item.title, "discovery", item.id)
                setPage("board")
              }}
            />
            <DiscoveryResearch
              status={discoveryStatus}
              onDiscover={runDiscovery}
            />
          </div>
        ) : (
          <ArticleLibrary tasks={tasks} onBack={() => setPage("board")} />
        )}
        {selectedId && (
          <TaskDetail
            task={tasks.find((task) => task.id === selectedId) ?? null}
            onClose={() => setSelectedId(null)}
          />
        )}
        {selectedDiscovery && (
          <DiscoveryDetail
            item={selectedDiscovery}
            onClose={() => setSelectedDiscovery(null)}
          />
        )}
        {notificationOpen && (
          <NotificationPanel
            notices={notices}
            onClose={() => setNotificationOpen(false)}
          />
        )}
      </>
    </main>
  )
}

function NotificationPanel({
  notices,
  onClose,
}: {
  notices: Array<{ id: string; text: string; active: boolean; error?: boolean }>
  onClose: () => void
}) {
  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="eb-overlay absolute inset-0 z-50 flex justify-end p-3"
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-sm flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-200 p-4">
          <div>
            <p className="text-sm font-bold text-slate-900">
              Notification center
            </p>
            <p className="mt-1 text-[10px] text-slate-500">
              Connection, workflow, AI runs and saved-data status
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-3">
          {notices.length ? (
            notices.map((notice) => (
              <article
                key={notice.id}
                className={`mb-2 rounded-xl border p-3 text-xs ${
                  notice.error
                    ? "border-red-100 bg-red-50 text-red-700"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                {notice.text}
              </article>
            ))
          ) : (
            <p className="p-4 text-center text-xs text-slate-400">
              No new notifications.
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}
function GateGroup({
  gate,
  tasks,
  view,
  onBrief,
  onArticle,
  onDecision,
  onRegenerate,
  onMove,
  onDelete,
  onOpen,
}: {
  gate: Gate
  tasks: Task[]
  view: View
  onBrief: (task: Task) => void
  onArticle: (task: Task) => void
  onDecision: (id: string, decision: Exclude<Decision, null>) => void
  onRegenerate: (task: Task) => void
  onMove: (task: Task, target: "brief" | "article") => void
  onDelete: (task: Task) => void
  onOpen: (id: string) => void
}) {
  const config = gateConfig[gate]
  const isList = view === "list"

  return (
    <section
      className={
        isList
          ? "relative scroll-mt-2"
          : `gate-column gate-${config.tone} rounded-2xl border p-3`
      }
    >
      <div
        className={`mb-3 flex items-center justify-between ${
          isList ? "sticky top-0 z-20 -mx-1 bg-white px-1 py-2" : ""
        }`}
      >
        <div>
          <div className="flex items-center gap-1.5">
            <span className={`gate-dot gate-dot-${config.tone}`}>
              <Check className="h-2.5 w-2.5" />
            </span>
            <h2 className="text-xs font-bold text-slate-800">{config.title}</h2>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">{config.subtitle}</p>
        </div>
        <span className="text-xs text-slate-400">{tasks.length}</span>
      </div>
      <div className="space-y-2">
        {tasks.length ? (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              view={view}
              onBrief={onBrief}
              onArticle={onArticle}
              onDecision={onDecision}
              onRegenerate={onRegenerate}
              onMove={onMove}
              onDelete={onDelete}
              onOpen={onOpen}
            />
          ))
        ) : (
          <p className="py-5 text-center text-[10px] text-slate-400">
            No tasks
          </p>
        )}
      </div>
    </section>
  )
}
function TaskCard({
  task,
  view,
  onBrief,
  onArticle,
  onDecision,
  onRegenerate,
  onMove,
  onDelete,
  onOpen,
}: {
  task: Task
  view: View
  onBrief: (task: Task) => void
  onArticle: (task: Task) => void
  onDecision: (id: string, decision: Exclude<Decision, null>) => void
  onRegenerate: (task: Task) => void
  onMove: (task: Task, target: "brief" | "article") => void
  onDelete: (task: Task) => void
  onOpen: (id: string) => void
}) {
  const isWorking = ["checking", "drafting", "adapting"].includes(task.status)
  const canRegenerate = !isWorking
  return (
    <article
      className={`rounded-xl border border-slate-200/80 bg-white p-3 shadow-2xs ${
        view === "list" ? "flex items-center justify-between gap-4" : ""
      }`}
    >
      <button onClick={() => onOpen(task.id)} className="min-w-0 text-left">
        <div className="flex flex-wrap gap-1">
          {task.channel && <Tag>{task.channel}</Tag>}
          {task.type && <Tag>{task.type}</Tag>}
          {task.source === "discovery" && <Tag>Discovery suggestion</Tag>}
          {isWorking && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
              <LoaderCircle className="h-3 w-3 animate-spin" />
              {task.status === "adapting"
                ? "Adapting"
                : task.status === "drafting"
                  ? "Drafting"
                  : "Extract & check"}
            </span>
          )}
        </div>
        <h3 className="mt-2 text-xs font-bold leading-snug text-slate-900">
          {task.title}
        </h3>
        {task.gate === "brief" && (
          <p className="mt-1 text-[10px] text-slate-500">
            Pillar: {task.pillar ?? "awaiting input"} · Persona:{" "}
            {task.persona ?? "awaiting mapping"}
          </p>
        )}
        {task.gate === "review" && (
          <p className="mt-1 text-[10px] text-slate-500">
            Ready for repetition check and reviewer action.
          </p>
        )}
      </button>
      <div
        className={`mt-3 flex flex-wrap items-center gap-1.5 ${
          view === "list" ? "mt-0 shrink-0" : ""
        }`}
      >
        {task.gate === "brief" && task.status !== "checking" && (
          <button
            onClick={() => onBrief(task)}
            className="rounded-lg bg-indigo-600 px-2 py-1 text-[10px] font-semibold text-white"
          >
            Approve brief
          </button>
        )}
        {task.gate === "article" &&
          task.status !== "drafting" &&
          task.type !== "Approved website article" && (
            <button
              onClick={() => onArticle(task)}
              className="rounded-lg bg-indigo-600 px-2 py-1 text-[10px] font-semibold text-white"
            >
              Approve article
            </button>
          )}
        {task.gate === "article" &&
          task.type === "Approved website article" && (
            <button
              onClick={() => onOpen(task.id)}
              className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700"
            >
              Open article
            </button>
          )}
        {task.gate === "review" && !task.decision && (
          <>
            <button
              onClick={() => onDecision(task.id, "done")}
              className="rounded-lg bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white"
            >
              Done
            </button>
            <button
              onClick={() => onDecision(task.id, "recheck")}
              className="rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-600"
            >
              Re-check
            </button>
            <button
              onClick={() => onDecision(task.id, "reject")}
              className="rounded-lg bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-600"
            >
              Reject
            </button>
          </>
        )}
        {canRegenerate && (
          <button
            onClick={() => onRegenerate(task)}
            title="Run this step again"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            <RotateCcw className="h-3 w-3" />
            Regenerate
          </button>
        )}
        {task.gate !== "brief" && (
          <button
            onClick={() =>
              onMove(task, task.gate === "article" ? "brief" : "article")
            }
            title="Move back to an earlier step"
            className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            {task.gate === "article" ? "Back to Brief" : "Back to Article"}
          </button>
        )}
        {task.gate === "review" && (
          <button
            onClick={() => onMove(task, "brief")}
            className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            Back to Brief
          </button>
        )}
        {task.decision && <Tag>{task.decision}</Tag>}
        <button
          onClick={() => onDelete(task)}
          title="Delete item"
          aria-label="Delete item"
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </article>
  )
}
function Discovery({
  ideas,
  status,
  onPick,
}: {
  ideas: Array<{ id: string; title: string }>
  status: {
    state: "idle" | "running" | "success" | "empty" | "error"
    message?: string
  }
  onPick: (item: { id: string; title: string }) => void
}) {
  const running = status.state === "running"
  const statusClass =
    status.state === "error"
      ? "border-red-100 bg-red-50 text-red-700"
      : status.state === "success"
        ? "border-emerald-100 bg-emerald-50 text-emerald-700"
        : status.state === "empty"
          ? "border-amber-100 bg-amber-50 text-amber-700"
          : "border-purple-100 bg-purple-50 text-purple-700"
  return (
    <div className="mt-2 w-full border-t border-purple-100 pt-2">
      <p className="text-[10px] text-slate-500">
        Scans configured public sources and the links in the input above.
        Suggestions are never auto-approved.
      </p>
      {status.state !== "idle" && (
        <div
          role="status"
          className={`mt-2 flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed ${statusClass}`}
        >
          {running && (
            <LoaderCircle className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
          )}
          <span>{status.message}</span>
        </div>
      )}
      {ideas.length ? (
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {ideas.slice(0, 5).map((idea, index) => (
            <button
              disabled={running}
              key={idea.id}
              onClick={() => onPick(idea)}
              className="rounded-lg bg-purple-50 px-2 py-1.5 text-left text-[10px] text-slate-700 hover:bg-purple-100 disabled:opacity-50"
            >
              <span className="mr-1 text-purple-500">{index + 1}.</span>
              {idea.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
function InputEngine({
  input,
  setInput,
  fileName,
  setFileName,
  setFile,
  analyze,
}: {
  input: string
  setInput: (value: string) => void
  fileName: string
  setFileName: (value: string) => void
  setFile: (file: File | null) => void
  analyze: () => void
}) {
  return (
    <div className="eb-input-engine sticky bottom-0 z-10 shrink-0 px-3 pb-3 pt-3">
      <div className="glow-input-container mx-auto max-w-4xl rounded-xl p-px">
        <div className="rounded-[11px] bg-white p-2 shadow-sm">
          <div className="flex h-10 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-indigo-600" />
            <input
              id="eb-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Nhập một khoảnh khắc, ý tưởng hoặc câu chuyện thật từ F.Learning…"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
            />
            <label
              title={fileName || "Upload material"}
              className={`grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg border hover:bg-slate-50 ${
                fileName
                  ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                  : "border-slate-200 text-slate-500"
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              <input
                type="file"
                className="hidden"
                accept=".pdf,.docx,.xlsx,.csv,.tsv,.json,.txt,.md"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null
                  setFile(next)
                  setFileName(next?.name ?? "")
                }}
              />
            </label>
            <button
              disabled={!input.trim() && !fileName}
              onClick={analyze}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              Analyze
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
function DiscoveryResearch({
  status,
  onDiscover,
}: {
  status: {
    state: "idle" | "running" | "success" | "empty" | "error"
    message?: string
  }
  onDiscover: (urls: string[]) => void
}) {
  const [sourceInput, setSourceInput] = useState("")
  const running = status.state === "running"
  const statusClass =
    status.state === "error"
      ? "border-red-100 bg-red-50 text-red-700"
      : status.state === "success"
        ? "border-emerald-100 bg-emerald-50 text-emerald-700"
        : status.state === "empty"
          ? "border-amber-100 bg-amber-50 text-amber-700"
          : "border-purple-100 bg-purple-50 text-purple-700"

  return (
    <section className="sticky bottom-0 z-10 shrink-0 px-4 py-3">
      <div className="mx-auto max-w-4xl rounded-xl border border-purple-100 bg-white p-3 shadow-2xs">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-purple-600" />
              <h2 className="text-xs font-bold text-slate-800">
                Discovery research
              </h2>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">
              Scan configured daily sources, or add social links as extra
              research evidence.
            </p>
          </div>
          <button
            disabled={running}
            onClick={() =>
              onDiscover(
                sourceInput
                  .split(/\n|,/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-purple-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {running ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {running ? "Scanning…" : "Scan sources"}
          </button>
        </div>
        <textarea
          value={sourceInput}
          onChange={(event) => setSourceInput(event.target.value)}
          rows={2}
          placeholder="Optional: paste Facebook, Instagram or Threads links…"
          className="mt-3 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 outline-none placeholder:text-slate-400 focus:border-purple-300"
        />
        {status.state !== "idle" && (
          <div
            role="status"
            className={`mt-2 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10px] leading-relaxed ${statusClass}`}
          >
            {running && (
              <LoaderCircle className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
            )}
            <span>{status.message}</span>
          </div>
        )}
      </div>
    </section>
  )
}
function DiscoveryArchive({
  ideas,
  onBack,
  onOpen,
  onDelete,
  onClear,
  onPick,
}: {
  ideas: DiscoveryIdea[]
  onBack: () => void
  onOpen: (item: DiscoveryIdea) => void
  onDelete: (item: DiscoveryIdea) => void
  onClear: () => void
  onPick: (item: DiscoveryIdea) => void
}) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-slate-50/30 p-4">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-sm font-bold text-slate-900">
              Discovery archive
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Saved, source-backed topic suggestions awaiting selection.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onBack}
              title="Back to workspace"
              aria-label="Back to workspace"
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            {ideas.length > 0 && (
              <button
                onClick={onClear}
                className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {ideas.length ? (
            ideas.map((item) => (
              <article
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-2xs"
              >
                <button
                  onClick={() => onOpen(item)}
                  className="min-w-0 flex-1 text-left"
                >
                  <Tag>Discovery suggestion</Tag>
                  <h2 className="mt-2 text-xs font-bold text-slate-800">
                    {item.title}
                  </h2>
                  <p className="mt-1 text-[10px] text-slate-500">
                    {item.source_summary ??
                      "Source trace available in Details."}
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => onOpen(item)}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600"
                  >
                    Details
                  </button>
                  <button
                    onClick={() => onPick(item)}
                    className="rounded-lg bg-indigo-600 px-2 py-1 text-[10px] font-semibold text-white"
                  >
                    Run Gate 1
                  </button>
                  <button
                    onClick={() => onDelete(item)}
                    title="Delete suggestion"
                    aria-label="Delete suggestion"
                    className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
              No pending Discovery suggestions.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
function ArticleLibrary({
  tasks,
  onBack,
}: {
  tasks: Task[]
  onBack: () => void
}) {
  const items = tasks.filter(
    (task) => task.decision === "done" || task.gate === "review",
  )
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-slate-50/30 p-4">
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Library Article"
          description="Approved fab.careers drafts and channel outputs available for search and export."
          onBack={onBack}
        />
        <div className="mt-4 space-y-2">
          {items.length ? (
            items.map((task) => (
              <article
                key={task.id}
                className="flex items-center justify-between rounded-xl border border-slate-200/80 bg-white p-3 shadow-2xs"
              >
                <div>
                  <div className="flex gap-1">
                    <Tag>{task.channel ?? "fab.careers"}</Tag>
                    <Tag>{task.decision ?? "Awaiting final action"}</Tag>
                  </div>
                  <h2 className="mt-2 text-xs font-bold text-slate-800">
                    {task.title}
                  </h2>
                </div>
                <button className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">
                  <Download className="h-3 w-3" />
                  Export
                </button>
              </article>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
              No approved packages in this shell session yet.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
function PageHeader({
  title,
  description,
  onBack,
}: {
  title: string
  description: string
  onBack: () => void
}) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-sm font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-xs text-slate-500">{description}</p>
      </div>
      <button
        onClick={onBack}
        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600"
      >
        Back to workspace
      </button>
    </div>
  )
}
function InlineMarkdown({ value }: { value: string }) {
  return (
    <>
      {value
        .split(/(\*\*[^*]+\*\*)/g)
        .map((part, index) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={index}>{part.slice(2, -2)}</strong>
          ) : (
            part
          ),
        )}
    </>
  )
}
function MarkdownContent({ value }: { value: string }) {
  return (
    <div className="mt-2 space-y-2 text-xs leading-6 text-slate-700">
      {String(value)
        .split("\n")
        .map((line, index) => {
          const heading = line.match(/^(#{1,4})\s+(.+)$/)
          const numbered = line.match(/^(\d+)\.\s+(.+)$/)
          const bullet = line.match(/^[-*]\s+(.+)$/)
          if (heading)
            return (
              <p
                key={index}
                className={
                  heading[1].length <= 2
                    ? "pt-2 text-sm font-bold text-slate-800"
                    : "pt-1 font-semibold text-slate-800"
                }
              >
                <InlineMarkdown value={heading[2]} />
              </p>
            )
          if (numbered)
            return (
              <p key={index} className="pl-1">
                <span className="mr-1 font-medium text-slate-500">
                  {numbered[1]}.
                </span>
                <InlineMarkdown value={numbered[2]} />
              </p>
            )
          if (bullet)
            return (
              <p key={index} className="pl-3 before:mr-2 before:content-['•']">
                <InlineMarkdown value={bullet[1]} />
              </p>
            )
          return line ? (
            <p key={index}>
              <InlineMarkdown value={line} />
            </p>
          ) : (
            <div key={index} className="h-1" />
          )
        })}
    </div>
  )
}
function TaskDetail({
  task,
  onClose,
}: {
  task: Task | null
  onClose: () => void
}) {
  const [activity, setActivity] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!task || isShellMode) {
      setActivity(null)
      return
    }
    setLoading(true)
    setError(null)
    void db
      .fetchEbV2Activity(
        task.id,
        task.gate === "adapt" || task.gate === "review" ? "channel" : "package",
      )
      .then(setActivity)
      .catch((reason) =>
        setError(
          reason instanceof Error ? reason.message : "Unable to load activity.",
        ),
      )
      .finally(() => setLoading(false))
  }, [task?.id, task?.gate])
  if (!task) return null
  const selectedOutput =
    activity?.selectedChannel ??
    activity?.channels?.find((item: any) => item.id === task.id)
  const latestRun = activity?.runs?.[0]
  const output =
    selectedOutput?.content?.text ??
    (task.gate === "article" ? activity?.articles?.[0]?.body_markdown : null) ??
    latestRun?.output_snapshot?.content ??
    (isShellMode
      ? "Shell-mode simulation: no persistent source or AI activity exists for this item."
      : "This item has not produced output yet.")
  const sources = activity?.inputs ?? []
  const runs = activity?.runs ?? []
  const actions = activity?.actions ?? []
  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="eb-overlay absolute inset-0 z-40 flex justify-end p-3"
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col rounded-2xl border border-slate-200/80 bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-200/80 p-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {gateConfig[task.gate].title}
            </p>
            <h2 className="mt-1 text-sm font-bold text-slate-900">
              {task.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="text-xs text-slate-500">
              Loading source and AI activity…
            </p>
          ) : error ? (
            <p className="text-xs text-red-600">{error}</p>
          ) : (
            <>
              <section className="rounded-xl border border-slate-200/80 bg-slate-50 p-3">
                <h3 className="text-xs font-bold text-slate-800">Result</h3>
                <MarkdownContent value={output} />
              </section>
              <section className="mt-3 rounded-xl border border-slate-200/80 bg-white p-3">
                <h3 className="text-xs font-bold text-slate-800">
                  Source & evidence
                </h3>
                {sources.length ? (
                  sources.map((source: any) => (
                    <div
                      key={source.id}
                      className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] text-slate-600"
                    >
                      <b className="text-slate-700">
                        {source.upload_name ?? "Text input"}
                      </b>
                      <p className="mt-1 whitespace-pre-wrap">
                        {String(source.input_text ?? "").slice(0, 1600)}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="mt-2 text-[10px] text-slate-400">
                    No source snapshot has been saved yet.
                  </p>
                )}
              </section>
              <section className="mt-3 rounded-xl border border-slate-200/80 bg-white p-3">
                <h3 className="text-xs font-bold text-slate-800">
                  AI activity log
                </h3>
                {runs.length ? (
                  <ol className="mt-3 space-y-3 border-l border-slate-200 pl-3">
                    {runs.map((run: any) => (
                      <li key={run.id} className="text-[10px] text-slate-500">
                        <b className="text-slate-700">
                          {run.gate} · {run.stage}
                        </b>
                        <br />
                        {run.status} · {run.model_provider}/{run.model_id} ·{" "}
                        {run.total_tokens ?? 0} tokens
                        <br />
                        <span>
                          {run.started_at
                            ? new Date(run.started_at).toLocaleString()
                            : "Queued"}
                        </span>
                        {run.error_message && (
                          <p className="mt-1 text-red-600">
                            {run.error_message}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-[10px] text-slate-400">
                    No AI run has been recorded yet.
                  </p>
                )}
              </section>
              <section className="mt-3 rounded-xl border border-slate-200/80 bg-white p-3">
                <h3 className="text-xs font-bold text-slate-800">
                  Review activity
                </h3>
                {actions.length ? (
                  actions.map((action: any) => (
                    <p
                      key={action.id}
                      className="mt-2 text-[10px] text-slate-600"
                    >
                      <b>{action.action}</b> ·{" "}
                      {action.created_at
                        ? new Date(action.created_at).toLocaleString()
                        : ""}
                      {action.note ? ` · ${action.note}` : ""}
                    </p>
                  ))
                ) : (
                  <p className="mt-2 text-[10px] text-slate-400">
                    Waiting for reviewer action.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200/80 p-3">
          <button
            onClick={() => {
              const link = document.createElement("a")
              link.href = URL.createObjectURL(
                new Blob([output], { type: "text/markdown" }),
              )
              link.download = "website-article.md"
              link.click()
              URL.revokeObjectURL(link.href)
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600"
          >
            <Download className="h-3.5 w-3.5" />
            Export .md
          </button>
        </footer>
      </aside>
    </div>
  )
}
function DiscoveryDetail({
  item,
  onClose,
}: {
  item: DiscoveryIdea
  onClose: () => void
}) {
  const [detail, setDetail] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDetail(null)
    setError(null)
    void db
      .fetchEbV2DiscoveryDetail(item.id)
      .then(setDetail)
      .catch((reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load Discovery trace.",
        ),
      )
  }, [item.id])
  const savedItem = detail?.item ?? item
  const evidence = Array.isArray(savedItem.evidence) ? savedItem.evidence : []
  const sources = (
    Array.isArray(detail?.sources)
      ? detail.sources
      : evidence.filter((entry: any) => entry?.kind === "library_document")
  ).map((source: any) => ({
    ...source,
    name: source.source_name ?? source.name,
    sourcePath: source.url ?? source.sourcePath,
    updatedAt: source.published_at ?? source.updatedAt,
  }))
  const run = evidence.find((entry: any) => entry?.kind === "ai_run")
  const usage = run?.usage
  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="eb-overlay absolute inset-0 z-40 flex justify-end p-3"
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col rounded-2xl border border-slate-200/80 bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200/80 p-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-purple-500">
              Discovery suggestion
            </p>
            <h2 className="mt-1 text-sm font-bold text-slate-900">
              {item.title}
            </h2>
            <p className="mt-1 text-[10px] text-slate-500">
              {item.created_at
                ? `Generated ${new Date(item.created_at).toLocaleString()}`
                : "Saved Discovery record"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <section className="rounded-xl border border-slate-200/80 bg-slate-50 p-3">
            <h3 className="text-xs font-bold text-slate-800">
              Suggestion context
            </h3>
            <p className="mt-2 text-xs leading-5 text-slate-600">
              {item.source_summary ??
                "No source summary was saved for this suggestion."}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.pillar_candidate && (
                <Tag>Pillar · {item.pillar_candidate}</Tag>
              )}
              {item.persona_candidate && (
                <Tag>Persona · {item.persona_candidate}</Tag>
              )}
              <Tag>{item.status ?? "suggested"}</Tag>
            </div>
          </section>
          <section className="mt-3 rounded-xl border border-slate-200/80 bg-white p-3">
            <h3 className="text-xs font-bold text-slate-800">Sources used</h3>
            {sources.length ? (
              <div className="mt-2 space-y-2">
                {sources.map((source: any, index: number) => (
                  <div
                    key={`${source.slug ?? source.name ?? index}`}
                    className="rounded-lg bg-slate-50 p-2 text-[10px] text-slate-600"
                  >
                    <b className="text-slate-700">
                      {source.source_name ??
                        source.name ??
                        source.slug ??
                        "Research source"}
                    </b>
                    <p className="mt-1">
                      {source.sourcePath ?? "EB Library"}
                      {source.updatedAt
                        ? ` · updated ${new Date(source.updatedAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[10px] text-slate-400">
                This older Discovery record does not include a saved source
                trace.
              </p>
            )}
          </section>
          <section className="mt-3 rounded-xl border border-slate-200/80 bg-white p-3">
            <h3 className="text-xs font-bold text-slate-800">
              AI activity log
            </h3>
            {run ? (
              <div className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] leading-5 text-slate-600">
                <p>
                  <b className="text-slate-700">
                    {run.provider}/{run.modelId}
                  </b>
                  {run.generatedAt
                    ? ` · ${new Date(run.generatedAt).toLocaleString()}`
                    : ""}
                </p>
                <p className="mt-1">
                  {usage
                    ? `${usage.inputTokens ?? 0} input · ${usage.outputTokens ?? 0} output tokens`
                    : "Usage was not returned by the provider."}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium text-slate-700">
                    View prompt & generated batch
                  </summary>
                  <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-2 text-[9px] text-slate-600">
                    {run.prompt}\n\n--- Output ---\n{run.output}
                  </pre>
                </details>
              </div>
            ) : (
              <p className="mt-2 text-[10px] text-slate-400">
                This older Discovery record does not include a saved AI
                execution log.
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  )
}
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
      {children}
    </span>
  )
}
