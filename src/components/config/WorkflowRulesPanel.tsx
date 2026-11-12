import { AppSelect } from "../AppDropdown"
import { useMemo, useState } from 'react';
import type { AppConfig, DocumentFile, WorkflowRuleEnforcement, WorkflowRuleId } from '../../types';
import { compileWorkflowRules, getStageEffective, getWorkflowRuleSetting, WORKFLOW_RULE_DEFINITIONS } from '../../lib/workflowRules';
import { isDocumentReady } from '../../lib/documentStatus';
import { useI18n } from '../../lib/i18n';

interface Props { config: AppConfig; files: DocumentFile[]; onChange: (config: AppConfig) => void }

type PhaseId = 'article-spec' | 'quality-gate' | 'knowledge' | 'orchestration';

const PHASES: Array<{ id: PhaseId; number: number; titleVi: string; titleEn: string; descriptionVi: string; descriptionEn: string; rules: WorkflowRuleId[] }> = [
  { id: 'article-spec', number: 1, titleVi: 'Article Spec foundation', titleEn: 'Article Spec foundation', descriptionVi: 'Khóa intent, reader outcome, keyword, thesis và phạm vi nội dung trước khi viết.', descriptionEn: 'Lock intent, reader outcome, keywords, thesis, and coverage before writing.', rules: ['core-idea'] },
  { id: 'quality-gate', number: 2, titleVi: 'Universal Quality Gate', titleEn: 'Universal Quality Gate', descriptionVi: 'Kiểm tra deterministic và semantic trước khi draft được chấp nhận.', descriptionEn: 'Run deterministic and semantic checks before a draft is accepted.', rules: ['quality-persistence'] },
  { id: 'knowledge', number: 3, titleVi: 'Knowledge governance', titleEn: 'Knowledge governance', descriptionVi: 'Quy định cách Content Plan, KB, nguồn nội bộ và website inventory được đọc.', descriptionEn: 'Control how Content Plans, KB, internal sources, and website inventory are read.', rules: ['source-grounding'] },
  { id: 'orchestration', number: 4, titleVi: 'Workflow orchestration', titleEn: 'Workflow orchestration', descriptionVi: 'Standard có thể chạy batch; Editorial cần duyệt outline trước khi tạo draft.', descriptionEn: 'Standard may run in batch; Editorial requires outline approval before drafting.', rules: ['outline', 'draft'] },
];

const STEP_LABELS: Record<number, string> = { 2: 'Step 1 · Article Spec', 3: 'Step 2 · Outline', 4: 'Step 3 · Draft' };

