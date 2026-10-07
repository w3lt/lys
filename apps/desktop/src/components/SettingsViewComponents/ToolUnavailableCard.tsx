import { WrenchOff } from "lucide-react"
import { useId, type ReactElement } from "react"

/** Properties accepted by {@link ToolUnavailableCard}. */
export type ToolUnavailableCardProps = {
  /** Key of the loaded model, which was not trained to call tools. */
  readonly modelKey: string
}

/**
 * Explains that the loaded model was not trained to call tools, so Lys offers
 * it none.
 *
 * @remarks The parent shows the card only while such a model is loaded and
 * locks the tool controls below it; the card owns no state, effects, or
 * actions. It is a region named by its heading; the icon is decorative.
 * @param props - Key of the loaded model.
 * @returns The tool-calls-unavailable card.
 */
export function ToolUnavailableCard({
  modelKey
}: ToolUnavailableCardProps): ReactElement {
  const headingId = useId()

  return (
    <section
      aria-labelledby={headingId}
      className="settings-view__tool-unavailable"
    >
      <span aria-hidden="true" className="settings-view__tool-unavailable-icon">
        <WrenchOff />
      </span>
      <div className="settings-view__tool-unavailable-lines">
        <p className="settings-view__tool-unavailable-eyebrow">
          tool calls unavailable
        </p>
        <h2 id={headingId}>The current model isn't trained for tool calls</h2>
        <p>
          <span className="settings-view__tool-model">{modelKey}</span> wasn't
          trained to call tools, so Lys doesn't offer it any. Your choices are
          kept and apply once you load weights that were.
        </p>
      </div>
    </section>
  )
}
