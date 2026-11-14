import type { ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"

import { splitModelKey } from "./model-pane-presentation"

/** Display-ready facts of one row of the Model pane's model list. */
export type ModelListEntry = {
  /** Model the row represents. */
  readonly model: LlmInfo
  /** Value of the list's right column for the model: its size or context. */
  readonly columnValue: string
  /** Whether the Model pane shows the model's details. */
  readonly isSelected: boolean
  /** Whether the model is the session's default. */
  readonly isDefault: boolean
  /** Whether the model is being loaded. */
  readonly isLoading: boolean
}

/** Properties accepted by {@link ModelRow}. */
export type ModelRowProps = {
  /** The row's model, column value, and states, from the list owner. */
  readonly entry: ModelListEntry
  /**
   * Requests that the Model pane show this model, called once per press.
   *
   * @param modelKey - Key of the row's model.
   */
  readonly onSelectModel: (modelKey: string) => void
}

/**
 * Presents one model of the Model pane's list as a button that selects it.
 *
 * @remarks The key's namespace and tag are quieter than its
 * name. Default and loading are stated in words, the selected row is marked
 * with `aria-current`, and the right column's value ends the row, so no
 * state depends on colour alone.
 * @param props - The row's entry and the selection request.
 * @returns The list item holding the row's button.
 */
export default function ModelRow({
  entry,
  onSelectModel
}: ModelRowProps): ReactElement {
  const { model, isSelected, isDefault, isLoading } = entry
  const { prefix, base, tag } = splitModelKey(model.modelKey)
  return (
    <li>
      <button
        aria-current={isSelected ? "true" : undefined}
        className="settings-view__models-row"
        onClick={() => onSelectModel(model.modelKey)}
        type="button"
      >
        <span className="settings-view__models-key">
          <span>{prefix}</span>
          {base}
          <span>{tag}</span>
        </span>
        {isDefault ? (
          <span className="settings-view__models-chip">Default</span>
        ) : null}
        {isLoading ? (
          <span className="settings-view__models-loading">
            <span
              aria-hidden="true"
              className="settings-view__status-dot settings-view__status-dot--small"
              data-tone="pending"
            />
            Loading…
          </span>
        ) : null}
        <span className="settings-view__models-column">
          {entry.columnValue}
        </span>
      </button>
    </li>
  )
}
