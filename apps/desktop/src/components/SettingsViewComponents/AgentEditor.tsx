import {
  MAXIMUM_AGENT_BIO_LENGTH,
  MAXIMUM_AGENT_CODE_LENGTH,
  MAXIMUM_AGENT_NAME_LENGTH
} from "@lys/share"
import { ChevronLeft } from "lucide-react"
import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useLysStore } from "@/lib/store"
import {
  calculateAgentCodeFromName,
  calculateAgentDraftProblemField,
  findAgentDraftProblem,
  isAgentDraftChanged,
  isNewAgentDraftStarted,
  useAgentStore,
  type AgentDraftField,
  type AgentDraftProblem,
  type AgentDraftSubject,
  type AgentEditorState,
  type ListedAgentIdentity,
  type StoredAgentActivity
} from "@/lib/store/agents"

import {
  formatAgentActivityStatus,
  formatAgentDraftProblem,
  formatAgentPromptMeasure
} from "./agent-presentation"

/** Editor states in which a draft is written. */
type DraftingAgentEditor = Extract<
  AgentEditorState,
  { readonly status: "creating" | "editing" }
>

/** Editor states in which a stored agent is read or could not be read. */
type ReadingAgentEditor = Extract<
  AgentEditorState,
  { readonly status: "opening" | "unavailable" }
>

/**
 * Handles the attachment of an element that takes focus when it appears, by
 * focusing it.
 *
 * @param element - Attached element, or null when React detaches it, which
 * is ignored.
 */
function handleFocusTargetAttach(element: HTMLElement | null): void {
  element?.focus()
}

/**
 * Reports whether a change to the edited agent awaits the backend.
 *
 * @param activity - Change or confirmation in progress in the editor.
 * @returns Whether a save or delete is pending.
 */
function isAgentActivityPending(activity: StoredAgentActivity): boolean {
  return activity.status === "saving" || activity.status === "deleting"
}

/**
 * Builds the space-separated identifiers that describe a field.
 *
 * @param constraintIds - Identifiers of the field's visible constraints, in
 * reading order.
 * @param problemId - Identifier of the problem message, or undefined when
 * the field is valid.
 * @returns The identifiers for `aria-describedby`.
 */
function buildFieldDescriptionIds(
  constraintIds: readonly string[],
  problemId: string | undefined
): string {
  const descriptionIds =
    problemId === undefined ? constraintIds : [...constraintIds, problemId]

  return descriptionIds.join(" ")
}

/** Properties accepted by {@link AgentEditorHeader}. */
type AgentEditorHeaderProps = {
  /** Editor whose draft is written, which names the agent being edited. */
  readonly editor: DraftingAgentEditor
  /** Whether the draft holds changes that are not saved. */
  readonly isDraftChanged: boolean
  /** Requests that the parent close the editor, discarding the draft. */
  readonly onCloseAgentEditor: () => void
}

/**
 * Presents the editor's way back to the list and what is being edited.
 *
 * @remarks The parent owns the editor and the close action; the header owns
 * no state or effects. The back button is named `agents list` and is
 * disabled while a change is pending. A new agent is marked `new` and shows
 * its typed code, or that its code is assigned on save; a stored agent is
 * marked `yours` with its code. `unsaved` marks a changed draft in text.
 * @param props - Editor, draft state, and the close action.
 * @returns The editor header.
 */
function AgentEditorHeader({
  editor,
  isDraftChanged,
  onCloseAgentEditor
}: AgentEditorHeaderProps): ReactElement {
  const isNew = editor.status === "creating"
  const agentCode = isNew ? editor.code : editor.agent.code

  return (
    <div className="settings-view__agent-editor-top">
      <Button
        aria-label="agents list"
        className="settings-view__agent-back"
        disabled={isAgentActivityPending(editor.activity)}
        onClick={onCloseAgentEditor}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeft aria-hidden="true" />
        agents
      </Button>
      <span className="settings-view__agent-identity">
        {isDraftChanged ? (
          <span className="settings-view__agent-unsaved">unsaved</span>
        ) : null}
        <span className="settings-view__agent-kind">
          {isNew ? "new" : "yours"}
        </span>
        <span className="settings-view__agent-code">
          {agentCode === "" ? "code assigned on save" : agentCode}
        </span>
      </span>
    </div>
  )
}

