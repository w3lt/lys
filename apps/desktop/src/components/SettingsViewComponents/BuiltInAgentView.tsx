import type { BuiltInAgent } from "@lys/share"
import { ChevronLeft } from "lucide-react"
import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type RefObject
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useLysStore } from "@/lib/store"

import { formatAgentPromptMeasure } from "./agent-presentation"

/**
 * Handles a key press on one of the view's controls by asking to return to
 * the agent list when the key is Escape.
 *
 * @param event - Key press on a field or button of the view; a press during
 * text composition is ignored.
 * @param onCloseAgentView - Requests that the parent return to the agent
 * list.
 */
function handleControlKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onCloseAgentView: () => void
): void {
  if (event.key !== "Escape" || event.nativeEvent.isComposing) return

  event.preventDefault()
  onCloseAgentView()
}

/** Properties accepted by {@link BuiltInAgentHeader}. */
type BuiltInAgentHeaderProps = {
  /** Code of the shown built-in agent. */
  readonly agentCode: string
  /** Parent-owned ref attached to the back button, which the parent focuses. */
  readonly backButtonRef: RefObject<HTMLButtonElement | null>
  /** Requests that the parent return to the agent list. */
  readonly onCloseAgentView: () => void
}

/**
 * Presents the way back to the agent list beside the built-in agent's
 * identity.
 *
 * @remarks The parent owns the code, the back button's ref, and the action;
 * the header owns no state. The back button is named `agents list`, and
 * Escape pressed on it also returns to the list. The identity is the word
 * `built-in` followed by the agent's code.
 * @param props - Agent code, back button ref, and the parent-owned action.
 * @returns The top row of the built-in agent view.
 */
function BuiltInAgentHeader({
  agentCode,
  backButtonRef,
  onCloseAgentView
}: BuiltInAgentHeaderProps): ReactElement {
  return (
    <div className="settings-view__agent-editor-top">
      <Button
        aria-label="agents list"
        className="settings-view__agent-back"
        onClick={onCloseAgentView}
        onKeyDown={(event) => handleControlKeyDown(event, onCloseAgentView)}
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
        <span className="settings-view__agent-code">{agentCode}</span>
      </span>
    </div>
  )
}

/** Properties accepted by {@link BuiltInAgentTextField}. */
type BuiltInAgentTextFieldProps = {
  /** Visible label naming the field. */
  readonly label: string
  /** One-line text of the built-in agent shown in the field. */
  readonly text: string
  /** Requests that the parent return to the agent list. */
  readonly onCloseAgentView: () => void
}

/**
 * Presents one line of a built-in agent's text in a labeled read-only field.
 *
 * @remarks The parent owns the label, the text, and the action; the field
 * owns no state. The text can be selected and copied but not typed into, and
 * Escape pressed in the field returns to the agent list.
 * @param props - Label, text, and the parent-owned action.
 * @returns The labeled read-only field.
 */
function BuiltInAgentTextField({
  label,
  text,
  onCloseAgentView
}: BuiltInAgentTextFieldProps): ReactElement {
  const fieldId = useId()

  return (
    <div className="settings-view__agent-field">
      <div className="settings-view__agent-field-top">
        <label htmlFor={fieldId}>{label}</label>
      </div>
      <Input
        id={fieldId}
        onKeyDown={(event) => handleControlKeyDown(event, onCloseAgentView)}
        readOnly
        type="text"
        value={text}
      />
    </div>
  )
}

/** Properties accepted by {@link BuiltInAgentPromptField}. */
type BuiltInAgentPromptFieldProps = {
  /** System prompt the built-in agent ships with. */
  readonly systemPrompt: string
  /** Context window in tokens the prompt is measured against. */
  readonly contextSize: number
  /** Requests that the parent return to the agent list. */
  readonly onCloseAgentView: () => void
}

/**
 * Presents a built-in agent's system prompt in a labeled read-only field
 * with its measure against the context window.
 *
 * @remarks The parent owns the prompt, the context size, and the action; the
 * field owns no state. The prompt can be selected and copied but not typed
 * into, and is not spell-checked. The measure below it describes the field.
 * Escape pressed in the field returns to the agent list.
 * @param props - System prompt, context size, and the parent-owned action.
 * @returns The labeled read-only prompt field and its measure.
 */
function BuiltInAgentPromptField({
  systemPrompt,
  contextSize,
  onCloseAgentView
}: BuiltInAgentPromptFieldProps): ReactElement {
  const fieldId = useId()
  const measureId = useId()

  return (
    <div className="settings-view__agent-field">
      <div className="settings-view__agent-field-top">
        <label htmlFor={fieldId}>system prompt</label>
        <span>the model's instructions</span>
      </div>
      <Textarea
        aria-describedby={measureId}
        className="settings-view__agent-prompt"
        id={fieldId}
        onKeyDown={(event) => handleControlKeyDown(event, onCloseAgentView)}
        readOnly
        spellCheck={false}
        value={systemPrompt}
      />
      <div className="settings-view__agent-field-top">
        <span id={measureId}>
          {formatAgentPromptMeasure(systemPrompt, contextSize)}
        </span>
      </div>
    </div>
  )
}

/** Properties accepted by {@link BuiltInAgentFooter}. */
type BuiltInAgentFooterProps = {
  /**
   * Requests that the parent open a copy of the agent as a new agent of the
   * user's own.
   */
  readonly onDuplicateAgent: () => void
  /** Requests that the parent return to the agent list. */
  readonly onCloseAgentView: () => void
}

/**
 * Presents the actions a built-in agent offers: Duplicate and Close.
 *
 * @remarks The parent owns both actions; the footer owns no state. A
 * built-in agent offers no save and no delete, which the words beside
 * Duplicate say. Escape pressed on either button returns to the agent list.
 * @param props - The parent-owned actions.
 * @returns The bottom row of the built-in agent view.
 */
function BuiltInAgentFooter({
  onDuplicateAgent,
  onCloseAgentView
}: BuiltInAgentFooterProps): ReactElement {
  return (
    <div className="settings-view__agent-footer">
      <div className="settings-view__agent-actions">
        <Button
          onClick={onDuplicateAgent}
          onKeyDown={(event) => handleControlKeyDown(event, onCloseAgentView)}
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
          onKeyDown={(event) => handleControlKeyDown(event, onCloseAgentView)}
          size="sm"
          type="button"
          variant="outline"
        >
          Close
        </Button>
      </div>
    </div>
  )
}

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
 * buttons returns to the list. A built-in agent offers no save and no delete:
 * Duplicate is how the user gets a version they can change.
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

  useLayoutEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  return (
    <section aria-label={agent.name} className="settings-view__agent-editor">
      <BuiltInAgentHeader
        agentCode={agent.code}
        backButtonRef={backButtonRef}
        onCloseAgentView={onCloseAgentView}
      />
      <BuiltInAgentTextField
        label="name"
        onCloseAgentView={onCloseAgentView}
        text={agent.name}
      />
      <BuiltInAgentTextField
        label="bio"
        onCloseAgentView={onCloseAgentView}
        text={agent.bio}
      />
      <BuiltInAgentPromptField
        contextSize={contextSize}
        onCloseAgentView={onCloseAgentView}
        systemPrompt={agent.systemPrompt}
      />
      <BuiltInAgentFooter
        onCloseAgentView={onCloseAgentView}
        onDuplicateAgent={onDuplicateAgent}
      />
    </section>
  )
}
