import { STARTER_PROMPTS } from "@/app/content"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"

interface StarterViewProps {
  onSend: (prompt: string) => void
}

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