/** Properties accepted by {@link AgentTextField}. */
type AgentTextFieldProps = {
  /** Visible label naming the field. */
  readonly label: string
  /** Text as typed, owned by the parent. */
  readonly text: string
  /**
   * Inclusive maximum length of the trimmed text in UTF-16 code units, the
   * unit of the shared limits.
   */
  readonly maximumLength: number
  /** Example shown while the field is empty. */
  readonly placeholder: string
  /**
   * Identifier of the message explaining the field's problem; omitted while
   * the field has none.
   */
  readonly problemId?: string
  /** Whether the text may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the input host so the parent can move focus to it. */
  readonly fieldRef: RefObject<HTMLInputElement | null>
  /** Receives the proposed text on each edit. */
  readonly onTextChange: (text: string) => void
}

/**
 * Edits one required line of agent text with its length shown against its
 * limit.
 *
 * @remarks The parent owns the text and accepts or ignores each proposal;
 * the field owns no state or effects. The input is labeled by the visible
 * label, marked required visibly and programmatically, and described by the
 * length counter and, while invalid, by the problem message. The counter
 * measures the trimmed text, as it will be saved; the field accepts longer
 * text, which saving then reports.
 * @param props - Label, text, limit, problem relationship, and change action.
 * @returns The labeled field.
 */
function AgentTextField({
  label,
  text,
  maximumLength,
  placeholder,
  problemId,
  isReadOnly,
  fieldRef,
  onTextChange
}: AgentTextFieldProps): ReactElement {
  const inputId = useId()
  const counterId = useId()

  return (
    <div className="settings-view__agent-field">
      <div className="settings-view__agent-field-top">
        <span className="settings-view__agent-field-label">
          <label htmlFor={inputId}>{label}</label>
          <span>required</span>
        </span>
        <span id={counterId}>
          {text.trim().length} / {maximumLength}
        </span>
      </div>
      <Input
        aria-describedby={buildFieldDescriptionIds([counterId], problemId)}
        aria-invalid={problemId !== undefined}
        aria-required
        id={inputId}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        placeholder={placeholder}
        readOnly={isReadOnly}
        ref={fieldRef}
        type="text"
        value={text}
      />
    </div>
  )
}

/** Properties accepted by {@link AgentCodeField}. */
type AgentCodeFieldProps = {
  /** Code as kept from typing, owned by the parent. */
  readonly code: string
  /** Name as typed, whose code form `use name` offers. */
  readonly name: string
  /**
   * Identifier of the message explaining the code's problem; omitted while
   * the code has none.
   */
  readonly problemId?: string
  /** Whether the code may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the input host so the parent can move focus to it. */
  readonly fieldRef: RefObject<HTMLInputElement | null>
  /**
   * Receives the typed text on each edit, or the name's code form when
   * `use name` is pressed; the parent keeps the code form of what it gets.
   */
  readonly onCodeChange: (typedCode: string) => void
}

/**
 * Edits the optional code of a new agent.
 *
 * @remarks The parent owns the code and how typed text becomes one; the
 * field owns no state or effects. The input is labeled `code` and described
 * by its constraints — optional and fixed once created, its accepted format,
 * and its length against the limit — and, while invalid, by the
 * problem message. `use name` appears only while the code is empty and the
 * name has a code form, and proposes that form.
 * @param props - Code, the typed name, and the change action.
 * @returns The labeled code field.
 */
