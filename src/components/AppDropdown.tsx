import { useState } from "react"
import type { ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import { LightButton } from "twenty-ui/components/input"
import { Select } from "twenty-ui/primitives/input"
import { Popover } from "twenty-ui/primitives/surfaces"

type DropdownOption = { value: string; label: string; disabled?: boolean }

const dropdownChevron = <ChevronDown size={13} aria-hidden="true" />

export function AppSelect({
  label, value, options, onValueChange, disabled, className, icon, title, wide,
}: {
  label: string
  value: string
  options: readonly DropdownOption[]
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
  icon?: ReactNode
  title?: string
  wide?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Select.Root items={options} value={value} disabled={disabled} modal={false} open={open} onOpenChange={setOpen}
      onValueChange={next => { if (next !== null) onValueChange(next) }}>
      <Select.Trigger size="sm" aria-label={label} title={title} className={`app-dropdown-trigger ${className ?? ""}`}
        render={<LightButton type="button" size="sm" variant={open ? "soft" : "ghost"}
          startIcon={icon} endIcon={dropdownChevron} />}>
        <Select.Value className="app-dropdown-value ui-type-body" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="start" sideOffset={6} collisionPadding={8} alignItemWithTrigger={false}>
          <Select.Popup className={`app-dropdown-popup app-dropdown-select ${wide ? "app-dropdown-wide" : ""}`}
            onClick={event => event.stopPropagation()}>
            <Select.List aria-label={label}>
              {options.map(option => (
                <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="app-dropdown-option">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

export function AppDropdown({
  label, panelLabel = label, icon, iconOnly, className, wide, align = "start", side = "bottom",
  open: controlledOpen, onOpenChange, children,
}: {
  label: string
  panelLabel?: string
  icon?: ReactNode
  iconOnly?: boolean
  className?: string
  wide?: boolean
  align?: "start" | "end"
  side?: "top" | "bottom"
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  return (
    <Popover.Root modal={false} open={open} onOpenChange={onOpenChange ?? setLocalOpen}>
      <Popover.Trigger render={<LightButton type="button" size="sm" variant={open ? "soft" : "ghost"}
        className={`app-dropdown-trigger ${className ?? ""}`}
        aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined}
        startIcon={icon} endIcon={iconOnly ? undefined : dropdownChevron} />}>
        {iconOnly ? undefined : <span className="app-dropdown-value ui-type-body">{label}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align={align} sideOffset={6} collisionPadding={8}>
          <Popover.Popup aria-label={panelLabel} className={`app-dropdown-popup ${wide ? "app-dropdown-wide" : ""}`}
            onClick={event => event.stopPropagation()}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
