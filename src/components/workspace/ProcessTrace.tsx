import type { ReactNode } from "react";
import TaskDetailPanel from "../TaskDetailPanel";
import { createPortal } from "react-dom";
import type { AIProcessTraceEvent } from "../../types";
import { useI18n } from "../../lib/i18n";

export default function ProcessTrace({ events }: { events?: AIProcessTraceEvent[] }) {
  const { tr } = useI18n();
  if (!events?.length) return <p className="text-xs text-slate-400">{tr("Chưa có nhật ký. Hãy tạo lại kết quả.", "No log yet. Regenerate the result.")}</p>;
  return <div className="ai-log-timeline overflow-hidden rounded-xl border border-slate-200">{events.map((event, index) => <article key={event.id} className="ai-log-event border-b border-slate-200 p-3.5 last:border-b-0"><div className="flex items-start gap-3"><span className={`ai-log-step is-${event.status} flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold`}>{index + 1}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h4 className="text-[11px] font-medium text-slate-800">{event.title}</h4><span className="rounded-full border border-slate-200 px-2 py-0.5 text-[8px] font-medium uppercase tracking-wider text-slate-400">{event.stage}</span></div><p className="mt-1.5 whitespace-pre-wrap text-[10px] leading-relaxed text-slate-500">{event.detail}</p>{event.facts && <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(event.facts).map(([key, value]) => <span key={key} className="ai-log-fact rounded-md border border-slate-200 px-2 py-1 text-[9px] text-slate-500"><b className="font-medium text-slate-700">{key}:</b> {String(value ?? "n/a")}</span>)}</div>}{(event.sources?.length ?? 0) > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{event.sources?.map((url, sourceIndex) => <a key={`${url}-${sourceIndex}`} href={url} target="_blank" rel="noreferrer" className="ai-log-source rounded-md px-2 py-1 text-[9px] font-medium">Source {sourceIndex + 1}</a>)}</div>}</div></div></article>)}</div>;
}

export function ProcessTraceModal({ title, events, onClose, children }: { title: string; events?: AIProcessTraceEvent[]; onClose: () => void; children?: ReactNode }) {
  const { tr } = useI18n();
  return createPortal(
    <TaskDetailPanel fixed title={title} badge={tr("Nhật ký AI", "AI log")} onClose={onClose} closeLabel={tr("Đóng", "Close")}>
      <div className="eb-task-inspector-content ai-log-content min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        <ProcessTrace events={events} />
        {children}
      </div>
    </TaskDetailPanel>, document.body);
}