function AgentCodeField({
  code,
  name,
  problemId,
  isReadOnly,
  fieldRef,
  onCodeChange
}: AgentCodeFieldProps): ReactElement {
  const inputId = useId()
  const hintId = useId()
  const formatId = useId()
  const counterId = useId()
  const nameCode = calculateAgentCodeFromName(name)
  const descriptionIds = [hintId, formatId, counterId]

  return (
    <div className="settings-view__agent-field">
      <div className="settings-view__agent-field-top">
        <span className="settings-view__agent-field-label">
          <label htmlFor={inputId}>code</label>
          <span id={hintId}>optional · fixed once created</span>
        </span>
        <span className="settings-view__agent-field-label">
          {code === "" && nameCode !== "" ? (
            <Button
              className="settings-view__agent-use-name"
              disabled={isReadOnly}
              onClick={() => onCodeChange(nameCode)}
              size="sm"
              type="button"
              variant="ghost"
            >
              use name
            </Button>
          ) : null}
          <span id={counterId}>
            {code.length} / {MAXIMUM_AGENT_CODE_LENGTH}
          </span>
        </span>
      </div>
      <Input
        aria-describedby={buildFieldDescriptionIds(descriptionIds, problemId)}
        aria-invalid={problemId !== undefined}
        autoComplete="off"
        className="settings-view__agent-mono"
        id={inputId}
        onChange={(event) => onCodeChange(event.currentTarget.value)}
        placeholder="leave empty to derive it from the name"
        readOnly={isReadOnly}
        ref={fieldRef}
        spellCheck={false}
        type="text"
        value={code}
      />
      <div className="settings-view__agent-field-top">
        <span id={formatId}>
          lowercase letters and digits, joined by single hyphens, not ending in
          one
        </span>
      </div>
    </div>
  )
}

/** Properties accepted by {@link AgentPromptField}. */
type AgentPromptFieldProps = {
  /** System prompt as typed, owned by the parent. */
  readonly systemPrompt: string
  /** Local estimate of the context window, in tokens. */
  readonly contextSize: number
  /**
   * Identifier of the message explaining the prompt's problem; omitted while
   * the prompt has none.
   */
  readonly problemId?: string
  /** Whether the prompt may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the textarea host so the parent can move focus to it. */
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>
  /** Receives the proposed prompt on each edit. */
  readonly onSystemPromptChange: (systemPrompt: string) => void
}

/**
 * Edits an agent's required system prompt with its estimated size.
 *
 * @remarks The parent owns the prompt and accepts or ignores each proposal;
 * the field owns no state or effects. The textarea is labeled
 * `system prompt`, marked required visibly and programmatically, and
 * described by its estimated size and, while invalid, by the problem
 * message. The size is a local estimate.
 * @param props - Prompt, window estimate, problem relationship, and action.
 * @returns The labeled prompt field.
 */
function AgentPromptField({
  systemPrompt,
  contextSize,
  problemId,
  isReadOnly,
  fieldRef,
  onSystemPromptChange
}: AgentPromptFieldProps): ReactElement {
  const textareaId = useId()
  const measureId = useId()

  return (
    <div className="settings-view__agent-field">
      <div className="settings-view__agent-field-top">
        <span className="settings-view__agent-field-label">
          <label htmlFor={textareaId}>system prompt</label>
          <span>required</span>
        </span>
        <span>the model's instructions</span>
      </div>
      <Textarea
        aria-describedby={buildFieldDescriptionIds([measureId], problemId)}
        aria-invalid={problemId !== undefined}
        aria-required
        className="settings-view__agent-prompt"
        id={textareaId}
        onChange={(event) => onSystemPromptChange(event.currentTarget.value)}
        placeholder="You are…"
        readOnly={isReadOnly}
        ref={fieldRef}
        spellCheck={false}
        value={systemPrompt}
      />
      <div className="settings-view__agent-field-top">
        <span id={measureId}>
          {formatAgentPromptMeasure(systemPrompt, contextSize)}
        </span>
        <span>⌘ enter saves</span>
      </div>
    </div>
  )
}

/** Editor host elements that can receive focus for a problem. */
type AgentFieldRefs = {
  /** Name input. */
  readonly name: RefObject<HTMLInputElement | null>
  /** Code input, attached only for a new agent. */
  readonly code: RefObject<HTMLInputElement | null>
  /** Bio input. */
  readonly bio: RefObject<HTMLInputElement | null>
  /** System prompt textarea. */
  readonly systemPrompt: RefObject<HTMLTextAreaElement | null>
}

