import { useId, type ReactElement, type ReactNode } from "react"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/** Properties accepted by {@link SettingsPanelField}. */
export type SettingsPanelFieldProps = {
  /** Label of the field. */
  readonly label: string
  /** Whether the label marks the field optional. */
  readonly isOptional: boolean
  /** Line under the field that says what it is used for. */
  readonly help: ReactNode
  /** Text in the field. */
  readonly value: string
  /** Text shown while the field is empty, or undefined for none. */
  readonly placeholder?: string
  /** Rows of a multi-line field, or null for a one-line field. */
  readonly rows: number | null
  /** Proposes new text for the field. */
  readonly onValueChange: (value: string) => void
}

/**
 * Presents one labelled text field of a settings panel with the line that
 * says what it is used for.
 *
 * @remarks The parent owns the text; the field owns no state. The input is
 * named by its label and described by the help line.
 * @param props - Label, help, text, rows, and the change proposal.
 * @returns The field.
 */
export default function SettingsPanelField({
  label,
  isOptional,
  help,
  value,
  placeholder,
  rows,
  onValueChange
}: SettingsPanelFieldProps): ReactElement {
  const fieldId = useId()
  const helpId = `${fieldId}-help`

  return (
    <div
      className="settings-view__panel-field"
      data-wide={rows === null ? undefined : ""}
    >
      <label htmlFor={fieldId}>
        {label}
        {isOptional ? (
          <span className="settings-view__optional"> · optional</span>
        ) : null}
      </label>
      {rows === null ? (
        <Input
          aria-describedby={helpId}
          id={fieldId}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          type="text"
          value={value}
        />
      ) : (
        <Textarea
          aria-describedby={helpId}
          id={fieldId}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          rows={rows}
          value={value}
        />
      )}
      <p className="settings-view__panel-help" id={helpId}>
        {help}
      </p>
    </div>
  )
}
