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

/** Properties accepted by {@link StarterPromptButton}. */
type StarterPromptButtonProps = {
  /** Text of the prompt, shown on the button and sent when it is clicked. */
  readonly prompt: string
  /** Requests that the parent send the prompt as a message. */
  readonly onSendStarterPrompt: (prompt: string) => void
}

/**
 * Presents one starter prompt as a button that asks to send it.
 *
 * @remarks The parent owns submission; the
 * component owns no state. `onSendStarterPrompt` fires once per click with
 * the button's prompt. The trailing arrow is hidden from assistive technology.
 * @param props - The prompt and the parent callback.
 * @returns The prompt's button.
 */
function StarterPromptButton({
  prompt,
  onSendStarterPrompt
}: StarterPromptButtonProps): ReactElement {
  return (
    <Button
      className="chat-view__starter"
      onClick={() => onSendStarterPrompt(prompt)}
      size="lg"
      type="button"
      variant="outline"
    >
      <span>{prompt}</span>
      <ArrowRight aria-hidden="true" />
    </Button>
  )
}

/**
 * Presents the empty-session introduction and its starter prompts.
 *
 * @remarks The parent owns prompt
 * submission and request lifecycle; this component owns no state, effects, or
 * resources. Each prompt is rendered as an accessible button in source order,
 * inside a group named Starter prompts, and `onSendStarterPrompt` fires once
 * per click with that button's prompt.
 * The framed portrait is decorative and hidden from assistive technology.
 * The view plays one entrance sequence when it mounts; a reduced-motion
 * preference removes it.
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
      <fieldset aria-label="Starter prompts" className="chat-view__starters">
        <div className="chat-view__starter-stack">
          {STARTER_PROMPTS.map((prompt) => (
            <StarterPromptButton
              key={prompt}
              onSendStarterPrompt={onSendStarterPrompt}
              prompt={prompt}
            />
          ))}
        </div>
      </fieldset>
    </div>
  )
}
