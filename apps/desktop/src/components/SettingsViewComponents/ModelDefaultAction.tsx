import { useRef, type ReactElement } from "react"
import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"

import type { ModelDefaultChoice } from "./model-pane-presentation"

/** Properties accepted by {@link ModelDefaultAction}. */
export type ModelDefaultActionProps = {
  /** What the footer offers for the selected model. */
  readonly choice: ModelDefaultChoice
  /**
   * Whether the offered action is disabled: always while the model loads,
   * when Loading… stands in for it.
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
 * @remarks Owns whether a press of its button awaits
 * the mark that replaces it. For the default itself it states so with a
 * check instead of a button; while the model loads, the button reads
 * Loading… and is disabled. When the model becomes the default after a
 * press, the mark replaces the button and takes focus, unless focus moved
 * elsewhere meanwhile, so focus does not fall back to the document. The
 * note says what the default does or why the model must be loaded first.
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
  const isMarkFocusPendingRef = useRef(false)

  /** Asks for the offered action, whose success replaces the button. */
  function handleDefaultClick(): void {
    isMarkFocusPendingRef.current = true
    if (choice === "set") onSetDefaultModel()
    else onLoadDefaultModel()
  }

  /**
   * Gives focus to the mark when it replaced a pressed button that held it.
   *
   * @param mark - The attached mark, or null when it detaches.
   */
  function handleCurrentMarkAttach(mark: HTMLSpanElement | null): void {
    if (mark === null || !isMarkFocusPendingRef.current) return
    isMarkFocusPendingRef.current = false
    const { activeElement, body } = mark.ownerDocument
    if (activeElement === null || activeElement === body) mark.focus()
  }

  return (
    <div className="settings-view__models-footer">
      <p className="settings-view__models-note">
        {formatModelDefaultNote(choice)}
      </p>
      {choice === "current" ? (
        <span
          className="settings-view__models-current"
          ref={handleCurrentMarkAttach}
          tabIndex={-1}
        >
          <Check aria-hidden="true" />
          Default for new conversations
        </span>
      ) : (
        <Button
          disabled={isDisabled}
          onClick={handleDefaultClick}
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
