import { ArrowRight, Check, CheckCircle2, ClipboardCheck, FileText, Lightbulb, Send, Sparkles } from "lucide-react"
import { useState } from "react"

type Gate = 0 | 1 | 2 | 3

const article = `> “The best learning habits are the ones people actually want to share.”

# Keep It, Share It, Use It

At F.Learning, a useful idea is rarely left in one person's notebook. The team turns small, practical discoveries into something the next person can actually use.

## Why keeping knowledge matters

When a project moves quickly, the useful context is often the first thing to disappear. We make time to capture the what, why and next step—before the detail gets lost.

## How we make it shareable

Short notes, clear examples and the occasional “this saved me twenty minutes” message make knowledge easier to pass on. No encyclopaedia required.

## Are you one of us?

If you enjoy turning a messy insight into a clearer way of working, you will probably feel at home here.`

export default function EbWorkingSpace() {
  const [raw, setRaw] = useState("")
  const [gate, setGate] = useState<Gate>(0)
  const [approved, setApproved] = useState<Gate>(0)
  const hasInput = raw.trim().length > 12
  const approve = (value: Gate) => { setApproved(value); setGate(Math.min(3, value + 1) as Gate) }
  return <main className="continuous-workspace flex-1 min-h-0 overflow-y-auto bg-[#171717] p-4 md:p-7">
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-col gap-4 border-b border-[#303030] pb-5 sm:flex-row sm:items-start sm:justify-between"><div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-violet-300"><Sparkles className="h-4 w-4"/> EB writing skill <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">Shell mode</span></div><h1 className="text-2xl font-semibold tracking-tight text-white">New Employer Brand package</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#a5a5a5]">Turn a real workplace moment into a fab.careers article and channel-ready social copy—one approval gate at a time.</p></div><button className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#454545] px-3 py-2 text-sm text-[#e4e4e4] hover:bg-[#292929]"><Lightbulb className="h-4 w-4"/> Discovery mode</button></header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_250px]">
        <div className="space-y-5">
          <section className={`rounded-xl border p-5 ${gate === 0 ? "border-violet-400/50 bg-[#222021]" : "border-[#343434] bg-[#202020]"}`}><div className="flex items-start gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-500 text-xs font-bold text-white">0</span><div className="min-w-0 flex-1"><h2 className="text-base font-semibold text-white">Raw moment & input check</h2><p className="mt-1 text-sm text-[#a6a6a6]">Paste notes, an event recap or a teammate story. The skill keeps every detail traceable.</p><textarea value={raw} onChange={event => setRaw(event.target.value)} placeholder="Example: During our Friday sharing session, Mai showed the team how she turns scattered client feedback into a one-page visual brief…" rows={6} className="mt-4 w-full resize-y rounded-lg border border-[#454545] bg-[#171717] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-[#6f6f6f] focus:border-violet-400"/>{gate === 0 && <div className="mt-4 flex items-center justify-between gap-3"><span className={`text-xs ${hasInput ? "text-emerald-300" : "text-[#888]"}`}>{hasInput ? "Ready to simulate the 11-point input check" : "Add a real moment to continue"}</span><button disabled={!hasInput} onClick={() => setGate(1)} className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">Analyze story <ArrowRight className="h-4 w-4"/></button></div>}</div></div></section>

          {gate >= 1 && <section className={`rounded-xl border p-5 ${gate === 1 ? "border-violet-400/50 bg-[#222021]" : "border-[#343434] bg-[#202020]"}`}><GateHeading number="1" title="Brief approval" status={approved >= 1 ? "Approved" : "Needs your review"}/><div className="mt-4 grid gap-3 sm:grid-cols-2"><Info label="Theme" value="Learning clarity, shared through a real team habit"/><Info label="Article type" value="C1 · Knowledge of F / Learning practice"/><Info label="Primary pillar" value="Analytical & Clarity-driven"/><Info label="Persona fit" value="L&D Executive · AI Engineer"/><Info label="Facebook form" value="Reflective · no active hiring CTA"/><Info label="Evidence" value="1 raw source · 2 details to confirm"/></div>{gate === 1 && <GateActions onApprove={() => approve(1)} label="Approve brief & draft article"/>}</section>}

          {gate >= 2 && <section className={`rounded-xl border p-5 ${gate === 2 ? "border-violet-400/50 bg-[#222021]" : "border-[#343434] bg-[#202020]"}`}><GateHeading number="2" title="fab.careers article" status={approved >= 2 ? "Approved" : "Review draft"}/><article className="mt-4 whitespace-pre-wrap rounded-lg border border-[#3a3a3a] bg-[#181818] p-5 font-serif text-[15px] leading-7 text-[#dedede]">{article}</article>{gate === 2 && <GateActions onApprove={() => approve(2)} label="Approve article & adapt channels"/>}</section>}

          {gate >= 3 && <section className="rounded-xl border border-violet-400/50 bg-[#222021] p-5"><GateHeading number="3" title="Social package & repetition check" status={approved >= 3 ? "Approved for publishing" : "Final review"}/><div className="mt-4 grid gap-3 md:grid-cols-3"><Channel title="Threads A · VN" text="Một ý hay không nên nằm yên trong một cuốn sổ. Ở F., tụi mình biến mớ feedback rối thành thứ người tiếp theo có thể dùng ngay ✨"/><Channel title="Facebook · VN / EN" text="Những điều nhỏ được ghi lại, chia sẻ và dùng tiếp—đó là cách một team học cùng nhau."/><Channel title="LinkedIn · EN" text="A learning culture is not measured by how much a company knows, but by how easily useful context can move."/></div><div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">Repetition check: Type C1 is clear of the most recent Type B pattern. Primary pillar changes from the recent Energetic & Spirited run.</div>{approved < 3 && <GateActions onApprove={() => { setApproved(3); setGate(3) }} label="Approve package & add to publishing log"/>}</section>}
        </div>
        <aside className="h-fit rounded-xl border border-[#353535] bg-[#202020] p-4"><h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#8f8f8f]">Workflow</h2><ol className="mt-4 space-y-4">{([{ step: 0, label: "Input check" }, { step: 1, label: "Brief" }, { step: 2, label: "Website article" }, { step: 3, label: "Social & log" }] as const).map(({ step, label }) => <li key={String(step)} className="flex items-center gap-3"><span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${approved >= step ? "bg-emerald-500 text-[#152015]" : gate === step ? "bg-violet-500 text-white" : "bg-[#343434] text-[#888]"}`}>{approved >= step ? <Check className="h-3.5 w-3.5"/> : step}</span><span className={`text-sm ${gate === step ? "text-white" : "text-[#a0a0a0]"}`}>{label}</span></li>)}</ol><div className="mt-6 border-t border-[#363636] pt-4 text-xs leading-5 text-[#929292]">Every approved output keeps a snapshot of its pillar, persona, rules and source evidence when V2 persistence is added.</div></aside>
      </div>
    </div>
  </main>
}

function GateHeading({ number, title, status }: { number: string; title: string; status: string }) { return <div className="flex items-center gap-3"><span className="grid h-7 w-7 place-items-center rounded-full bg-violet-500 text-xs font-bold text-white">{number}</span><div><h2 className="text-base font-semibold text-white">{title}</h2><p className="text-xs text-[#a3a3a3]">{status}</p></div></div> }
function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-[#3b3b3b] bg-[#191919] p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-[#8e8e8e]">{label}</p><p className="mt-1 text-sm leading-5 text-[#dedede]">{value}</p></div> }
function Channel({ title, text }: { title: string; text: string }) { return <section className="rounded-lg border border-[#3a3a3a] bg-[#191919] p-3"><h3 className="text-xs font-semibold text-violet-200">{title}</h3><p className="mt-2 text-xs leading-5 text-[#d0d0d0]">{text}</p></section> }
function GateActions({ onApprove, label }: { onApprove: () => void; label: string }) { return <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-[#3b3b3b] pt-4"><button className="rounded-lg border border-[#4a4a4a] px-3 py-2 text-sm text-[#dedede] hover:bg-[#2b2b2b]">Request edits</button><button onClick={onApprove} className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3 py-2 text-sm font-medium text-white hover:bg-violet-400"><CheckCircle2 className="h-4 w-4"/>{label}</button></div> }
