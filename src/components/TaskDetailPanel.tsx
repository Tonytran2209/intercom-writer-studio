import { useEffect, useId, useRef, type ReactNode } from "react"
import { X } from "lucide-react"
import { LightButton } from "twenty-ui/components/input"

export default function TaskDetailPanel({
  title, badge, onClose, closeLabel = "Close task details", actions, subtitle,
  footer, className = "", fixed = false, children,
}: {
  title: string
  badge: ReactNode
  onClose: () => void
  closeLabel?: string
  actions?: ReactNode
  subtitle?: ReactNode
  footer?: ReactNode
  className?: string
  fixed?: boolean
  children: ReactNode
}) {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const trigger = document.activeElement
    closeButton.current?.focus()
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected && document.activeElement === document.body) trigger.focus()
    }
  }, [])

  return (
    <div className={`eb-overlay eb-task-inspector inset-0 flex justify-end p-2 sm:p-3 ${fixed ? "fixed z-[100]" : "absolute z-50"}`}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`eb-detail-panel eb-task-inspector-panel flex h-full w-full min-w-0 flex-col overflow-hidden border ${className}`}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return
          if (event.key === "Escape") { event.stopPropagation(); onClose() }
          if (event.key !== "Tab") return
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary',
          )).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0)
          const first = controls[0], last = controls.at(-1)
          if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus() }
        }}>
        <header className="eb-inspector-header shrink-0 border-b px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="eb-inspector-gate min-w-0 truncate ui-type-meta font-medium">{badge}</div>
            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <LightButton ref={closeButton} type="button" size="sm" variant="ghost" aria-label={closeLabel}
                onClick={onClose} className="min-h-8 min-w-8" startIcon={<X size={16} aria-hidden="true" />} />
            </div>
          </div>
          <h2 id={titleId} className="mt-4 max-w-[min(26rem,calc(100%_-_1rem))] ui-type-page font-semibold text-pretty [overflow-wrap:anywhere]">
            {title}
          </h2>
          {subtitle && <div className="mt-2 ui-type-meta text-slate-500 [overflow-wrap:anywhere]">{subtitle}</div>}
        </header>
        {children}
        {footer && <footer className="eb-inspector-footer flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 sm:px-5">{footer}</footer>}
      </aside>
    </div>
  )
}