/** Properties accepted by {@link AgentDraftFields}. */
type AgentDraftFieldsProps = {
  /** Editor whose draft is written, owned by the agent store. */
  readonly editor: DraftingAgentEditor
  /** Problem shown for the draft, or undefined while none is shown. */
  readonly problem: AgentDraftProblem | undefined
  /** Identifier of the message the invalid field refers to. */
  readonly problemId: string
  /** Hosts the parent moves focus to when a save is rejected. */
  readonly fieldRefs: AgentFieldRefs
}

/**
 * Edits the draft's name, code, bio, and system prompt.
 *
 * @remarks The agent store owns the draft and accepts each edit; the
 * application store supplies the context estimate for the prompt measure.
 * The parent owns the shown problem, its message, and the field hosts; only
 * the field the problem concerns is marked invalid. The code field appears
 * only for a new agent. While a change is pending, every field is read-only.
 * The fields are rendered as siblings, without a wrapper.
 * @param props - Editor, shown problem, its message, and the field hosts.
 * @returns The draft's fields.
 */
function AgentDraftFields({
  editor,
  problem,
  problemId,
  fieldRefs
}: AgentDraftFieldsProps): ReactElement {
  const contextSize = useLysStore((state) => state.settings.model.contextSize)
  const updateAgentDraft = useAgentStore((state) => state.updateAgentDraft)
  const updateNewAgentCode = useAgentStore((state) => state.updateNewAgentCode)
  const isReadOnly = isAgentActivityPending(editor.activity)

  /**
   * Finds the problem message a field refers to.
   *
   * @param field - Field being rendered.
   * @returns The message's identifier while the problem concerns the field.
   */
  function findFieldProblemId(field: AgentDraftField): string | undefined {
    const isFieldInvalid =
      problem !== undefined &&
      calculateAgentDraftProblemField(problem) === field

    return isFieldInvalid ? problemId : undefined
  }

  return (
    <>
      <AgentTextField
        fieldRef={fieldRefs.name}
        isReadOnly={isReadOnly}
        label="name"
        maximumLength={MAXIMUM_AGENT_NAME_LENGTH}
        onTextChange={(name) => updateAgentDraft({ ...editor.draft, name })}
        placeholder="Reviewer"
        problemId={findFieldProblemId("name")}
        text={editor.draft.name}
      />
      {editor.status === "creating" ? (
        <AgentCodeField
          code={editor.code}
          fieldRef={fieldRefs.code}
          isReadOnly={isReadOnly}
          name={editor.draft.name}
          onCodeChange={updateNewAgentCode}
          problemId={findFieldProblemId("code")}
        />
      ) : null}
      <AgentTextField
        fieldRef={fieldRefs.bio}
        isReadOnly={isReadOnly}
        label="bio"
        maximumLength={MAXIMUM_AGENT_BIO_LENGTH}
        onTextChange={(bio) => updateAgentDraft({ ...editor.draft, bio })}
        placeholder="One line on what this agent is for. For you, not the model."
        problemId={findFieldProblemId("bio")}
        text={editor.draft.bio}
      />
      <AgentPromptField
        contextSize={contextSize}
        fieldRef={fieldRefs.systemPrompt}
        isReadOnly={isReadOnly}
        onSystemPromptChange={(systemPrompt) =>
          updateAgentDraft({ ...editor.draft, systemPrompt })
        }
        problemId={findFieldProblemId("systemPrompt")}
        systemPrompt={editor.draft.systemPrompt}
      />
    </>
  )
}

/** Properties accepted by {@link AgentEditorFeedback}. */
type AgentEditorFeedbackProps = {
  /** First problem of a draft whose save was attempted, or undefined. */
  readonly problem: AgentDraftProblem | undefined
  /** Identifier given to the problem message. */
  readonly problemId: string
  /** Change or confirmation in progress in the editor. */
  readonly activity: StoredAgentActivity
}

/**
 * Explains why a draft cannot be saved and announces pending and failed
 * changes.
 *
 * @remarks The parent owns the problem, its identifier, and the activity;
 * the component owns no state or effects. The problem message exists only
 * while there is a problem, so fields refer to it only then. The pending
 * status is a polite live region and the failure an alert; both regions stay
 * mounted so updates are announced.
 * @param props - Problem, its identifier, and the editor activity.
 * @returns The editor's feedback lines.
 */
