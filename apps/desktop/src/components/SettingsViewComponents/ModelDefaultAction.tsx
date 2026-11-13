import type { ReactElement } from "react"
import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"

import type { ModelDefaultChoice } from "./model-pane-presentation"

/** Properties accepted by {@link ModelDefaultAction}. */
export type ModelDefaultActionProps = {
  /** What the footer offers for the selected model. */
  readonly choice: ModelDefaultChoice
  /**
   * Whether the offered action is disabled, as Load and set as default is
   * while another request of the provider runs.
   */
  readonly isDisabled: boolean
  /** Requests that the model become the default; once per press. */
  readonly onSetDefaultModel: () => void
  /**
   * Requests that the model be loaded and, once loaded, become the default;
   * once per press.
   */
  readonly onLoadDefaultModel: () => void
}

/**
 * Formats the footer note for what it offers.
 *
 * @param choice - What the footer offers.
 * @returns That only loaded models answer, for a model that must be loaded
 * first; otherwise what the default does.
 */
function formatModelDefaultNote(choice: ModelDefaultChoice): string {
  return choice === "load-and-set" || choice === "loading"
    ? "Only loaded models can answer. Load it to make it the default."
    : "The default answers new conversations and lasts for this session."
}

/**
 * Offers to make the selected model the session's default.
 *
 * @remarks Presentational. For the default itself it states so with a
 * check instead of a button; while the model loads, a disabled Loading…
 * button stands in for the action. The note says what the default does or
 * why the model must be loaded first.
 * @param props - What is offered, whether it is disabled, and the two
 * requests.
 * @returns The footer.
 */
export default function ModelDefaultAction({
  choice,
  isDisabled,
  onSetDefaultModel,
  onLoadDefaultModel
}: ModelDefaultActionProps): ReactElement {
  return (
    <div className="settings-view__models-footer">
      <p className="settings-view__models-note">
        {formatModelDefaultNote(choice)}
      </p>
      {choice === "current" ? (
        <span className="settings-view__models-current">
          <Check aria-hidden="true" />
          Default for new conversations
        </span>
      ) : (
        <Button
          disabled={isDisabled || choice === "loading"}
          onClick={choice === "set" ? onSetDefaultModel : onLoadDefaultModel}
          type="button"
        >
          {formatModelDefaultLabel(choice)}
        </Button>
      )}
    </div>
  )
}

/**
 * Formats the footer button's label.
 *
 * @param choice - What the footer offers, other than the current default.
 * @returns The action's name, or Loading… while the model loads.
 */
function formatModelDefaultLabel(
  choice: Exclude<ModelDefaultChoice, "current">
): string {
  switch (choice) {
    case "set":
      return "Set as default"
    case "load-and-set":
      return "Load and set as default"
    case "loading":
      return "Loading…"
  }
}
