import TaskDetailPanel from "../TaskDetailPanel"
import { AppSelect } from "../AppDropdown"
import { useEffect, useMemo, useRef, useState } from "react"
import { BookOpen, BookOpenCheck, Check, FolderUp, Globe2, Plus, RefreshCw, Save, ScrollText, Search, Square, Trash2, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type {
  ActionDataSource,
  AppConfig,
  DocumentFile,
  EbWorkflowRule,
  FileCategory,
  KbSubTab,
  WebsiteContentRecord,
} from "../../types"
import SourceImportPanel from "./SourceImportPanel"
import {
  cancelAllWebsiteInventoryBatches,
  deleteWebsiteInventoryRecord,
  fetchMarkdownEvidenceDocument,
  uploadMarkdownEvidenceDocument,
  type MarkdownEvidenceDocument,
  fetchWebsiteInventory,
  fetchWebsiteInventoryBatch,
  scanWebsiteUrl,
  startWebsiteInventoryBatch,
  updateWebsiteInventoryRecord,
  fetchEbV2LibraryDocuments,
  deleteEbV2LearningSignal,
  fetchEbV2LearningSignals,
  updateEbV2LearningSignal,
} from "../../lib/db"

const SUBTAB_META: Record<KbSubTab, {
  label: string
  category?: FileCategory
  hint: string
  icon: LucideIcon
}> = {
  kb: {
    label: "EB Library",
    category: "kb",
    hint: "EVP pillars, personas, article patterns và channel playbooks",
    icon: BookOpen,
  },
  rules: {
    label: "EB Workflow Rules",
    category: "rules",
    hint: "Input checklist, Discovery routing, approval gates và evidence rules",
    icon: ScrollText,
  },
  website: {
    label: "Website Inventory",
    hint: "Nguồn website được phép tham chiếu khi cần link nội bộ",
    icon: Globe2,
  },
}

interface Props {
  files: DocumentFile[]
  onChange: (files: DocumentFile[]) => void
  railwayUrl: string
  config: AppConfig
  onConfigChange: (config: AppConfig) => void
  onConfigPersist?: (config: AppConfig) => Promise<void> | void
}

function toSource(file: DocumentFile): ActionDataSource {
  return {
    ...file,
    sourceType: file.sourceType ?? "file",
    addedAt: file.addedAt ?? file.uploadedAt,
  } as ActionDataSource
}

function toDocument(
  source: ActionDataSource,
  category: "kb" | "rules",
): DocumentFile {
  return {
    ...source,
    category,
    uploadedAt:
      (source as ActionDataSource & { uploadedAt?: string }).uploadedAt ??
      source.addedAt,
    size: source.size ?? `${new Blob([source.content ?? ""]).size} B`,
    fileType: (source.fileType ??
      (source.sourceType === "manual"
        ? "csv"
        : "txt")) as DocumentFile["fileType"],
  }
}

export default function TabKnowledgeBase({
  files,
  onChange,
  railwayUrl,
  config,
  onConfigChange,
  onConfigPersist,
}: Props) {
  const [activeSubTab, setActiveSubTab] = useState<KbSubTab>("kb")
  const meta = SUBTAB_META[activeSubTab]

  useEffect(() => {
    void fetchEbV2LibraryDocuments().then(({ documents }) => {
      const libraryFiles = (Array.isArray(documents) ? documents : []).map((document) => ({
        id: String(document.id), name: String(document.name), category: "kb" as const,
        size: `${document.metadata?.byteSize ?? String(document.content ?? "").length} B`,
        uploadedAt: document.updated_at, contentUpdatedAt: document.updated_at,
        fileType: "md" as const, content: String(document.content ?? ""),
      }))
      onChange([...files.filter((file) => file.category !== "kb"), ...libraryFiles])
    }).catch(() => undefined)
    // V2 documents are the source of truth for this tab; load once when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sources = meta.category
    ? files.filter((file) => file.category === meta.category).map(toSource)
    : []

  const handleChange = (nextSources: ActionDataSource[]) => {
    const category = meta.category as "kb" | "rules"
    const otherFiles = files.filter((file) => file.category !== category)
    onChange([
      ...otherFiles,
      ...nextSources.map((source) => toDocument(source, category)),
    ])
  }

  return (
    <div className="space-y-7">
      <div className="settings-subnav flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
        {(Object.entries(
          SUBTAB_META,
        ) as [KbSubTab, typeof SUBTAB_META[KbSubTab]][]).map(([key, item]) => (
          <button
            key={key}
            onClick={() => setActiveSubTab(key)}
            aria-current={activeSubTab === key ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 ui-type-body font-medium transition-colors ${
              activeSubTab === key
                ? "is-active bg-white text-slate-900"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <item.icon className="app-icon shrink-0" aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>

      {activeSubTab === "rules" ? (
        <><EbWorkflowRulesPanel config={config} onChange={onConfigChange} onPersist={onConfigPersist} /><EditorialLearningsPanel /></>
      ) : activeSubTab === "website" ? (
        <WebsiteInventoryPanel
          records={config.websiteInventory ?? []}
          railwayUrl={railwayUrl}
          onChange={(records) =>
            onConfigChange({ ...config, websiteInventory: records })
          }
        />
      ) : (
        <div className="space-y-4">
          <MarkdownEvidenceUpload />
          <EbLibraryCollections files={files} />
          <SourceImportPanel
            key={activeSubTab}
            category={meta.category ?? "kb"}
            sources={sources}
            onChange={handleChange}
            railwayUrl={railwayUrl}
            knowledgeGovernance
          />
        </div>
      )}
    </div>
  )
}

function EbLibraryCollections({ files }: { files: DocumentFile[] }) {
  const [selected, setSelected] = useState<{ title: string; file: string; detail: string; preview: string } | null>(null)
  const names = new Set(files.filter(file => file.category === "kb").map(file => file.name.toLocaleLowerCase()))
  const collections = [
    ["EVP Pillars", "pillar-library.md", "3 confirmed EVP pillars", "Analytical & Clarity-driven\nEnergetic & Spirited\nOwnership & Growth"],
    ["Persona Library", "persona-library.md", "5 motivation-led personas", "L&D Executive · Account Executive · Business Development\nAI Engineer · Social Series Content Strategist"],
    ["Article Library & repetition log", "article-library.md", "A/B/C patterns and approved log", "Type A · F Environment\nType B · Culture & Events\nType C1 · Learning Practice\nType C2 · Knowledge Workshop\n\nRepetition log is appended only after Gate 3 approval."],
    ["Channel Rules", "channel-rules.md", "Threads, Facebook and LinkedIn constraints", "Threads · Vietnamese · 2 variants · ≤500 characters\nFacebook · Vietnamese then English · ~200 words\nLinkedIn · English · credibility-led"],
  ]
  return <section className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-center gap-2"><BookOpenCheck className="h-4 w-4 text-indigo-600"/><div><h2 className="ui-type-title font-semibold text-slate-800">Required EB collections</h2><p className="mt-1 ui-type-meta text-slate-500">Nạp 4 reference documents dưới đây vào EB Library. Repetition log nằm trong Article Library và chỉ ghi sau Gate 3.</p></div></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{collections.map(([title, file, detail, preview]) => <button key={file} onClick={() => setSelected({ title, file, detail, preview })} className="rounded-lg bg-slate-50 p-2.5 text-left transition hover:bg-slate-100"><div className="flex items-center justify-between gap-2"><p className="ui-type-body font-semibold text-slate-700">{title}</p><span className={`rounded-md px-1.5 py-0.5 ui-type-meta font-semibold ${names.has(file) ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>{names.has(file) ? "Loaded" : "Required"}</span></div><p className="mt-1 ui-type-meta text-slate-500">{file} · {detail}</p></button>)}</div><p className="mt-3 ui-type-meta text-slate-400">Company profile/publishing defaults là structured configuration của workflow, không phải file reference bắt buộc. Hướng dẫn fresher thuộc Help/onboarding, không đưa vào prompt.</p>{selected && <CollectionDetail collection={selected} file={files.find(item => item.category === "kb" && item.name.toLocaleLowerCase() === selected.file)} onClose={() => setSelected(null)}/>}</section>
}

function CollectionDetail({ collection, file, onClose }: { collection: { title: string; file: string; detail: string; preview: string }; file?: DocumentFile; onClose: () => void }) {
  const content = file?.content || file?.preview || collection.preview
  return (
    <TaskDetailPanel fixed title={collection.title} badge="EB Library collection" onClose={onClose} closeLabel="Close detail"
      subtitle={`${collection.file} · ${file ? "Loaded document" : "Required schema preview"}`}>
      <div className="eb-task-inspector-content min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        <section className="rounded-xl border border-slate-200/80 bg-slate-50 p-4">
          <h3 className="ui-type-title font-semibold text-slate-800">Collection purpose</h3>
          <p className="mt-2 ui-type-body text-slate-600">{collection.detail}</p>
        </section>
        <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-slate-200/80 p-4 ui-type-reading text-slate-700">{content}</pre>
      </div>
    </TaskDetailPanel>
  )
}

const DEFAULT_EB_RULES: EbWorkflowRule[] = [
  { id: "input-validation", title: "Input validation", enabled: true, enforcement: "strict", instruction: "Run 7 must-have and 4 nice-to-have checks before Gate 1 (field names in Advanced: mustHaveFields, niceToHaveFields). Require a concrete connection to F or an F event and a source reference. Block Gate 1 only while a must-have field is empty, N/A, unknown, or a placeholder; list missing nice-to-have fields as gaps in the brief. Ask the writer all missing questions once.", advanced: '{"mustHave":7,"niceToHave":4,"mustHaveFields":["Chủ đề","Liên hệ với F","Nguồn xác nhận tại F","Dẫn chứng cụ thể","Góc bài EB","EVP pillar phù hợp","Persona mục tiêu"],"niceToHaveFields":["Nhân vật hoặc người liên quan","Thời gian hoặc sự kiện","Số liệu","Tư liệu hình ảnh"]}' },
  { id: "discovery-routing", title: "Discovery routing", enabled: true, enforcement: "guided", instruction: "Without raw material, present up to five source-backed topic options and stop for selection.", advanced: '{"maxTopics":5,"windowMonths":4}' },
  { id: "classification", title: "Pillar & persona mapping", enabled: true, enforcement: "strict", instruction: "Map one primary pillar, persona, article type and category. Ask for confirmation if pillar fit is ambiguous.", advanced: '{"primaryPillarRequired":true}' },
  { id: "approval-gates", title: "Approval gates", enabled: true, enforcement: "strict", instruction: "Stop at Brief, Website article and Social review. Pushback requires evidence; approval snapshots the active rules.", advanced: '{"gates":["brief","article","review"]}' },
  { id: "channel-constraints", title: "Channel constraints", enabled: true, enforcement: "strict", instruction: "Threads: Vietnamese, two variants, maximum 500 characters. Facebook: VN then EN. LinkedIn: English, credibility-led.", advanced: '{"threadsMaxChars":500,"threadsVariants":2}' },
]

function syncAdvancedFromInstruction(instruction: string, advanced: string) {
  let parameters: Record<string, unknown> = {}
  try { parameters = JSON.parse(advanced || "{}") } catch { return advanced }
  const threadsSection = instruction.match(/threads[\s\S]*?(?=facebook|linkedin|$)/i)?.[0] ?? ""
  const maxChars = threadsSection.match(/(?:≤|<=|maximum\s*)(\d{2,5})\s*(?:characters?|ký\s*tự)/i)?.[1]
  const variants = (threadsSection.match(/variant\s+[a-z0-9]+/gi) ?? []).length
  if (maxChars) parameters.threadsMaxChars = Number(maxChars)
  if (variants) parameters.threadsVariants = variants
  return JSON.stringify(parameters)
}

function EbWorkflowRulesPanel({ config, onChange, onPersist }: { config: AppConfig; onChange: (config: AppConfig) => void; onPersist?: (config: AppConfig) => Promise<void> | void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const settings = config.ebWorkflowSettings ?? { rules: DEFAULT_EB_RULES, promptLog: [] }
  const selected = settings.rules.find(rule => rule.id === selectedId) ?? settings.rules[0]
  const save = (rules: EbWorkflowRule[], promptLog = settings.promptLog) => onChange({ ...config, ebWorkflowSettings: { rules, promptLog } })
  const update = (id: string, patch: Partial<EbWorkflowRule>) => save(settings.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule))
  const updateInstruction = (value: string) => update(selected.id, { instruction: value, advanced: syncAdvancedFromInstruction(value, selected.advanced) })
  const remove = (id: string) => { save(settings.rules.filter(rule => rule.id !== id)); setSelectedId(null) }
  const add = () => { const rule: EbWorkflowRule = { id: `custom-${Date.now()}`, title: "New custom rule", enabled: true, enforcement: "guided", instruction: "Describe the behavior this rule adds.", advanced: "{}" }; save([...settings.rules, rule]); setSelectedId(rule.id) }
  const persistSelected = async () => { if (!onPersist || saving) return; setSaving(true); setSaved(false); try { await onPersist(config); setSaved(true); window.setTimeout(() => setSaved(false), 1800) } finally { setSaving(false) } }
  const promptPreview = settings.rules.filter(rule => rule.enabled).map(rule => `[${rule.enforcement.toUpperCase()}] ${rule.title}: ${rule.instruction}`).join("\n\n")
  return <div className="space-y-4"><section className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="ui-type-title font-semibold text-slate-800">F.Learning EB Article Writer</h2><p className="mt-1 ui-type-meta leading-5 text-slate-500">Rules are versioned in App Config. Strict rules are intended for the system prompt; guided rules become task guidance.</p></section><div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]"><nav className="overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="flex items-center justify-between border-b border-slate-200 px-3 py-2"><span className="ui-type-meta font-semibold uppercase tracking-wide text-slate-400">Rules</span><button onClick={add} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-indigo-50 hover:text-indigo-600" title="Add workflow rule" aria-label="Add workflow rule"><Plus className="h-3.5 w-3.5"/></button></div>{settings.rules.map(rule => <button key={rule.id} onClick={() => setSelectedId(rule.id)} className={`flex w-full items-center gap-2 border-b border-slate-200 px-3 py-2.5 text-left last:border-b-0 ${selected?.id === rule.id ? "bg-slate-100" : "hover:bg-slate-50"}`}><span className={`h-2 w-2 rounded-full ${rule.enabled ? "bg-emerald-500" : "bg-slate-300"}`}/><span className="min-w-0 flex-1 truncate ui-type-body font-medium text-slate-700">{rule.title}</span></button>)}</nav>{selected && <section className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-center justify-between gap-3"><label className="flex items-center gap-2 ui-type-meta font-semibold text-slate-700"><input type="checkbox" checked={selected.enabled} onChange={event => update(selected.id, { enabled: event.target.checked })}/>{selected.enabled ? "Enabled" : "Disabled"}</label><div className="flex items-center gap-1"><button onClick={() => void persistSelected()} disabled={!onPersist || saving} title={saved ? "Saved" : "Save rule"} aria-label={saved ? "Saved" : "Save rule"} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-40">{saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin"/> : saved ? <Check className="h-3.5 w-3.5 text-emerald-600"/> : <Save className="h-3.5 w-3.5"/>}</button><button onClick={() => remove(selected.id)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete rule" aria-label="Delete rule"><Trash2 className="h-3.5 w-3.5"/></button></div></div><label className="mt-4 block ui-type-meta font-semibold text-slate-700">Rule name<input value={selected.title} onChange={event => update(selected.id, { title: event.target.value })} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-2.5 ui-type-body"/></label><label className="mt-3 block ui-type-meta font-semibold text-slate-700">Enforcement<AppSelect label="Enforcement" value={selected.enforcement} className="mt-1.5 w-full" onValueChange={next => update(selected.id, { enforcement: next as EbWorkflowRule["enforcement"] })} options={[{ value: "strict", label: "Strict · system prompt" }, { value: "guided", label: "Guided · task guidance" }]} /></label><label className="mt-3 block ui-type-meta font-semibold text-slate-700">Instruction<textarea rows={5} value={selected.instruction} onChange={event => updateInstruction(event.target.value)} className="mt-1.5 w-full resize-y rounded-lg border border-slate-200 px-2.5 py-2 ui-type-body leading-5"/></label><details className="mt-3 rounded-lg border border-slate-200"><summary className="cursor-pointer px-3 py-2 ui-type-meta font-semibold text-slate-700">Advanced parameters</summary><label className="block border-t border-slate-200 p-3 ui-type-meta text-slate-500">JSON parameters<span className="mt-1 block ui-type-meta leading-4 text-slate-400">Structured runtime constraints. Recognized Threads limits in Instruction sync here automatically; edit JSON for any additional controls.</span><textarea rows={4} value={selected.advanced} onChange={event => update(selected.id, { advanced: event.target.value })} className="mt-1.5 w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 font-mono ui-type-body text-slate-700"/></label></details></section>}</div><details className="overflow-hidden rounded-xl border border-slate-200 bg-white"><summary className="cursor-pointer px-4 py-3 ui-type-meta font-semibold text-slate-700">Prompt preview & log</summary><div className="border-t border-slate-200 p-4"><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 ui-type-meta leading-5 text-slate-600">{promptPreview || "No enabled workflow rules."}</pre><p className="mt-3 ui-type-meta text-slate-400">{settings.promptLog.length ? `${settings.promptLog.length} stored prompt log entries.` : "No prompt run logged yet in shell mode. Runtime V2 will append a snapshot when each gate starts."}</p></div></details></div>
}

function EditorialLearningsPanel() {
  const [signals, setSignals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchEbV2LearningSignals()
      setSignals(Array.isArray(result.signals) ? result.signals : [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load editorial learnings.")
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const save = async (id: string, patch: { active?: boolean; instruction?: string }) => {
    try {
      const { signal } = await updateEbV2LearningSignal(id, patch)
      setSignals(current => current.map(item => item.id === id ? signal : item))
      setEditing(null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update editorial learning.") }
  }
  const remove = async (id: string) => {
    if (!window.confirm("Delete this editorial learning? It will no longer be used in future prompts.")) return
    try { await deleteEbV2LearningSignal(id); setSignals(current => current.filter(item => item.id !== id)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to delete editorial learning.") }
  }
  return <section className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="ui-type-title font-semibold text-slate-800">Editorial learnings</h2><p className="mt-1 ui-type-meta leading-5 text-slate-500">Accepted feedback revisions and explicit Threads variant approvals appear here. Approvals record editorial preference; performance evidence can be linked separately. Active learnings guide relevant future article or channel runs.</p></div><button onClick={() => void load()} title="Refresh editorial learnings" className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}/></button></div>{error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 ui-type-meta text-red-700">{error}</p>}<div className="mt-3 space-y-2">{!loading && !signals.length && <p className="rounded-lg bg-slate-50 px-3 py-3 ui-type-meta text-slate-500">No accepted feedback revisions yet.</p>}{signals.map(signal => <div key={signal.id} className="rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><span className="ui-type-meta font-semibold uppercase tracking-wide text-slate-400">{signal.gate}{signal.channel ? ` · ${signal.channel}` : ""}</span><div className="flex items-center gap-1"><button onClick={() => void save(signal.id, { active: !signal.active })} className={`rounded-md px-2 py-1 ui-type-meta font-semibold ${signal.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{signal.active ? "Active" : "Disabled"}</button><button onClick={() => { setEditing(signal.id); setDraft(signal.instruction) }} className="rounded-md px-2 py-1 ui-type-body font-semibold text-slate-500 hover:bg-slate-100">Edit</button><button onClick={() => void remove(signal.id)} title="Delete learning" className="grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3 w-3"/></button></div></div>{editing === signal.id ? <div className="mt-2"><textarea value={draft} onChange={event => setDraft(event.target.value)} rows={3} className="w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 ui-type-body text-slate-700"/><div className="mt-2 flex justify-end gap-1"><button onClick={() => setEditing(null)} className="rounded-md px-2 py-1 ui-type-body font-semibold text-slate-500">Cancel</button><button onClick={() => void save(signal.id, { instruction: draft })} disabled={!draft.trim()} className="rounded-md bg-indigo-600 px-2 py-1 ui-type-body font-semibold text-white disabled:opacity-40">Save</button></div></div> : <p className="mt-2 whitespace-pre-wrap ui-type-body leading-5 text-slate-600">{signal.instruction}</p>}</div>)}</div></section>
}

function MarkdownEvidenceUpload() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [document, setDocument] = useState<MarkdownEvidenceDocument | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    void fetchMarkdownEvidenceDocument().then(result => {
      if (active) setDocument(result)
    }).catch(reason => {
      if (active) setError(reason.message)
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [])

  async function upload(file: File) {
    setBusy(true)
    setError("")
    try {
      setDocument(await uploadMarkdownEvidenceDocument(file))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không tải được tài liệu dẫn chứng.")
    } finally {
      setBusy(false)
    }
  }

  return <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h3 className="ui-type-title font-semibold text-slate-800">Tài liệu dẫn chứng F cho Gate 1</h3>
        <p className="ui-type-meta text-slate-600">Gate 1 tự tìm dẫn chứng trong tệp Markdown dùng chung.</p>
        {document && <p className="break-words ui-type-meta text-slate-700">{document.name} · {new Date(document.uploadedAt).toLocaleString("vi-VN")}</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-1 sm:items-end">
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}
          className="settings-secondary-action inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 ui-type-body font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 sm:w-auto">
          <FolderUp className="size-4 shrink-0" aria-hidden="true" />
          {document ? "Thay tệp Markdown" : "Tải tệp Markdown"}
        </button>
        <p className="ui-type-meta text-slate-500">.md · tối đa 256 KiB</p>
      </div>
      <input ref={fileInput} type="file" accept=".md" hidden disabled={busy}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void upload(file)
        }} />
    </div>
    {busy && <p role="status" className="ui-type-body text-slate-500">Đang xử lý tài liệu…</p>}
    {error && <p role="alert" className="ui-type-meta text-red-600">{error}</p>}
  </section>
}

function WebsiteInventoryPanel({
  records,
  railwayUrl,
  onChange,
}: {
  records: WebsiteContentRecord[]
  railwayUrl: string
  onChange: (records: WebsiteContentRecord[]) => void
}) {
  const [input, setInput] = useState("")
  const [scanning, setScanning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [includeAiSummary, setIncludeAiSummary] = useState(true)
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 })
  const [summaryLimitReached, setSummaryLimitReached] = useState(false)
  const [inventoryQuery, setInventoryQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [page, setPage] = useState(1)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const resumeStarted = useRef(false)
  const pageSize = 25
  const filteredRecords = useMemo(() => {
    const query = inventoryQuery.trim().toLocaleLowerCase()
    return records
      .filter((record) => statusFilter === "all" || record.status === statusFilter)
      .filter((record) => typeFilter === "all" || record.contentType === typeFilter)
      .filter((record) => !query || [
        record.url, record.title, record.summary, record.primaryTopic,
        ...(record.topics ?? []), ...(record.services ?? []), ...(record.internalLinkAnchors ?? []),
      ].some((value) => String(value ?? "").toLocaleLowerCase().includes(query)))
      .sort((left, right) => String(right.lastChecked ?? "").localeCompare(String(left.lastChecked ?? "")))
  }, [inventoryQuery, records, statusFilter, typeFilter])
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize))
  const visibleRecords = filteredRecords.slice((page - 1) * pageSize, page * pageSize)
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages])
  const toggleExpanded = (id: string) => setExpandedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const mergeBatchRecords = (
    baseRecords: WebsiteContentRecord[],
    completed: WebsiteContentRecord[],
  ) => {
    const byUrl = new Map(completed.map((record) => [record.url, record]))
    const merged = baseRecords.map((record) => byUrl.get(record.url) ?? record)
    const known = new Set(merged.map((record) => record.url))
    return [...completed.filter((record) => !known.has(record.url)), ...merged]
  }
  const monitorBatch = async (
    jobId: string,
    baseRecords: WebsiteContentRecord[],
    cancelled: () => boolean = () => false,
  ) => {
    let mergedRecords = baseRecords
    while (!cancelled()) {
      const job = await fetchWebsiteInventoryBatch(jobId, railwayUrl)
      if (cancelled()) return
      setScanProgress({ done: job.done, total: job.total })
      if (job.summaryLimitReached) setSummaryLimitReached(true)
      mergedRecords = mergeBatchRecords(mergedRecords, job.recentRecords)
      onChange(mergedRecords)
      if (job.status === "complete") {
        onChange(await fetchWebsiteInventory(railwayUrl))
        localStorage.removeItem("writer:website-inventory-active-job")
        setActiveJobId(null)
        setScanning(false)
        return
      }
      if (job.status === "cancelled") {
        onChange(await fetchWebsiteInventory(railwayUrl))
        localStorage.removeItem("writer:website-inventory-active-job")
        setActiveJobId(null)
        setScanning(false)
        return
      }
      if (job.status === "failed" && job.done >= job.total) {
        localStorage.removeItem("writer:website-inventory-active-job")
        setScanning(false)
        throw new Error(job.error || "Website inventory batch failed.")
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  useEffect(() => {
    if (resumeStarted.current) return
    resumeStarted.current = true
    const jobId = localStorage.getItem("writer:website-inventory-active-job")
    if (!jobId) return
    let cancelled = false
    setActiveJobId(jobId)
    setScanning(true)
    setSummaryLimitReached(false)
    void monitorBatch(jobId, records, () => cancelled).catch(() => setScanning(false))
    return () => { cancelled = true }
  }, [])
  const update = (id: string, patch: Partial<WebsiteContentRecord>) =>
    onChange(
      records.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    )
  const persistUpdate = (id: string, patch: Partial<WebsiteContentRecord>) =>
    updateWebsiteInventoryRecord(id, patch, railwayUrl).catch(() => undefined)
  const scan = async () => {
    const urls = [...new Set(input.split(/[\n,]+/).flatMap((value) => {
          try {
            const parsed = new URL(value.trim())
            return ["http:", "https:"].includes(parsed.protocol)
              ? [parsed.toString()]
              : []
          } catch {
            return []
          }
        }))]
    if (!urls.length || scanning) return
    const existing = new Set(records.map((item) => item.url))
    const pending = urls
      .filter((url) => !existing.has(url))
      .map(
        (url, index): WebsiteContentRecord => ({
          id: `pending-${Date.now()}-${index}`,
          url,
          title: new URL(url).hostname,
          contentType: "blog",
          topics: [],
          services: [],
          status: "queued",
          crawlStatus: "queued",
          eligibleForInternalLink: false,
        }),
      )
    const current = [...pending, ...records]
    onChange(current)
    setInput("")
    setSummaryLimitReached(false)
    setScanning(true)
    setScanProgress({ done: 0, total: pending.length })
    try {
      const job = await startWebsiteInventoryBatch(
        pending.map((item) => item.url),
        railwayUrl,
        includeAiSummary,
      )
      localStorage.setItem("writer:website-inventory-active-job", job.id)
      setActiveJobId(job.id)
      await monitorBatch(job.id, current)
    } catch {
      setScanning(false)
    }
  }
  const recheck = async (record: WebsiteContentRecord) => {
    update(record.id, { status: "checking", crawlStatus: "checking" })
    try {
      const result = await scanWebsiteUrl(record.url, railwayUrl, true)
      onChange(
        records.map((item) =>
          item.id === record.id ? { ...result, id: record.id } : item,
        ),
      )
    } catch (error) {
      update(record.id, {
        status: "broken",
        crawlStatus: "failed",
        lastChecked: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const recheckAll = async () => {
    if (scanning || !records.length) return
    setSummaryLimitReached(false)
    setScanning(true)
    setScanProgress({ done: 0, total: records.length })
    const current: WebsiteContentRecord[] = records.map((item) => ({
      ...item,
      status: "queued" as const,
      crawlStatus: "queued" as const,
    }))
    onChange(current)
    try {
      const job = await startWebsiteInventoryBatch(records.map((item) => item.url), railwayUrl, true)
      localStorage.setItem("writer:website-inventory-active-job", job.id)
      setActiveJobId(job.id)
      await monitorBatch(job.id, current)
    } catch {
      setScanning(false)
    }
  }
  const summarizeMissing = async () => {
    const pending = records.filter((record) => !record.summary && record.status !== "broken")
    if (scanning || !pending.length) return
    setSummaryLimitReached(false)
    setScanning(true)
    setScanProgress({ done: 0, total: pending.length })
    const current = records.map((item) => pending.some((record) => record.id === item.id)
      ? { ...item, crawlStatus: "summarizing" as const }
      : item)
    onChange(current)
    try {
      const job = await startWebsiteInventoryBatch(pending.map((item) => item.url), railwayUrl, true)
      localStorage.setItem("writer:website-inventory-active-job", job.id)
      setActiveJobId(job.id)
      await monitorBatch(job.id, current)
    } catch {
      setScanning(false)
    }
  }
  const cancelScan = async () => {
    if (!activeJobId || cancelling) return
    setCancelling(true)
    try {
      await cancelAllWebsiteInventoryBatches(railwayUrl)
      localStorage.removeItem("writer:website-inventory-active-job")
      setActiveJobId(null)
      setScanning(false)
      onChange(await fetchWebsiteInventory(railwayUrl))
    } finally {
      setCancelling(false)
    }
  }
  return (
    <div className="space-y-7">
      <section>
        <h2 className="ui-type-title font-medium text-slate-800">
          Website inventory
        </h2>
        <p className="mt-1 ui-type-meta leading-5 text-slate-400">
          Paste one URL per line. Railway checks each page and extracts its
          metadata automatically.
        </p>
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <textarea
            rows={4}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              "https://flearningstudio.com/page-one\nhttps://flearningstudio.com/page-two"
            }
            className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2.5 ui-type-body"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <label className="flex items-center gap-2 ui-type-body text-slate-500">
                <input type="checkbox" checked={includeAiSummary} onChange={(event) => setIncludeAiSummary(event.target.checked)} />
                AI summary và semantic classification
              </label>
              <p className="mt-1 ui-type-body text-slate-400">
              {summaryLimitReached
                ? `Đã hết lượt AI summary hôm nay. Metadata vẫn tiếp tục scan (${scanProgress.done}/${scanProgress.total}).`
                : scanning
                  ? `Scanning ${scanProgress.done}/${scanProgress.total} pages…`
                  : "Private-network URLs and non-HTML files are blocked."}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {scanning && activeJobId && (
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={() => void cancelScan()}
                  className="settings-secondary-action inventory-remove-action inline-flex items-center gap-2 rounded-lg px-3 py-2 ui-type-body font-medium disabled:opacity-40"
                >
                  <Square size={13} fill="currentColor" aria-hidden="true" />
                  {cancelling ? "Đang dừng…" : "Dừng scan"}
                </button>
              )}
              <button
                disabled={scanning || !input.trim()}
                onClick={() => void scan()}
                className="rounded-lg bg-slate-900 px-4 py-2 ui-type-body font-medium text-white disabled:opacity-40"
              >
                {includeAiSummary ? "Import, scan & summarize" : "Import metadata only"}
              </button>
            </div>
          </div>
        </div>
      </section>
      <section>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="ui-type-title font-medium text-slate-800">
            Indexed pages{" "}
            <span className="ml-1 font-normal text-slate-400">
              {records.length}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="ui-type-meta text-slate-400">
              {
                records.filter(
                  (item) =>
                    item.eligibleForInternalLink &&
                    ["active", "redirected"].includes(item.status),
                ).length
              }{" "}
              approved
            </span>
            <button
              disabled={scanning || !records.some((item) => !item.summary && item.status !== "broken")}
              onClick={() => void summarizeMissing()}
              className="settings-secondary-action rounded-md px-2.5 py-1.5 ui-type-body text-slate-600 disabled:opacity-40"
            >
              Summarize missing
            </button>
            <button
              disabled={scanning || !records.length}
              onClick={() => void recheckAll()}
              className="settings-secondary-action rounded-md px-2.5 py-1.5 ui-type-body text-slate-600 disabled:opacity-40"
            >
              Recheck all
            </button>
          </div>
        </div>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_140px]">
          <input
            value={inventoryQuery}
            onChange={(event) => { setInventoryQuery(event.target.value); setPage(1) }}
            placeholder="Search URL, title, topic or service…"
            className="h-9 w-full px-3 ui-type-body"
          />
          <AppSelect label="Filter by status" value={statusFilter} onValueChange={next => { setStatusFilter(next); setPage(1) }} options={[
            { value: "all", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "redirected", label: "Redirected" },
            { value: "broken", label: "Broken" },
            { value: "unchecked", label: "Unchecked" },
            { value: "queued", label: "Queued" },
            { value: "checking", label: "Checking" },
          ]} />
          <AppSelect label="Filter by page type" value={typeFilter} onValueChange={next => { setTypeFilter(next); setPage(1) }} options={[
            { value: "all", label: "All page types" },
            { value: "blog", label: "Blog" },
            { value: "service", label: "Service" },
            { value: "portfolio", label: "Portfolio" },
            { value: "landing", label: "Landing" },
            { value: "about", label: "About" },
            { value: "commercial", label: "Commercial" },
          ]} />
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="website-inventory-list divide-y divide-slate-200">
            {filteredRecords.length === 0 ? (
              <p className="px-4 py-8 text-center ui-type-body text-slate-400">
                {records.length ? "No pages match the current filters." : "No website pages indexed."}
              </p>
            ) : (
              visibleRecords.map((record) => (
                <div
                  key={record.id}
                  className="website-inventory-row px-4 py-4 sm:px-5"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate ui-type-title font-medium leading-8 text-slate-800" title={record.title}>
                        {record.title || "Untitled page"}
                      </h4>
                      <a
                        href={record.redirectTarget || record.canonicalUrl || record.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate ui-type-meta text-slate-400 hover:text-slate-600"
                        title={record.url}
                      >
                        {record.url}
                      </a>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                    <AppSelect label="Status" value={record.status} disabled={record.status === "queued" || record.status === "checking"} title={record.lastError} className="w-full shrink-0 sm:w-28" onValueChange={next => {
                        const status = next as WebsiteContentRecord["status"]
                        const patch = {
                          status,
                          eligibleForInternalLink: status === "active" || status === "redirected",
                        }
                        update(record.id, patch)
                        void persistUpdate(record.id, patch)
                      }} options={[
                      { value: "queued", label: "Queued" },
                      { value: "checking", label: "Checking" },
                      { value: "unchecked", label: "Unchecked" },
                      { value: "active", label: "Active" },
                      { value: "redirected", label: "Redirected" },
                      { value: "broken", label: "Broken" },
                    ]} />
                      <button
                        type="button"
                        onClick={() => toggleExpanded(record.id)}
                        className="settings-secondary-action inline-flex size-8 items-center justify-center rounded-md text-slate-500"
                        aria-expanded={expandedIds.has(record.id)}
                        aria-label={expandedIds.has(record.id) ? "Close details" : "View details"}
                        title={expandedIds.has(record.id) ? "Close details" : "View details"}
                      >
                        {expandedIds.has(record.id) ? <X size={15} /> : <Search size={15} />}
                      </button>
                    </div>
                  </div>

                  {record.summary && !expandedIds.has(record.id) && (
                    <p className="mt-2 truncate ui-type-meta leading-5 text-slate-400" title={record.summary}>{record.summary}</p>
                  )}

                  {expandedIds.has(record.id) && <>
                  {record.summary && <p className="mt-3 ui-type-meta leading-5 text-slate-500">{record.summary}</p>}
                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="min-w-0 ui-type-meta font-medium text-slate-400">
                      Page type
                      <AppSelect label="Page type" value={record.contentType} className="mt-1 w-full" onValueChange={next => {
                          const patch = { contentType: next as WebsiteContentRecord["contentType"] }
                          update(record.id, patch)
                          void persistUpdate(record.id, patch)
                        }} options={[
                        { value: "blog", label: "Blog" },
                        { value: "service", label: "Service" },
                        { value: "portfolio", label: "Portfolio" },
                        { value: "landing", label: "Landing" },
                        { value: "about", label: "About" },
                        { value: "commercial", label: "Commercial" },
                      ]} />
                    </label>
                    <label className="min-w-0 ui-type-meta font-medium text-slate-400">
                      Topics
                      <input
                        value={record.topics.join(", ")}
                        onChange={(event) => update(record.id, { topics: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
                        onBlur={(event) => void persistUpdate(record.id, { topics: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
                        className="mt-1 h-9 w-full min-w-0 px-2 ui-type-body"
                      />
                    </label>
                    <label className="min-w-0 ui-type-meta font-medium text-slate-400">
                      Services
                      <input
                        value={(record.services ?? []).join(", ")}
                        onChange={(event) => update(record.id, { services: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
                        onBlur={(event) => void persistUpdate(record.id, { services: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
                        className="mt-1 h-9 w-full min-w-0 px-2 ui-type-body"
                      />
                    </label>
                  </div>
                  </>}

                  <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3 ui-type-meta text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>Checked {record.lastChecked ? new Date(record.lastChecked).toLocaleString() : "—"}</span>
                      {record.summarizedAt && <span>{record.summaryCacheHit ? "Cached" : record.aiModel || "AI"} · {new Date(record.summarizedAt).toLocaleDateString()}</span>}
                      {record.searchIntent && <span className="capitalize">{record.searchIntent}</span>}
                    </div>
                    <div className="flex items-center gap-1 self-end sm:self-auto">
                      <button
                        type="button"
                        onClick={() => void recheck(record)}
                        className="settings-secondary-action inline-flex size-8 items-center justify-center rounded-md text-slate-500"
                        aria-label="Recheck URL"
                        title="Recheck URL"
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteWebsiteInventoryRecord(record.id, railwayUrl)
                          .then(() => onChange(records.filter((item) => item.id !== record.id)))}
                        className="settings-secondary-action inventory-remove-action inline-flex size-8 items-center justify-center rounded-md"
                        aria-label="Remove URL"
                        title="Remove URL"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        {filteredRecords.length > pageSize && (
          <div className="mt-3 flex flex-col gap-2 ui-type-meta text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <span>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filteredRecords.length)} of {filteredRecords.length}</span>
            <div className="flex items-center gap-2">
              <button disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="settings-secondary-action rounded-md px-3 py-1.5 disabled:opacity-40">Previous</button>
              <span>Page {page} / {totalPages}</span>
              <button disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="settings-secondary-action rounded-md px-3 py-1.5 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