function AgentEditorFeedback({
  problem,
  problemId,
  activity
}: AgentEditorFeedbackProps): ReactElement {
  return (
    <div className="settings-view__agent-feedback">
      {problem === undefined ? null : (
        <p className="settings-view__agent-problem" id={problemId}>
          {formatAgentDraftProblem(problem)}
        </p>
      )}
      <p aria-live="polite" className="settings-view__note" role="status">
        {formatAgentActivityStatus(activity)}
      </p>
      <p className="settings-view__agent-problem" role="alert">
        {activity.status === "idle" ? activity.failure : null}
      </p>
    </div>
  )
}

/** Properties accepted by {@link AgentDeleteConfirmation}. */
type AgentDeleteConfirmationProps = {
  /** Whether the deletion awaits the backend, which disables both choices. */
  readonly isDeleting: boolean
  /** Requests that the parent keep the agent. */
  readonly onCancelAgentDeletion: () => void
  /** Requests that the parent delete the agent for good. */
  readonly onDeleteAgent: () => void
}

/**
 * Asks whether to delete an agent for good.
 *
 * @remarks The parent owns whether the deletion is pending and both
 * choices; the component owns no state or effects. The question is a group
 * named `Delete for good?`. Focus starts on Keep, the least destructive
 * choice, and Escape on either choice keeps the agent without closing the
 * editor. While the deletion is pending, both choices are disabled.
 * @param props - Pending deletion and the parent-owned choices.
 * @returns The confirmation group.
 */
