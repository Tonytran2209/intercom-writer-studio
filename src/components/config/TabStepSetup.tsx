import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Clock3, FileText, Sparkles } from 'lucide-react';
import type { AppConfig, Article, DocumentFile } from '../../types';
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

export default function TabStepSetup({ config, files, articles, onChange }: Props) {
  const { language, tr } = useI18n();
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const enabledModels = config.models.filter(model => model.enabled);
  const readyKb = files.filter(file => file.category === 'kb' && isDocumentReady(file));
  const enabledRules = (config.ebWorkflowSettings?.rules ?? []).filter(rule => rule.enabled);
  const usageByStep = useMemo(() => Object.fromEntries(([1, 2, 3, 4] as const).map(step => [step, articles.flatMap(article => article.aiUsageByStep?.[step] ?? [])])), [articles]);

  useEffect(() => { pingRailway(config.railwayUrl || RAILWAY_URL).then(result => setBackendOk(result.ok)); }, [config.railwayUrl]);

  const updateStepModel = (step: number, modelId: string) => onChange({
    ...config,
    stepConfigs: { ...config.stepConfigs, [step]: { ...config.stepConfigs[step], modelId, fileAccess: { kb: readyKb.map(file => file.id), rules: [] } } },
  });
  const updateDraftWordLimit = (value: number) => onChange({ ...config, stepConfigs: { ...config.stepConfigs, 4: { ...config.stepConfigs[4], maxDraftWords: Math.min(10000, Math.max(800, value || 1500)) } } });
  const modelSelect = (step: number, label: string) => <select aria-label={`${label} model`} value={config.stepConfigs[step]?.modelId ?? ''} onChange={event => updateStepModel(step, event.target.value)} className="h-9 min-w-48 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700"><option value="">— {tr('Chọn model', 'Select model')} —</option>{enabledModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>;
  const usage = (step: 1 | 2 | 3 | 4) => { const calls = usageByStep[step] ?? []; return `${calls.reduce((sum, call) => sum + Number(call.totalTokens ?? 0), 0).toLocaleString()} tokens · ${calls.length} AI calls`; };

  return <div className="settings-stack space-y-7">
    <section>
      <h2 className="mb-1 text-sm font-medium text-slate-800">{tr('Flow đang chạy', 'Active flow')}</h2>
      <p className="mb-3 text-xs leading-5 text-slate-500">{tr('Cấu hình dưới đây bám đúng luồng package trong Workspace. Chỉ các bước đã có AI runtime mới có lựa chọn model.', 'These settings mirror the package flow in Workspace. Only stages with an AI runtime expose a model choice.')}</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <GateRow number="1" tone="bg-blue-500" title={tr('Brief · Gate 1', 'Brief · Gate 1')} description={tr('Nhận input/Discovery, extract & check, sau đó map EVP pillar và persona.', 'Receives input or Discovery, extracts and checks it, then maps EVP pillar and persona.')} status={tr('AI: extract & mapping', 'AI: extract & mapping')}>
          {modelSelect(1, 'Brief gate')}
          <span className="text-[10px] text-slate-400">{usage(1)}</span>
        </GateRow>
        <div className="border-t border-slate-200">
          <GateRow number="2" tone="bg-amber-500" title={tr('Website article · Gate 2', 'Website article · Gate 2')} description={tr('Sau khi brief được duyệt: tạo Article Spec → Outline → Draft fab.careers và dừng để duyệt.', 'After brief approval: creates Article Spec → Outline → fab.careers draft, then stops for approval.')} status={tr('AI: 3 tác vụ nối tiếp', 'AI: 3 sequential stages')}>
            <div className="w-full space-y-2.5">
              {articleStages.map(stage => <div key={stage.step} className="flex flex-col gap-2 rounded-lg bg-slate-50 px-2.5 py-2 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-700">{language === 'vi' ? stage.labelVi : stage.labelEn}</p><p className="mt-0.5 text-[10px] text-slate-400">{language === 'vi' ? stage.detailVi : stage.detailEn} · {usage(stage.step)}</p></div>{modelSelect(stage.step, stage.labelEn)}{stage.step === 4 && <label className="flex items-center gap-1.5 text-[10px] text-slate-500"><input aria-label={tr('Số từ tiếng Anh mục tiêu', 'Target English words')} type="number" min={800} max={10000} step={100} value={Math.max(800, config.stepConfigs[4]?.maxDraftWords ?? config.stepConfigs[4]?.maxDraftCharacters ?? 1500)} onChange={event => updateDraftWordLimit(Number(event.target.value))} className="h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700" />words</label>}</div>)}
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
  </div>;
}

function GateRow({ number, tone, title, description, status, children }: { number: string; tone: string; title: string; description: string; status: string; children: React.ReactNode }) { return <div className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-start"><div className="flex min-w-0 flex-1 gap-3"><span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${tone} text-[10px] font-bold text-white`}>{number}</span><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-slate-800">{title}</p><span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">{status}</span></div><p className="mt-1 max-w-lg text-xs leading-5 text-slate-500">{description}</p></div></div><div className="flex shrink-0 flex-col items-end gap-1.5 lg:max-w-[570px]">{children}</div></div> }
function RuntimeNotice({ icon, text }: { icon: React.ReactNode; text: string }) { return <p className="flex max-w-sm items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[10px] leading-4 text-slate-500">{icon}{text}</p> }
function InfoRow({ icon, title, detail, value }: { icon: React.ReactNode; title: string; detail: string; value: string }) { return <div className="flex items-center gap-3 px-4 py-3"><span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-50">{icon}</span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-700">{title}</p><p className="truncate text-[10px] text-slate-400">{detail}</p></div><span className="shrink-0 text-[10px] font-medium text-slate-500">{value}</span><ChevronRight className="h-3.5 w-3.5 text-slate-300"/></div> }