export default function WorkflowRulesPanel({ config, files, onChange }: Props) {
  const { language, tr } = useI18n();
  const [phaseId, setPhaseId] = useState<PhaseId>('article-spec');
  const [editingStage, setEditingStage] = useState<string | null>(null);
  const phase = PHASES.find(item => item.id === phaseId) ?? PHASES[0];
  const definitions = useMemo(() => phase.rules.flatMap(id => WORKFLOW_RULE_DEFINITIONS.filter(rule => rule.id === id)), [phase]);
  const readyKb = files.filter(file => file.category === 'kb' && isDocumentReady(file)).length;
  const readyGuides = files.filter(file => file.category === 'rules' && isDocumentReady(file)).length;

  const replaceSetting = (id: WorkflowRuleId, patch: Partial<ReturnType<typeof getWorkflowRuleSetting>>) => {
    const current = getWorkflowRuleSetting(config, id);
    onChange({ ...config, workflowRules: { ...config.workflowRules, [id]: { ...current, ...patch, version: current.version + 1 } } });
  };
  const updateStage = (id: WorkflowRuleId, stageId: string, patch: { instruction?: string; parameters?: Record<string, number | string | boolean> }) => {
    const setting = getWorkflowRuleSetting(config, id);
    replaceSetting(id, { stageOverrides: { ...setting.stageOverrides, [stageId]: { ...setting.stageOverrides[stageId], ...patch } } });
  };
  const resetStage = (id: WorkflowRuleId, stageId: string) => {
    const setting = getWorkflowRuleSetting(config, id); const next = { ...setting.stageOverrides }; delete next[stageId];
    replaceSetting(id, { stageOverrides: next }); setEditingStage(null);
  };
  const resetRule = (id: WorkflowRuleId) => onChange({ ...config, workflowRules: { ...config.workflowRules, [id]: undefined } });

  return <div className="workflow-rules-panel space-y-7">
    <section>
      <h2 className="ui-type-title font-medium text-slate-800">{tr('Pipeline behavior', 'Pipeline behavior')}</h2>
      <p className="mt-1 ui-type-meta leading-5 text-slate-400">{tr('Bốn giai đoạn này là logic thực tế được compiler đưa vào prompt của bài đơn và batch.', 'These four phases are the actual behavior compiled into manual and batch prompts.')}</p>
      <div className="workflow-phase-switcher mt-4 grid overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-2">
        {PHASES.map(item => <button key={item.id} onClick={() => { setPhaseId(item.id); setEditingStage(null); }} className={`workflow-phase-button flex items-center gap-3 px-4 py-3 text-left ${phaseId === item.id ? 'is-active bg-slate-100' : 'bg-white'}`}><span className="workflow-phase-index flex h-6 w-6 shrink-0 items-center justify-center rounded-md ui-type-body text-slate-500">{item.number}</span><span className="truncate ui-type-body font-medium text-slate-800">{language === 'vi' ? item.titleVi : item.titleEn}</span></button>)}
      </div>
    </section>

    <section>
      <div className="mb-4">
        <h3 className="ui-type-title font-medium text-slate-900">{language === 'vi' ? phase.titleVi : phase.titleEn}</h3>
        <p className="mt-1 ui-type-body leading-6 text-slate-500">{language === 'vi' ? phase.descriptionVi : phase.descriptionEn}</p>
      </div>

      {phase.id === 'knowledge' && <div className="knowledge-source-summary mb-4 grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-slate-50 px-4 py-3"><p className="ui-type-meta text-slate-400">Knowledge Base</p><p className="mt-1 ui-type-title font-medium text-slate-800">{readyKb} {tr('nguồn sẵn sàng', 'ready sources')}</p></div><div className="rounded-lg bg-slate-50 px-4 py-3"><p className="ui-type-meta text-slate-400">Reference guides</p><p className="mt-1 ui-type-title font-medium text-slate-800">{readyGuides} {tr('nguồn sẵn sàng', 'ready sources')}</p></div></div>}

      {phase.id === 'orchestration' && <div className="settings-preference-group mb-4 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="flex items-center justify-between gap-4 px-4 py-3.5"><div><p className="ui-type-body font-medium text-slate-800">Standard / Scalable</p><p className="mt-0.5 ui-type-meta leading-5 text-slate-400">{tr('Cho phép bài đơn và batch tự động tiếp tục sau khi outline hợp lệ.', 'Manual and batch runs may continue automatically after a valid outline.')}</p></div><span className="shrink-0 ui-type-meta text-slate-500">Manual + Batch</span></div><div className="flex items-center justify-between gap-4 px-4 py-3.5"><div><p className="ui-type-body font-medium text-slate-800">Editorial / Originality</p><p className="mt-0.5 ui-type-meta leading-5 text-slate-400">{tr('Chỉ chạy bài đơn và luôn dừng để user duyệt outline trước draft.', 'Manual only and always pauses for outline approval before drafting.')}</p></div><span className="shrink-0 ui-type-meta text-slate-500">Manual + Approval</span></div></div>}

      <div className="space-y-5">
        {definitions.map(rule => {
          const setting = getWorkflowRuleSetting(config, rule.id);
          const hardContract = rule.id === 'quality-persistence';
          const customized = setting.enforcement !== 'strict' || !setting.appliesTo.manual || !setting.appliesTo.batch || Boolean(setting.customInstruction.trim()) || Object.keys(setting.stageOverrides).length > 0;
          const preview = compileWorkflowRules(config, rule.steps[0], 'manual');
          const promptGroups = [
            { id: 'system', label: tr('System prompt · Bắt buộc', 'System prompt · Required'), content: preview.systemPrompt },
            { id: 'guidance', label: tr('Task guidance · Hướng dẫn', 'Task guidance · Guided'), content: preview.taskGuidance },
          ].filter(group => Boolean(group.content));
          return <section key={rule.id} className="workflow-rule-group overflow-hidden rounded-xl border border-slate-200 bg-white">
            <header className="border-b border-slate-200 px-4 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-2xl"><h4 className="ui-type-title font-medium text-slate-900">{language === 'vi' ? rule.titleVi : rule.title}</h4><p className="mt-1 ui-type-meta leading-5 text-slate-400">{language === 'vi' ? rule.summaryVi : rule.summary}</p></div><div className="flex flex-wrap gap-1.5">{rule.steps.map(step => <span key={step} className="rounded-md bg-slate-100 px-2 py-1 ui-type-meta text-slate-500">{STEP_LABELS[step]}</span>)}</div></div></header>

            <div className="divide-y divide-slate-200">
              <div className="workflow-setting-row flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="ui-type-body font-medium text-slate-800">{tr('Mức áp dụng', 'Enforcement')}</p><p className="mt-0.5 ui-type-meta leading-5 text-slate-400">{hardContract ? tr('Quality Gate là safeguard bắt buộc và luôn chạy ở mức Strict.', 'Quality Gate is a required safeguard and always runs as Strict.') : tr('Strict đặt rule trong system prompt; Guided đặt rule trong task guidance.', 'Strict uses the system prompt; Guided uses task guidance.')}</p></div><AppSelect label={tr('Mức áp dụng', 'Enforcement')} value={setting.enforcement} disabled={hardContract} className="min-w-36" onValueChange={next => replaceSetting(rule.id, { enforcement: next as WorkflowRuleEnforcement })} options={[{ value: "strict", label: "Strict" }, { value: "guided", label: "Guided" }]} /></div>
              <div className="workflow-setting-row flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="ui-type-body font-medium text-slate-800">{tr('Chế độ thực thi', 'Execution modes')}</p><p className="mt-0.5 ui-type-meta leading-5 text-slate-400">{hardContract ? tr('Safeguard này luôn bảo vệ cả bài đơn và batch.', 'This safeguard always protects manual and batch runs.') : phase.id === 'orchestration' ? tr('Batch chỉ dùng cho Standard/Scalable; Editorial luôn chạy bài đơn và cần approval.', 'Batch is Standard/Scalable only; Editorial stays manual and requires approval.') : tr('Chọn nơi rule này được compiler áp dụng.', 'Choose where this rule is compiled.')}</p></div><div className="flex gap-4">{(['manual', 'batch'] as const).map(mode => <label key={mode} className="flex items-center gap-2 ui-type-body text-slate-600"><input type="checkbox" disabled={hardContract} checked={setting.appliesTo[mode]} onChange={event => replaceSetting(rule.id, { appliesTo: { ...setting.appliesTo, [mode]: event.target.checked } })} />{mode === 'manual' ? tr('Bài đơn', 'Manual') : 'Batch'}</label>)}</div></div>
              <label className="block px-4 py-3.5"><span className="ui-type-body font-medium text-slate-800">{tr('Instruction bổ sung', 'Additional instruction')}</span><span className="mt-0.5 block ui-type-body leading-5 text-slate-400">{tr('Chỉ thêm yêu cầu riêng của team; không cần chép lại rule mặc định.', 'Add only team-specific guidance; do not repeat the default rules.')}</span><textarea rows={3} value={setting.customInstruction} onChange={event => replaceSetting(rule.id, { customInstruction: event.target.value })} placeholder={tr('Không có instruction bổ sung', 'No additional instruction')} className="mt-3 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2.5 ui-type-body leading-6 outline-none" /></label>
            </div>

            <div className="border-t border-slate-200 px-4 py-2"><p className="py-2 ui-type-body font-medium text-slate-500">{tr('Quy tắc theo stage', 'Stage rules')}</p>{rule.stages.map(stage => {
              const effective = getStageEffective(rule, setting, stage); const override = setting.stageOverrides[stage.id]; const editKey = `${rule.id}:${stage.id}`; const editing = editingStage === editKey;
              return <div key={stage.id} className="workflow-stage-row border-t border-slate-200 py-3 first:border-t-0"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2"><p className="ui-type-body font-medium text-slate-800">{language === 'vi' ? stage.titleVi : stage.title}</p>{stage.locked && <span className="rounded bg-slate-100 px-1.5 py-0.5 ui-type-meta text-slate-400">{tr('Bắt buộc', 'Required')}</span>}</div><p className="mt-1 ui-type-meta leading-5 text-slate-400">{override?.instruction?.trim() || (language === 'vi' ? stage.detailVi : stage.detail)}</p></div>{!stage.locked && <button onClick={() => setEditingStage(editing ? null : editKey)} className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 ui-type-body text-slate-600">{editing ? tr('Đóng', 'Close') : override ? tr('Chỉnh sửa', 'Edit') : tr('Tuỳ chỉnh', 'Customize')}</button>}</div>
                {stage.parameters?.length ? <div className="mt-3 flex flex-wrap gap-3">{stage.parameters.map(parameter => <label key={parameter.id} className="ui-type-meta text-slate-500"><span className="mr-2">{language === 'vi' ? parameter.labelVi : parameter.label}</span><input type="number" min={parameter.min} max={parameter.max} step={parameter.step} value={Number(effective.parameters[parameter.id])} onChange={event => updateStage(rule.id, stage.id, { parameters: { ...override?.parameters, [parameter.id]: Number(event.target.value) } })} className="h-8 w-20 rounded-md border border-slate-200 bg-white px-2 ui-type-body" /></label>)}</div> : null}
                {!stage.locked && editing && <div className="mt-3"><textarea rows={3} value={override?.instruction ?? ''} onChange={event => updateStage(rule.id, stage.id, { instruction: event.target.value })} placeholder={language === 'vi' ? stage.detailVi : stage.detail} className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2.5 ui-type-body leading-6 outline-none" />{override && <button onClick={() => resetStage(rule.id, stage.id)} className="mt-2 ui-type-body text-slate-500">{tr('Khôi phục mặc định', 'Restore default')}</button>}</div>}
              </div>;
            })}</div>

            <footer className="border-t border-slate-200 bg-slate-50 px-4 py-3"><div className="flex items-center justify-between gap-3"><span className="ui-type-meta font-medium text-slate-500">{tr('Prompt đang áp dụng', 'Effective prompt')}</span>{customized && <button onClick={() => resetRule(rule.id)} className="ui-type-body text-slate-500">{tr('Reset toàn bộ rule', 'Reset rule')}</button>}</div><details className="effective-prompt mt-2 min-w-0"><summary className="cursor-pointer ui-type-meta text-slate-500">{tr('Xem nội dung prompt', 'View prompt content')}</summary><div className="mt-3 space-y-3">{promptGroups.length ? promptGroups.map(group => <section key={group.id} className="prompt-group overflow-hidden rounded-lg border border-slate-200"><div className="prompt-group-label border-b border-slate-200 px-3 py-2 ui-type-meta font-medium text-slate-600">{group.label}</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono ui-type-meta leading-6 text-slate-600">{group.content}</pre></section>) : <p className="rounded-lg border border-slate-200 px-3 py-3 ui-type-meta text-slate-500">{tr('Rule không áp dụng cho chế độ này.', 'Rule is not active in this mode.')}</p>}</div></details></footer>
          </section>;
        })}
      </div>
    </section>
  </div>;
}
