import { BookOpenCheck, CheckCircle2, ChevronRight, FileText, Languages, ShieldCheck, Sparkles, Users } from "lucide-react"
import type { AppConfig } from "../../types"

interface Props { config: AppConfig; onChange: (config: AppConfig) => void }

const library = [
  { icon: ShieldCheck, title: "EVP Pillars", detail: "3 active pillars · mapping requires one primary pillar" },
  { icon: Users, title: "Persona Library", detail: "5 target personas · motivation-led matching" },
  { icon: BookOpenCheck, title: "Article Patterns", detail: "A Environment · B Events · C1 Practice · C2 Workshop" },
  { icon: Languages, title: "Channel Playbooks", detail: "Threads, Facebook and LinkedIn constraints" },
  { icon: FileText, title: "Repetition Log", detail: "Write only after Gate 3 is approved" },
]

export default function TabEbSkill({ config, onChange }: Props) {
  const selectedModel = config.stepConfigs[2]?.modelId ?? ""
  return <div className="space-y-8">
    <section className="overflow-hidden rounded-xl border border-violet-200 bg-violet-50/60">
      <div className="flex items-start gap-3 p-4"><div className="rounded-lg bg-violet-600 p-2 text-white"><Sparkles className="h-4 w-4" /></div><div><h2 className="text-sm font-semibold text-slate-900">F.Learning EB Article Writer</h2><p className="mt-1 text-xs leading-5 text-slate-600">Một skill tạo website article và social package từ chất liệu văn hoá có bằng chứng. Đang chạy bằng dữ liệu mô phỏng trong shell mode.</p></div><span className="ml-auto rounded-full bg-violet-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-violet-700">Draft</span></div>
    </section>

    <section><div className="mb-3"><h2 className="text-sm font-semibold text-slate-900">Knowledge library</h2><p className="mt-1 text-xs text-slate-500">Các nguồn điều khiển cách skill phân loại, viết và tránh lặp nội dung.</p></div><div className="divide-y overflow-hidden rounded-xl border border-slate-200 bg-white">{library.map(item => { const Icon = item.icon; return <button type="button" key={item.title} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"><span className="rounded-lg bg-slate-100 p-2 text-slate-600"><Icon className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-800">{item.title}</span><span className="block truncate text-xs text-slate-500">{item.detail}</span></span><ChevronRight className="h-4 w-4 text-slate-400" /></button> })}</div></section>

    <section className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="text-sm font-semibold text-slate-900">Approval & evidence rules</h2><div className="mt-3 space-y-3 text-sm text-slate-700"><label className="flex items-start gap-3"><input type="checkbox" checked readOnly className="mt-0.5 accent-violet-600"/><span><b>Require evidence for every factual detail</b><small className="mt-0.5 block text-xs text-slate-500">N/A is retained as a gap; the writer never fills it with invented details.</small></span></label><label className="flex items-start gap-3"><input type="checkbox" checked readOnly className="mt-0.5 accent-violet-600"/><span><b>Three approval gates</b><small className="mt-0.5 block text-xs text-slate-500">Brief → website article → social package & repetition review.</small></span></label><label className="flex items-start gap-3"><input type="checkbox" checked readOnly className="mt-0.5 accent-violet-600"/><span><b>Pushback needs supporting evidence</b><small className="mt-0.5 block text-xs text-slate-500">A pillar override is recorded in the final publishing log.</small></span></label></div></section>

    <section className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-900">Writing model</h2><p className="mt-1 text-xs text-slate-500">Used for the intake, article and social drafting simulation.</p></div><select value={selectedModel} onChange={event => onChange({ ...config, stepConfigs: { ...config.stepConfigs, 2: { ...config.stepConfigs[2], modelId: event.target.value } } })} className="h-9 max-w-56 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700"><option value="">Choose a model</option>{config.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div></section>
  </div>
}