function AgentDeleteConfirmation({
  isDeleting,
  onCancelAgentDeletion,
  onDeleteAgent
}: AgentDeleteConfirmationProps): ReactElement {
  /**
   * Keeps the agent when Escape is pressed on either choice.
   *
   * @param event - Key press on a confirmation button.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return

    event.preventDefault()
    event.stopPropagation()
    onCancelAgentDeletion()
  }

  return (
    <fieldset
      aria-label="Delete for good?"
      className="settings-view__agent-confirm"
      disabled={isDeleting}
    >
      <span aria-hidden="true">delete for good?</span>
      <Button
        autoFocus
        onClick={onCancelAgentDeletion}
        onKeyDown={handleConfirmationKeyDown}
        size="sm"
        type="button"
        variant="outline"
      >
        Keep
      </Button>
      <Button
        onClick={onDeleteAgent}
        onKeyDown={handleConfirmationKeyDown}
        size="sm"
        type="button"
        variant="destructive"
      >
        Delete
      </Button>
    </fieldset>
  )
}

/** Properties accepted by {@link StoredAgentActions}. */
type StoredAgentActionsProps = {
  /** Change or confirmation in progress in the editor. */
  readonly activity: StoredAgentActivity
  /** Requests that the parent open a copy of the agent as a new one. */
  readonly onDuplicateAgent: () => void
  /** Requests that the parent ask whether to delete the agent. */
  readonly onRequestAgentDeletion: () => void
  /** Requests that the parent keep the agent after deletion was asked. */
  readonly onCancelAgentDeletion: () => void
  /** Requests that the parent delete the agent for good. */
  readonly onDeleteAgent: () => void
}

/**
 * Offers deleting and duplicating a stored agent, confirming deletion first.
 *
 * @remarks The parent owns the activity and every action; the component owns
 * only whether its Delete button has been replaced by the confirmation, so
 * that focus returns to that button when the confirmation leaves. While a
 * change is pending, every action is disabled.
 * @param props - Activity and the parent-owned actions.
 * @returns The stored agent's actions, or the deletion confirmation.
 */
function StoredAgentActions({
  activity,
  onDuplicateAgent,
  onRequestAgentDeletion,
  onCancelAgentDeletion,
  onDeleteAgent
}: StoredAgentActionsProps): ReactElement {
  const [hasConfirmationOpened, setHasConfirmationOpened] = useState(false)
  const isPending = isAgentActivityPending(activity)

  /** Asks whether to delete, remembering that focus must come back. */
  function handleRequestDeletion(): void {
    setHasConfirmationOpened(true)
    onRequestAgentDeletion()
  }

  if (
    activity.status === "confirming-delete" ||
    activity.status === "deleting"
  ) {
    return (
      <AgentDeleteConfirmation
        isDeleting={isPending}
        onCancelAgentDeletion={onCancelAgentDeletion}
        onDeleteAgent={onDeleteAgent}
      />
    )
  }

  return (
    <div className="settings-view__agent-actions">
      <Button
        disabled={isPending}
        onClick={handleRequestDeletion}
        ref={hasConfirmationOpened ? handleFocusTargetAttach : undefined}
        size="sm"
        type="button"
        variant="destructive"
      >
        Delete
      </Button>
      <Button
        disabled={isPending}
        onClick={onDuplicateAgent}
        size="sm"
        type="button"
        variant="outline"
      >
        Duplicate
      </Button>
    </div>
  )
}

/** Properties accepted by {@link AgentReadStatus}. */
export type AgentReadStatusProps = {
  /** Editor while its agent is read or after it could not be read. */
  readonly editor: ReadingAgentEditor
  /** Requests that the parent return to the list. */
  readonly onCloseAgentEditor: () => void
  /** Requests that the parent read the agent again. */
  readonly onRetryAgent: () => void
}

/**
 * Presents an agent being read for its editor, or why it could not be.
 *
 * @remarks The parent owns the editor state and both actions; the component
 * owns no state. Focus moves to the back button when the component is
 * attached, because the row that opened it has left the screen, and again
 * when Retry is pressed, because Retry leaves while the agent is read. One
 * polite status, present from the start, says the agent is being read and
 * then why it could not be; Retry appears only after a failure.
 * @param props - Reading editor and the parent-owned actions.
 * @returns The read status with its way back.
 */
export function AgentReadStatus({
  editor,
  onCloseAgentEditor,
  onRetryAgent
}: AgentReadStatusProps): ReactElement {
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const isOpening = editor.status === "opening"

  useLayoutEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  /** Reads the agent again, keeping focus on the way back while it is read. */
  function handleRetryAgent(): void {
    backButtonRef.current?.focus()
    onRetryAgent()
  }

  return (
    <div className="settings-view__agent-editor">
      <div className="settings-view__agent-editor-top">
        <Button
          aria-label="agents list"
          className="settings-view__agent-back"
          onClick={onCloseAgentEditor}
          ref={backButtonRef}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ChevronLeft aria-hidden="true" />
          agents
        </Button>
        <span className="settings-view__agent-code">{editor.agentCode}</span>
      </div>
      <div className="settings-view__agent-status">
        <p
          aria-live="polite"
          className={
            isOpening ? "settings-view__note" : "settings-view__agent-problem"
          }
          role="status"
        >
          {isOpening ? `Reading ${editor.agentCode}…` : editor.error}
        </p>
        {isOpening ? null : (
          <Button
            onClick={handleRetryAgent}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  )
}

/** Properties accepted by {@link AgentEditor}. */
export type AgentEditorProps = {
  /** Editor whose draft is written, owned by the agent store. */
  readonly editor: DraftingAgentEditor
  /** Every listed agent, against which names and codes are checked. */
  readonly agents: readonly ListedAgentIdentity[]
}

/**
 * Builds the subject a draft is checked for.
 *
 * @param editor - Editor whose draft is written.
 * @returns A new agent with its typed code, or the stored agent's code and
 * stored name.
 */
function buildAgentDraftSubject(
  editor: DraftingAgentEditor
): AgentDraftSubject {
  return editor.status === "creating"
    ? { kind: "new", code: editor.code }
    : { kind: "stored", code: editor.agent.code, name: editor.agent.name }
}

/**
 * Finds the problem the editor shows.
 *
 * @param editor - Editor whose draft is written.
 * @param agents - Every listed agent.
 * @returns The draft's first problem once a save was attempted; undefined
 * before that or when the draft has none.
 */
function findShownAgentDraftProblem(
  editor: DraftingAgentEditor,
  agents: readonly ListedAgentIdentity[]
): AgentDraftProblem | undefined {
  if (editor.saveAttemptCount === 0) return undefined

  return findAgentDraftProblem(
    editor.draft,
    buildAgentDraftSubject(editor),
    agents
  )
}

/**
 * Reports whether a draft holds changes that are not saved.
 *
 * @param editor - Editor whose draft is written.
 * @returns For a new agent, whether anything was typed; for a stored one,
 * whether any field differs from it.
 */
function isEditorDraftChanged(editor: DraftingAgentEditor): boolean {
  return editor.status === "creating"
    ? isNewAgentDraftStarted(editor.draft, editor.code)
    : isAgentDraftChanged(editor.draft, editor.agent)
}

/**
 * Reports whether a key press asks to save: Command or Control with Enter.
 *
 * @param event - Key press inside the editor.
 * @returns Whether the press is the save shortcut.
 */
function isSaveShortcut(event: KeyboardEvent<HTMLElement>): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter"
}

/**
 * Owns the editor's field hosts and moves focus to the field that needs it.
 *
 * @param saveAttemptCount - Reactive count of the editor's save attempts;
 * each new value is one attempt the agent store has recorded.
 * @param problem - Problem the editor shows in the current render, read when
 * focus moves.
 * @returns The field hosts for the caller to attach. Each host ref keeps its
 * identity for the editor's lifetime; the record holding them is rebuilt on
 * every render.
 * @remarks Focus moves to the name field when the editor appears. In the
 * layout phase after each recorded save attempt, focus moves to the field of
 * the shown problem, which is then already marked invalid and described by
 * the problem; an attempt without a problem leaves focus where it is. An
 * editor that appears with a problem already shown starts on that field.
 */
function useAgentFieldFocus(
  saveAttemptCount: number,
  problem: AgentDraftProblem | undefined
): AgentFieldRefs {
  const nameFieldRef = useRef<HTMLInputElement>(null)
  const codeFieldRef = useRef<HTMLInputElement>(null)
  const bioFieldRef = useRef<HTMLInputElement>(null)
  const systemPromptFieldRef = useRef<HTMLTextAreaElement>(null)
  const fieldRefs: AgentFieldRefs = {
    name: nameFieldRef,
    code: codeFieldRef,
    bio: bioFieldRef,
    systemPrompt: systemPromptFieldRef
  }
  const handleSaveAttempt = useEffectEvent((): void => {
    if (problem === undefined) return
    fieldRefs[calculateAgentDraftProblemField(problem)].current?.focus()
  })

  useLayoutEffect(() => {
    nameFieldRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (saveAttemptCount > 0) handleSaveAttempt()
  }, [saveAttemptCount])

  return fieldRefs
}

/**
 * Edits one agent's draft and saves, duplicates, or deletes it.
 *
 * @remarks The agent store owns the draft, the save attempts, and every
 * change; the parent supplies the drafting editor and the listed agents, and
 * gives each agent its own instance. The editor is a form named after the
 * agent, or `New agent`. Focus moves to the name field when the editor is
 * attached. Enter in a one-line field or Command or Control with Enter
 * anywhere submits; a draft with a problem is not saved, and once the attempt
 * is committed — its first problem shown, the field marked invalid and
 * described by the message — focus moves to that field. Escape closes the
 * editor, discarding the draft, unless a change is pending; while one is, the
 * fields are read-only and the actions disabled.
 * @param props - Drafting editor and the listed agents.
 * @returns The agent editor form.
 */
export function AgentEditor({
  editor,
  agents
}: AgentEditorProps): ReactElement {
  const saveAgentDraft = useAgentStore((state) => state.saveAgentDraft)
  const closeAgentEditor = useAgentStore((state) => state.closeAgentEditor)
  const problemId = useId()
  const isDraftChanged = isEditorDraftChanged(editor)
  const problem = findShownAgentDraftProblem(editor, agents)
  const fieldRefs = useAgentFieldFocus(editor.saveAttemptCount, problem)

  /**
   * Asks the agent store to save the draft; a draft with a problem is not
   * sent, and the recorded attempt moves focus to that problem's field.
   *
   * @param event - Submission of the editor form; ignored unless the editor
   * is idle and its draft changed, as the Save button is. The agent store
   * also ignores it while the list is read again, when Save is disabled too.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (editor.activity.status !== "idle" || !isDraftChanged) return

    void saveAgentDraft()
  }

  /**
   * Submits on the save shortcut and closes on Escape.
   *
   * @param event - Key press bubbling from within the editor.
   */
  function handleEditorKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.nativeEvent.isComposing) return

    if (isSaveShortcut(event)) {
      event.preventDefault()
      event.currentTarget.requestSubmit()
      return
    }
    if (event.key === "Escape" && !isAgentActivityPending(editor.activity)) {
      event.preventDefault()
      closeAgentEditor()
    }
  }

  return (
    <form
      aria-label={
        editor.status === "creating" ? "New agent" : editor.agent.name
      }
      className="settings-view__agent-editor"
      noValidate
      onKeyDown={handleEditorKeyDown}
      onSubmit={handleSubmit}
    >
      <AgentEditorHeader
        editor={editor}
        isDraftChanged={isDraftChanged}
        onCloseAgentEditor={closeAgentEditor}
      />
      <AgentDraftFields
        editor={editor}
        fieldRefs={fieldRefs}
        problem={problem}
        problemId={problemId}
      />
      <AgentEditorFeedback
        activity={editor.activity}
        problem={problem}
        problemId={problemId}
      />
      <AgentEditorFooter editor={editor} isDraftChanged={isDraftChanged} />
    </form>
  )
}

