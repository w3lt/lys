import type { ReactElement } from "react"
import { LLM_PROVIDER_NAMES, type LlmModelReference } from "@lys/share"

import { formatTokenCount } from "@/lib/models/model-load-configuration"

/** Properties accepted by {@link ModelDefaultSummary}. */
export type ModelDefaultSummaryProps = {
  /** The session's default model, or null when none is chosen. */
  readonly defaultModel: LlmModelReference | null
  /**
   * Whether the default model's provider is on, so the pane can show the
   * model; false without a default.
   */
  readonly isProviderOn: boolean
  /**
   * Context length the default model is shown with, or null when its
   * provider does not list it now.
   */
  readonly contextLength: number | null
  /** Requests that the Model pane show the default model; once per press. */
  readonly onSelectDefaultModel: () => void
}

/**
 * Formats the line under the default model's key.
 *
 * @param providerName - Name of the default model's provider.
 * @param isProviderOn - Whether that provider is on.
 * @param contextLength - Context length the model is shown with, or null.
 * @returns That the provider is off; else the provider's name, with the
 * context length when it is known.
 */
function formatDefaultModelLine(
  providerName: string,
  isProviderOn: boolean,
  contextLength: number | null
): string {
  if (!isProviderOn) return `${providerName} is off`
  return contextLength === null
    ? providerName
    : `${providerName} · ${formatTokenCount(contextLength)} context`
}

/**
 * Names the session's default model at the top of the Model pane.
 *
 * @remarks While the model's provider is on, its key is a
 * button that shows its details, titled to say so; while the provider is
 * off, the pane cannot show the model, so the key is plain text and the
 * line under it says the provider is off. Otherwise that line names the
 * provider and, when known, the context length. Without a default, it says
 * none is chosen.
 * @param props - Default model, whether its provider is on, its context
 * length, and the request.
 * @returns The summary.
 */
export default function ModelDefaultSummary({
  defaultModel,
  isProviderOn,
  contextLength,
  onSelectDefaultModel
}: ModelDefaultSummaryProps): ReactElement {
  if (defaultModel === null) {
    return (
      <div className="settings-view__models-default">
        <p className="settings-view__models-eyebrow">
          Default for this session
        </p>
        <p className="settings-view__models-note">None chosen yet.</p>
      </div>
    )
  }
  const providerName = LLM_PROVIDER_NAMES[defaultModel.provider]
  return (
    <div className="settings-view__models-default">
      <p className="settings-view__models-eyebrow">Default for this session</p>
      {isProviderOn ? (
        <button
          className="settings-view__models-default-key"
          onClick={onSelectDefaultModel}
          title="Show its details"
          type="button"
        >
          {defaultModel.modelKey}
        </button>
      ) : (
        <span className="settings-view__models-default-key settings-view__models-default-key--text">
          {defaultModel.modelKey}
        </span>
      )}
      <span className="settings-view__models-note">
        {formatDefaultModelLine(providerName, isProviderOn, contextLength)}
      </span>
    </div>
  )
}
