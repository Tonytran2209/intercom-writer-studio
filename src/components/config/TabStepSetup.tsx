import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Clock3, Database, FileText, ShieldCheck, Sparkles } from 'lucide-react';
import type { AppConfig, Article, DocumentFile, EbRuntimeSettings } from '../../types';
import { pingRailway } from '../../lib/db';
import { isDocumentReady } from '../../lib/documentStatus';
import { useI18n } from '../../lib/i18n';

interface Props { config: AppConfig; files: DocumentFile[]; articles: Article[]; onChange: (config: AppConfig) => void }
const RAILWAY_URL = 'https://rebuildwriterstudiotool-production.up.railway.app';
const articleStages = [
  { step: 2, labelVi: 'Article spec', labelEn: 'Article spec', detailVi: 'Định hướng, keyword và contract bài viết', detailEn: 'Direction, keywords and article contract' },
  { step: 3, labelVi: 'Draft outline', labelEn: 'Draft outline', detailVi: 'Cấu trúc fab.careers có evidence', detailEn: 'Evidence-backed fab.careers structure' },
  { step: 4, labelVi: 'First draft & check', labelEn: 'First draft & check', detailVi: 'Bài viết và kiểm tra chất lượng', detailEn: 'Article draft and quality checks' },
] as const;
const DEFAULT_EB_RUNTIME: EbRuntimeSettings = { tablePrefix: 'eb_v2_', adaptModelId: '', repetitionModelId: '', enableAiRepetitionCheck: true, persistInputSnapshots: true, persistPromptLogs: true };

