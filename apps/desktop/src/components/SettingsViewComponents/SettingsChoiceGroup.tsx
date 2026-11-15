import type { ReactElement } from "react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/** One choice of a {@link SettingsChoiceGroup}. */
export type SettingsChoice<TValue extends string> = {
  /** Value the choice stands for. */
  readonly value: TValue
  /** Text of the choice. */
  readonly label: string
}

/** Properties accepted by {@link SettingsChoiceGroup}. */
export type SettingsChoiceGroupProps<TValue extends string> = {
  /** Identifier of the element that names the group. */
  readonly labelId: string
  /** The choices, in order. */
  readonly choices: readonly SettingsChoice<TValue>[]
  /** Value chosen now. */
  readonly value: TValue
  /** Whether every choice is disabled. */
  readonly disabled: boolean
  /** Proposes another choice. */
  readonly onValueChange: (value: TValue) => void
}

/**
 * Presents one choice among a few as a row of pressed and unpressed
 * buttons.
 *
 * @remarks The parent owns the value; the group owns no state. Pressing the
 * chosen button again keeps it chosen: the group reports no empty choice.
 * @param props - The label, the choices, the value, and the proposal.
 * @returns The group.
 */
export default function SettingsChoiceGroup<TValue extends string>({
  labelId,
  choices,
  value,
  disabled,
  onValueChange
}: SettingsChoiceGroupProps<TValue>): ReactElement {
  /**
   * Proposes the choice the toggle group pressed, ignoring an unpress.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleGroupValueChange(groupValue: string[]): void {
    const chosen = choices.find((choice) => groupValue.includes(choice.value))
    if (chosen !== undefined) onValueChange(chosen.value)
  }

  return (
    <ToggleGroup
      aria-labelledby={labelId}
      className="settings-view__choices"
      disabled={disabled}
      onValueChange={handleGroupValueChange}
      size="sm"
      value={[value]}
      variant="outline"
    >
      {choices.map((choice) => (
        <ToggleGroupItem key={choice.value} value={choice.value}>
          {choice.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
