import { STARTER_PROMPTS } from "@/app/content"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"

/** Properties accepted by {@link StarterView}. */
interface StarterViewProps {
  /** Receives the selected starter prompt when its button is clicked. */
  onSend: (prompt: string) => void
}

/**
 * Presents the empty-session starter prompts.
 *
 * @remarks The parent owns prompt
 * submission and request lifecycle; this component owns no state, effects, or
 * resources. Each prompt is rendered as an accessible button in source order,
 * and its callback fires once from that button's click handler. Decorative
 * branding is hidden from assistive technology.
 * @param props - Parent callback receiving the selected prompt text.
 * @returns The empty-session heading, explanation, and starter controls.
 */
export default function StarterView({ onSend }: StarterViewProps) {
  return (
    <div className="chat-view__empty">
      <div aria-hidden="true" className="chat-view__mark">
        <span className="chat-view__mark-dot" />
      </div>
      <h1>Lys</h1>
      <p className="chat-view__eyebrow">Lysiptera Caliginia</p>
      <p className="chat-view__subtitle">
        One model. One conversation. Nothing leaves this machine.
      </p>
      <p className="chat-view__session-note">
        This conversation exists for this session only.
      </p>
      <div className="chat-view__starters" aria-label="Starter prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <Button
            className="chat-view__starter"
            key={prompt}
            onClick={() => onSend(prompt)}
            size="lg"
            variant="outline"
          >
            <span>{prompt}</span>
            <ArrowRight aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  )
}
