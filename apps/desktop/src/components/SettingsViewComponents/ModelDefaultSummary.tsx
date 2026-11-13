import type { ReactElement } from "react"
import { LLM_PROVIDER_NAMES, type LlmModelReference } from "@lys/share"

import { formatTokenCount } from "@/lib/models/model-load-configuration"

/** Properties accepted by {@link ModelDefaultSummary}. */
export type ModelDefaultSummaryProps = {
  /** The session's default model, or null when none is chosen. */
  readonly defaultModel: LlmModelReference | null
  /**
   * Context length the default model is shown with, or null when its
   * provider does not list it now.
   */
  readonly contextLength: number | null
  /** Requests that the Model pane show the default model; once per press. */
  readonly onSelectDefaultModel: () => void
}

/**
 * Names the session's default model at the top of the Model pane.
 *
 * @remarks Presentational. The model's key is a button that shows its
 * details, titled to say so; under it, its provider and, when known, its
 * context length. Without a default, it says none is chosen.
 * @param props - Default model, its context length, and the request.
 * @returns The summary.
 */
export default function ModelDefaultSummary({
  defaultModel,
  contextLength,
  onSelectDefaultModel
}: ModelDefaultSummaryProps): ReactElement {
  const providerName =
    defaultModel === null ? null : LLM_PROVIDER_NAMES[defaultModel.provider]
  return (
    <div className="settings-view__models-default">
      <p className="settings-view__models-eyebrow">Default for this session</p>
      {defaultModel === null ? (
        <p className="settings-view__models-note">None chosen yet.</p>
      ) : (
        <>
          <button
            className="settings-view__models-default-key"
            onClick={onSelectDefaultModel}
            title="Show its details"
            type="button"
          >
            {defaultModel.modelKey}
          </button>
          <span className="settings-view__models-note">
            {contextLength === null
              ? providerName
              : `${providerName} · ${formatTokenCount(contextLength)} context`}
          </span>
        </>
      )}
    </div>
  )
}
