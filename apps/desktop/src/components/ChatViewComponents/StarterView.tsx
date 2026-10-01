import type { ReactElement } from "react"

import { STARTER_PROMPTS } from "@/app/content"
import lysDarkPortrait from "@/assets/avatars/lys_dark.png"
import lysLightPortrait from "@/assets/avatars/lys_light.png"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"

/** Properties accepted by {@link StarterView}. */
type StarterViewProps = {
  /** Requests that the parent send the clicked starter prompt as a message. */
  readonly onSendStarterPrompt: (prompt: string) => void
}

/**
 * Presents Lys's portrait in its gradient frame.
 *
 * @remarks The portrait repeats the adjacent
 * "Lys" heading, so it is hidden from assistive technology and contains no
 * focusable content. The application's root theme class selects the light or
 * dark portrait. The component owns no state, effects, or resources.
 * @returns The decorative framed portrait.
 */
function StarterPortrait(): ReactElement {
  return (
    <div aria-hidden="true" className="chat-view__portrait">
      <img
        alt=""
        className="chat-view__portrait-image dark:hidden"
        src={lysLightPortrait}
      />
      <img
        alt=""
        className="chat-view__portrait-image hidden dark:block"
        src={lysDarkPortrait}
      />
    </div>
  )
}

/**
 * Presents the empty-session introduction and its starter prompts.
 *
 * @remarks The parent owns prompt
 * submission and request lifecycle; this component owns no state, effects, or
 * resources. Each prompt is rendered as an accessible button in source order,
 * and `onSendStarterPrompt` fires once per click with that button's prompt.
 * The framed portrait and the gem divider are decorative and hidden from
 * assistive technology. The view plays one entrance sequence when it mounts;
 * a reduced-motion preference removes it.
 * @param props - Parent callback receiving the selected prompt text.
 * @returns The empty-session portrait, heading, explanation, and starter controls.
 */
export default function StarterView({
  onSendStarterPrompt
}: StarterViewProps): ReactElement {
  return (
    <div className="chat-view__empty">
      <StarterPortrait />
      <h1>Lys</h1>
      <p className="chat-view__eyebrow">Lysiptera Caliginia</p>
      <p className="chat-view__subtitle">
        One model, one conversation at a time. The transcripts stay on this
        machine.
      </p>
      <div className="chat-view__starters" aria-label="Starter prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <Button
            className="chat-view__starter lys-wingline"
            data-lys-wingline="primary"
            key={prompt}
            onClick={() => onSendStarterPrompt(prompt)}
            size="lg"
            type="button"
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