export default function TabStepSetup({ config, files, articles, onChange }: Props) {
  const { language, tr } = useI18n();
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const enabledModels = config.models.filter(model => model.enabled);
  const readyKb = files.filter(file => file.category === 'kb' && isDocumentReady(file));
  const enabledRules = (config.ebWorkflowSettings?.rules ?? []).filter(rule => rule.enabled);
  const runtime = { ...DEFAULT_EB_RUNTIME, ...config.ebRuntimeSettings };
  const usageByStep = useMemo(() => Object.fromEntries(([1, 2, 3, 4] as const).map(step => [step, articles.flatMap(article => article.aiUsageByStep?.[step] ?? [])])), [articles]);

  useEffect(() => { pingRailway(config.railwayUrl || RAILWAY_URL).then(result => setBackendOk(result.ok)); }, [config.railwayUrl]);

  const updateStepModel = (step: number, modelId: string) => onChange({
    ...config,
    stepConfigs: { ...config.stepConfigs, [step]: { ...config.stepConfigs[step], modelId, fileAccess: { kb: readyKb.map(file => file.id), rules: [] } } },
  });
  const updateDraftWordLimit = (value: number) => onChange({ ...config, stepConfigs: { ...config.stepConfigs, 4: { ...config.stepConfigs[4], maxDraftWords: Math.min(10000, Math.max(800, value || 1500)) } } });
  const updateRuntime = (patch: Partial<EbRuntimeSettings>) => onChange({ ...config, ebRuntimeSettings: { ...runtime, ...patch } });
  const modelSelect = (step: number, label: string) => <select aria-label={`${label} model`} value={config.stepConfigs[step]?.modelId ?? ''} onChange={event => updateStepModel(step, event.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 sm:w-56"><option value="">— {tr('Chọn model', 'Select model')} —</option>{enabledModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>;
  const usage = (step: 1 | 2 | 3 | 4) => { const calls = usageByStep[step] ?? []; return `${calls.reduce((sum, call) => sum + Number(call.totalTokens ?? 0), 0).toLocaleString()} tokens · ${calls.length} AI calls`; };

  return <div className="settings-stack space-y-7">
    <section>
      <h2 className="mb-1 text-sm font-medium text-slate-800">{tr('Flow đang chạy', 'Active flow')}</h2>
      <p className="mb-3 text-xs leading-5 text-slate-500">{tr('Cấu hình dưới đây bám đúng luồng package trong Workspace. Chỉ các bước đã có AI runtime mới có lựa chọn model.', 'These settings mirror the package flow in Workspace. Only stages with an AI runtime expose a model choice.')}</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <GateRow number="1" tone="bg-blue-500" title={tr('Brief · Gate 1', 'Brief · Gate 1')} description={tr('Nhận input/Discovery, extract & check, sau đó map EVP pillar và persona.', 'Receives input or Discovery, extracts and checks it, then maps EVP pillar and persona.')} status={tr('AI: extract & mapping', 'AI: extract & mapping')}>
          <AiStageRow title={tr('Extract & pillar/persona mapping', 'Extract & pillar/persona mapping')} detail={tr('Kiểm input, xác định evidence và mapping theo EB Library.', 'Checks input, identifies evidence and maps it through EB Library.')} usage={usage(1)} control={modelSelect(1, 'Brief gate')} />
        </GateRow>
        <div className="border-t border-slate-200">
          <GateRow number="2" tone="bg-amber-500" title={tr('Website article · Gate 2', 'Website article · Gate 2')} description={tr('Sau khi brief được duyệt: tạo Article Spec → Outline → Draft fab.careers và dừng để duyệt.', 'After brief approval: creates Article Spec → Outline → fab.careers draft, then stops for approval.')} status={tr('AI: 3 tác vụ nối tiếp', 'AI: 3 sequential stages')}>
            <div className="w-full space-y-2.5">
              {articleStages.map(stage => <AiStageRow key={stage.step} title={language === 'vi' ? stage.labelVi : stage.labelEn} detail={language === 'vi' ? stage.detailVi : stage.detailEn} usage={usage(stage.step)} control={<>{modelSelect(stage.step, stage.labelEn)}{stage.step === 4 && <label className="flex items-center gap-1.5 text-[10px] text-slate-500"><input aria-label={tr('Số từ tiếng Anh mục tiêu', 'Target English words')} type="number" min={800} max={10000} step={100} value={Math.max(800, config.stepConfigs[4]?.maxDraftWords ?? config.stepConfigs[4]?.maxDraftCharacters ?? 1500)} onChange={event => updateDraftWordLimit(Number(event.target.value))} className="h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700" />words</label>}</>} />)}
            </div>
          </GateRow>
        </div>
        <div className="border-t border-slate-200"><GateRow number="3" tone="bg-purple-500" title={tr('Adapt channel', 'Adapt channel')} description={tr('Từ article đã duyệt, tạo riêng output cho Threads, Facebook và LinkedIn theo Channel Rules.', 'From an approved article, creates distinct Threads, Facebook and LinkedIn outputs using Channel Rules.')} status={tr('Đang mô phỏng trong Shell mode', 'Simulated in Shell mode')}><RuntimeNotice icon={<Clock3 className="h-3.5 w-3.5"/>} text={tr('Chưa có AI call riêng — model sẽ được dùng khi Adapt runtime V2 được kết nối.', 'No separate AI call yet — a model will be used when Adapt runtime V2 is connected.')} /></GateRow></div>
        <div className="border-t border-slate-200"><GateRow number="4" tone="bg-emerald-500" title={tr('Review · Gate 3', 'Review · Gate 3')} description={tr('Kiểm repetition, sau đó reviewer xác nhận Done, Reject hoặc Re-check cho từng channel.', 'Runs repetition checks; the reviewer then marks each channel Done, Reject or Re-check.')} status={tr('Human decision gate', 'Human decision gate')}><RuntimeNotice icon={<CheckCircle2 className="h-3.5 w-3.5"/>} text={tr('Không tự publish; action cuối do user quyết định.', 'Never auto-publishes; final action is always decided by the user.')} /></GateRow></div>
      </div>
    </section>

    <section>
      <h2 className="mb-3 text-sm font-medium text-slate-800">{tr('Context áp dụng cho flow', 'Flow context')}</h2>
      <div className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <InfoRow icon={<FileText className="h-4 w-4 text-indigo-600"/>} title="EB Library" detail={readyKb.length ? readyKb.map(file => file.name).join(', ') : tr('Chưa có collection nào được nạp', 'No collections loaded')} value={`${readyKb.length}/4`} />
        <InfoRow icon={<Sparkles className="h-4 w-4 text-indigo-600"/>} title={tr('Workflow Rules', 'Workflow Rules')} detail={enabledRules.length ? tr(`${enabledRules.length} rules đang Enabled; chỉnh sửa tại EB Knowledge & Rules.`, `${enabledRules.length} rules enabled; edit them in EB Knowledge & Rules.`) : tr('Chưa có rule được bật', 'No rules enabled')} value={String(enabledRules.length)} />
        <InfoRow icon={<span className={`h-2 w-2 rounded-full ${backendOk ? 'bg-emerald-500' : backendOk === false ? 'bg-red-500' : 'animate-pulse bg-slate-300'}`} />} title={tr('AI backend', 'AI backend')} detail={config.railwayUrl || RAILWAY_URL} value={backendOk ? tr('Online', 'Online') : backendOk === false ? tr('Offline', 'Offline') : tr('Checking', 'Checking')} />
      </div>
    </section>

    <section>
      <h2 className="mb-1 text-sm font-medium text-slate-800">{tr('Runtime V2 readiness', 'Runtime V2 readiness')}</h2>
      <p className="mb-3 text-xs leading-5 text-slate-500">{tr('Thiết lập trước cho data adapter mới. Những lựa chọn này chưa kích hoạt kết nối, ghi dữ liệu hoặc thay đổi bất kỳ table Supabase hiện có nào.', 'Prepare the new data adapter. These choices do not activate a connection, write data, or alter any existing Supabase table.')}</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid gap-3 border-b border-slate-200 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_220px]"><div><div className="flex items-center gap-2"><Database className="h-4 w-4 text-indigo-600"/><p className="text-xs font-semibold text-slate-700">{tr('Supabase V2 table namespace', 'Supabase V2 table namespace')}</p></div><p className="mt-1 text-[10px] leading-4 text-slate-400">{tr('Tiền tố chỉ dành cho các table mới; các table hiện hữu không bị đọc, đổi tên hay xoá.', 'Prefix reserved for new tables only; existing tables are never read, renamed, or deleted.')}</p></div><label className="block"><span className="sr-only">Supabase V2 table namespace</span><input value={runtime.tablePrefix} onChange={event => updateRuntime({ tablePrefix: event.target.value.replace(/[^a-z0-9_]/gi, '_').toLowerCase() })} placeholder="eb_v2_" className="h-9 w-full rounded-lg border border-slate-200 px-2.5 font-mono text-xs text-slate-700"/></label></div>
        <div className="grid gap-3 border-b border-slate-200 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_220px]"><div><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-purple-600"/><p className="text-xs font-semibold text-slate-700">{tr('Adapt channel model', 'Adapt channel model')}</p></div><p className="mt-1 text-[10px] leading-4 text-slate-400">{tr('Một model mặc định cho Threads, Facebook và LinkedIn; override theo channel sẽ nằm ở Channel Rules sau này.', 'One default model for Threads, Facebook and LinkedIn; per-channel overrides will live in Channel Rules later.')}</p></div><select value={runtime.adaptModelId} onChange={event => updateRuntime({ adaptModelId: event.target.value })} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700"><option value="">— {tr('Chọn model khi runtime sẵn sàng', 'Select model when runtime is ready')} —</option>{enabledModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div>
        <div className="grid gap-3 border-b border-slate-200 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_220px]"><div><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600"/><p className="text-xs font-semibold text-slate-700">{tr('AI repetition check', 'AI repetition check')}</p></div><p className="mt-1 text-[10px] leading-4 text-slate-400">{tr('Chạy trước Review · Gate 3 để so ý, hook và format với Article Library; quyết định cuối vẫn thuộc về user.', 'Runs before Review · Gate 3 to compare ideas, hooks and formats with Article Library; the user keeps the final decision.')}</p></div><div className="flex items-center gap-2"><label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600"><input type="checkbox" checked={runtime.enableAiRepetitionCheck} onChange={event => updateRuntime({ enableAiRepetitionCheck: event.target.checked })}/>{tr('Enable', 'Enable')}</label><select disabled={!runtime.enableAiRepetitionCheck} value={runtime.repetitionModelId} onChange={event => updateRuntime({ repetitionModelId: event.target.value })} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"><option value="">{tr('Dùng model Adapt', 'Use Adapt model')}</option>{enabledModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div></div>
        <div className="grid gap-3 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_220px]"><div><p className="text-xs font-semibold text-slate-700">{tr('V2 audit trail', 'V2 audit trail')}</p><p className="mt-1 text-[10px] leading-4 text-slate-400">{tr('Lưu snapshot input và prompt log theo từng gate để trace kết quả khi V2 live.', 'Stores input snapshots and per-gate prompt logs to trace outcomes once V2 is live.')}</p></div><div className="flex flex-wrap gap-3 text-xs text-slate-600"><label className="flex items-center gap-1.5"><input type="checkbox" checked={runtime.persistInputSnapshots} onChange={event => updateRuntime({ persistInputSnapshots: event.target.checked })}/>{tr('Input', 'Input')}</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={runtime.persistPromptLogs} onChange={event => updateRuntime({ persistPromptLogs: event.target.checked })}/>{tr('Prompt log', 'Prompt log')}</label></div></div>
      </div>
      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[10px] leading-4 text-amber-700">{tr('Go-live cần: tạo migration cho namespace V2, deploy V2 adapter, sau đó mới đổi VITE_WRITER_DATA_MODE=connected. Shell mode hiện vẫn là lớp bảo vệ không ghi dữ liệu.', 'Go-live requires: create the V2 namespace migration, deploy the V2 adapter, then change VITE_WRITER_DATA_MODE=connected. Shell mode remains a no-write safeguard.')}</p>
    </section>
  </div>;
}

function GateRow({ number, tone, title, description, status, children }: { number: string; tone: string; title: string; description: string; status: string; children: React.ReactNode }) { return <div className="px-4 py-3.5"><div className="flex min-w-0 gap-3"><span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${tone} text-[10px] font-bold text-white`}>{number}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-slate-800">{title}</p><span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">{status}</span></div><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{description}</p></div></div><div className="ml-9 mt-3 flex flex-wrap items-center gap-2">{children}</div></div> }
function AiStageRow({ title, detail, usage, control }: { title: string; detail: string; usage: string; control: React.ReactNode }) { return <div className="grid w-full gap-2 rounded-lg bg-slate-50 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_224px] sm:items-center"><div className="min-w-0"><p className="text-xs font-semibold text-slate-700">{title}</p><p className="mt-0.5 text-[10px] leading-4 text-slate-400">{detail} <span className="whitespace-nowrap">· {usage}</span></p></div><div className="flex flex-wrap items-center gap-2">{control}</div></div> }
function RuntimeNotice({ icon, text }: { icon: React.ReactNode; text: string }) { return <p className="flex max-w-sm items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[10px] leading-4 text-slate-500">{icon}{text}</p> }
function InfoRow({ icon, title, detail, value }: { icon: React.ReactNode; title: string; detail: string; value: string }) { return <div className="flex items-center gap-3 px-4 py-3"><span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-50">{icon}</span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-700">{title}</p><p className="truncate text-[10px] text-slate-400">{detail}</p></div><span className="shrink-0 text-[10px] font-medium text-slate-500">{value}</span><ChevronRight className="h-3.5 w-3.5 text-slate-300"/></div> }