/** Properties accepted by {@link AgentEditorFooter}. */
type AgentEditorFooterProps = {
  /** Editor whose draft is written, owned by the agent store. */
  readonly editor: DraftingAgentEditor
  /** Whether the draft holds changes that are not saved. */
  readonly isDraftChanged: boolean
}

/**
 * Presents the editor's actions: the stored agent's own, closing, and
 * saving.
 *
 * @remarks The agent store owns every action and the agent list; the parent
 * supplies the editor and whether its draft changed, and owns the form that
 * the Save button submits. Close reads `Discard` while the draft holds
 * changes. Save reads `Create` for a new agent and is enabled only for an
 * idle editor with changes while the agent list is not being read again,
 * since names and codes are checked against it. While a change is pending,
 * every action is disabled.
 * @param props - Drafting editor and whether its draft changed.
 * @returns The editor footer.
 */
function AgentEditorFooter({
  editor,
  isDraftChanged
}: AgentEditorFooterProps): ReactElement {
  const closeAgentEditor = useAgentStore((state) => state.closeAgentEditor)
  const openAgentCopy = useAgentStore((state) => state.openAgentCopy)
  const openAgentDeleteConfirmation = useAgentStore(
    (state) => state.openAgentDeleteConfirmation
  )
  const closeAgentDeleteConfirmation = useAgentStore(
    (state) => state.closeAgentDeleteConfirmation
  )
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const isListRefreshing = useAgentStore(
    (state) => state.list.status === "loaded" && state.list.isRefreshing
  )
  const { activity } = editor
  const isNew = editor.status === "creating"

  return (
    <div className="settings-view__agent-footer">
      {editor.status === "editing" ? (
        <StoredAgentActions
          activity={editor.activity}
          onCancelAgentDeletion={closeAgentDeleteConfirmation}
          onDeleteAgent={() => void deleteAgent()}
          onDuplicateAgent={openAgentCopy}
          onRequestAgentDeletion={openAgentDeleteConfirmation}
        />
      ) : null}
      <div className="settings-view__agent-actions settings-view__agent-actions--commit">
        <Button
          disabled={isAgentActivityPending(activity)}
          onClick={closeAgentEditor}
          size="sm"
          type="button"
          variant="outline"
        >
          {isDraftChanged ? "Discard" : "Close"}
        </Button>
        <Button
          disabled={
            !isDraftChanged || activity.status !== "idle" || isListRefreshing
          }
          size="sm"
          type="submit"
        >
          {isNew ? "Create" : "Save"}
        </Button>
      </div>
    </div>
  )
}
