import type { BuiltInAgent } from "@lys/share"
import { ChevronLeft } from "lucide-react"
import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useLysStore } from "@/lib/store"

import { formatAgentPromptMeasure } from "./agent-presentation"

/** Properties accepted by {@link BuiltInAgentView}. */
export type BuiltInAgentViewProps = {
  /** Built-in agent as read when it was opened. */
  readonly agent: BuiltInAgent
  /** Requests that the parent return to the agent list. */
  readonly onCloseAgentView: () => void
  /**
   * Requests that the parent open a copy of the agent as a new agent of the
   * user's own.
   */
  readonly onDuplicateAgent: () => void
}

/**
 * Presents one built-in agent's name, bio, and system prompt, none of which
 * can be changed.
 *
 * @remarks The parent owns the agent and both actions; the view owns no
 * state. It reads the context size from the application store to measure the
 * prompt against the window. Each text is a read-only field, so it can be
 * selected and copied but not typed into. Focus starts on the back button
 * when the view appears, and Escape pressed on any of the view's fields or
 * buttons returns to the list. A built-in agent
 * offers no save and no delete: Duplicate is how the user gets a version
 * they can change.
 * @param props - Agent and the parent-owned actions.
 * @returns The read-only view of the agent.
 */
export default function BuiltInAgentView({
  agent,
  onCloseAgentView,
  onDuplicateAgent
}: BuiltInAgentViewProps): ReactElement {
  const contextSize = useLysStore((state) => state.settings.model.contextSize)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const nameId = useId()
  const bioId = useId()
  const systemPromptId = useId()
  const measureId = useId()

  useLayoutEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  /**
   * Returns to the agent list when Escape is pressed on a control of the
   * view.
   *
   * @param event - Key press on one of the view's fields or buttons.
   */
  function handleControlKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return

    event.preventDefault()
    onCloseAgentView()
  }

  return (
    <section aria-label={agent.name} className="settings-view__agent-editor">
      <div className="settings-view__agent-editor-top">
        <Button
          aria-label="agents list"
          className="settings-view__agent-back"
          onClick={onCloseAgentView}
          onKeyDown={handleControlKeyDown}
          ref={backButtonRef}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ChevronLeft aria-hidden="true" />
          agents
        </Button>
        <span className="settings-view__agent-identity">
          <span className="settings-view__agent-kind">built-in</span>
          <span className="settings-view__agent-code">{agent.code}</span>
        </span>
      </div>
      <div className="settings-view__agent-field">
        <div className="settings-view__agent-field-top">
          <label htmlFor={nameId}>name</label>
        </div>
        <Input
          id={nameId}
          onKeyDown={handleControlKeyDown}
          readOnly
          type="text"
          value={agent.name}
        />
      </div>
      <div className="settings-view__agent-field">
        <div className="settings-view__agent-field-top">
          <label htmlFor={bioId}>bio</label>
        </div>
        <Input
          id={bioId}
          onKeyDown={handleControlKeyDown}
          readOnly
          type="text"
          value={agent.bio}
        />
      </div>
      <div className="settings-view__agent-field">
        <div className="settings-view__agent-field-top">
          <label htmlFor={systemPromptId}>system prompt</label>
          <span>the model's instructions</span>
        </div>
        <Textarea
          aria-describedby={measureId}
          className="settings-view__agent-prompt"
          id={systemPromptId}
          onKeyDown={handleControlKeyDown}
          readOnly
          spellCheck={false}
          value={agent.systemPrompt}
        />
        <div className="settings-view__agent-field-top">
          <span id={measureId}>
            {formatAgentPromptMeasure(agent.systemPrompt, contextSize)}
          </span>
        </div>
      </div>
      <div className="settings-view__agent-footer">
        <div className="settings-view__agent-actions">
          <Button
            onClick={onDuplicateAgent}
            onKeyDown={handleControlKeyDown}
            size="sm"
            title="Open a copy as a new agent of your own"
            type="button"
            variant="outline"
          >
            Duplicate
          </Button>
          <span className="settings-view__agent-fixed">
            built-in · not editable
          </span>
        </div>
        <div className="settings-view__agent-actions settings-view__agent-actions--commit">
          <Button
            onClick={onCloseAgentView}
            onKeyDown={handleControlKeyDown}
            size="sm"
            type="button"
            variant="outline"
          >
            Close
          </Button>
        </div>
      </div>
    </section>
  )
}
