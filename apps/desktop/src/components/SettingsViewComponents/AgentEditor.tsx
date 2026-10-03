import type { AgentSummary } from "@lys/protocol"
import {
  MAXIMUM_AGENT_BIO_LENGTH,
  MAXIMUM_AGENT_CODE_LENGTH,
  MAXIMUM_AGENT_NAME_LENGTH
} from "@lys/share"
import { ChevronLeft } from "lucide-react"
import {
  useEffect,
  useId,
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
 * Focuses an element as React attaches it.
 *
 * @param element - Attached element, or null when React detaches it.
 */
function focusElementOnAttach(element: HTMLElement | null): void {
  element?.focus()
}

/**
 * Builds the space-separated identifiers that describe a field.
 *
 * @param hintId - Identifier of the field's visible constraint.
 * @param problemId - Identifier of the problem message, or undefined when
 * the field is valid.
 * @returns The identifiers for `aria-describedby`.
 */
function buildFieldDescriptionIds(
  hintId: string,
  problemId: string | undefined
): string {
  return problemId === undefined ? hintId : `${hintId} ${problemId}`
}

/** Properties accepted by {@link AgentEditorHeader}. */
export type AgentEditorHeaderProps = {
  /** Whether the editor writes a new agent or changes one of the user's. */
  readonly agentKind: "new" | "yours"
  /** Code of the agent; empty while a new agent has no code typed. */
  readonly agentCode: string
  /** Whether the draft holds changes that are not saved. */
  readonly isDraftChanged: boolean
  /** Whether the editor may close; false while a change is pending. */
  readonly isCloseEnabled: boolean
  /** Requests that the parent close the editor, discarding the draft. */
  readonly onCloseAgentEditor: () => void
}

/**
 * Presents the editor's way back to the list and what is being edited.
 *
 * @remarks Primary category: presentational. The parent owns every value and
 * the close action; the header owns no state or effects. The back button is
 * named `agents list`. A new agent without a typed code shows that its code
 * is assigned on save; `unsaved` marks a changed draft in text.
 * @param props - Agent identity, draft state, and the close action.
 * @returns The editor header.
 */
export function AgentEditorHeader({
  agentKind,
  agentCode,
  isDraftChanged,
  isCloseEnabled,
  onCloseAgentEditor
}: AgentEditorHeaderProps): ReactElement {
  return (
    <div className="settings-view__agent-editor-top">
      <Button
        aria-label="agents list"
        className="settings-view__agent-back"
        disabled={!isCloseEnabled}
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
        <span className="settings-view__agent-kind">{agentKind}</span>
        <span className="settings-view__agent-code">
          {agentCode === "" ? "code assigned on save" : agentCode}
        </span>
      </span>
    </div>
  )
}

/** Properties accepted by {@link AgentTextField}. */
export type AgentTextFieldProps = {
  /** Visible label naming the field. */
  readonly label: string
  /** Text as typed, owned by the parent. */
  readonly text: string
  /** Inclusive maximum length in UTF-16 code units. */
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
 * Edits one line of agent text with its length shown against its limit.
 *
 * @remarks Primary category: presentational. The parent owns the text and
 * accepts or ignores each proposal; the field owns no state or effects. The
 * input is labeled by the visible label, limited to the maximum length, and
 * described by the length counter and, while invalid, by the problem
 * message.
 * @param props - Label, text, limit, problem relationship, and change action.
 * @returns The labeled field.
 */
export function AgentTextField({
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
        <label htmlFor={inputId}>{label}</label>
        <span id={counterId}>
          {text.length} / {maximumLength}
        </span>
      </div>
      <Input
        aria-describedby={buildFieldDescriptionIds(counterId, problemId)}
        aria-invalid={problemId !== undefined}
        id={inputId}
        maxLength={maximumLength}
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
export type AgentCodeFieldProps = {
  /** Code as kept from typing, owned by the parent. */
  readonly code: string
  /** Whether the name can supply a code, which offers `use name`. */
  readonly canUseName: boolean
  /**
   * Identifier of the message explaining the code's problem; omitted while
   * the code has none.
   */
  readonly problemId?: string
  /** Whether the code may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the input host so the parent can move focus to it. */
  readonly fieldRef: RefObject<HTMLInputElement | null>
  /** Receives the typed text on each edit; the parent keeps its code form. */
  readonly onCodeChange: (typedCode: string) => void
  /** Requests that the parent fill the code from the agent's name. */
  readonly onUseNameAsCode: () => void
}

/**
 * Edits the optional code of a new agent.
 *
 * @remarks Primary category: presentational. The parent owns the code and
 * how typed text becomes one; the field owns no state or effects. The input
 * is labeled `code` and described by its constraint — optional and fixed
 * once created — and, while invalid, by the problem message. `use name`
 * appears only while the code is empty and the name can supply one.
 * @param props - Code, its availability from the name, and the actions.
 * @returns The labeled code field.
 */
export function AgentCodeField({
  code,
  canUseName,
  problemId,
  isReadOnly,
  fieldRef,
  onCodeChange,
  onUseNameAsCode
}: AgentCodeFieldProps): ReactElement {
  const inputId = useId()
  const hintId = useId()

  return (
    <div className="settings-view__agent-field">
      <div className="settings-view__agent-field-top">
        <span className="settings-view__agent-field-label">
          <label htmlFor={inputId}>code</label>
          <span id={hintId}>optional · fixed once created</span>
        </span>
        <span className="settings-view__agent-field-label">
          {canUseName ? (
            <Button
              className="settings-view__agent-use-name"
              disabled={isReadOnly}
              onClick={onUseNameAsCode}
              size="sm"
              type="button"
              variant="ghost"
            >
              use name
            </Button>
          ) : null}
          <span>
            {code.length} / {MAXIMUM_AGENT_CODE_LENGTH}
          </span>
        </span>
      </div>
      <Input
        aria-describedby={buildFieldDescriptionIds(hintId, problemId)}
        aria-invalid={problemId !== undefined}
        autoComplete="off"
        className="settings-view__agent-mono"
        id={inputId}
        maxLength={MAXIMUM_AGENT_CODE_LENGTH}
        onChange={(event) => onCodeChange(event.currentTarget.value)}
        placeholder="leave empty to derive it from the name"
        readOnly={isReadOnly}
        ref={fieldRef}
        spellCheck={false}
        type="text"
        value={code}
      />
    </div>
  )
}

/** Properties accepted by {@link AgentPromptField}. */
export type AgentPromptFieldProps = {
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
 * Edits an agent's system prompt with its estimated size.
 *
 * @remarks Primary category: presentational. The parent owns the prompt and
 * accepts or ignores each proposal; the field owns no state or effects. The
 * textarea is labeled `system prompt` and described by its estimated size
 * and, while invalid, by the problem message. The size is a local estimate.
 * @param props - Prompt, window estimate, problem relationship, and action.
 * @returns The labeled prompt field.
 */
export function AgentPromptField({
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
        <label htmlFor={textareaId}>system prompt</label>
        <span>the model's instructions</span>
      </div>
      <Textarea
        aria-describedby={buildFieldDescriptionIds(measureId, problemId)}
        aria-invalid={problemId !== undefined}
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

/** Properties accepted by {@link AgentEditorFeedback}. */
export type AgentEditorFeedbackProps = {
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
 * @remarks Primary category: presentational. The parent owns the problem,
 * its identifier, and the activity; the component owns no state or effects.
 * The problem message exists only while there is a problem, so fields refer
 * to it only then. The pending status is a polite live region and the
 * failure an alert; both regions stay mounted so updates are announced.
 * @param props - Problem, its identifier, and the editor activity.
 * @returns The editor's feedback lines.
 */
export function AgentEditorFeedback({
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

/** Properties accepted by {@link StoredAgentActions}. */
export type StoredAgentActionsProps = {
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
 * @remarks Primary category: interactive feature. The parent owns the
 * activity and every action; the component owns only whether its Delete
 * button has been replaced by the confirmation, so that focus returns to
 * that button when the confirmation leaves. The confirmation is a group
 * named `Delete for good?`; focus starts on Keep, the least destructive
 * choice, and Escape inside it keeps the agent without closing the editor.
 * While a change is pending, every action is disabled.
 * @param props - Activity and the parent-owned actions.
 * @returns The stored agent's actions.
 */
export function StoredAgentActions({
  activity,
  onDuplicateAgent,
  onRequestAgentDeletion,
  onCancelAgentDeletion,
  onDeleteAgent
}: StoredAgentActionsProps): ReactElement {
  const [hasConfirmationOpened, setHasConfirmationOpened] = useState(false)
  const isPending =
    activity.status === "saving" || activity.status === "deleting"

  /** Asks whether to delete, remembering that focus must come back. */
  function handleRequestDeletion(): void {
    setHasConfirmationOpened(true)
    onRequestAgentDeletion()
  }

  /**
   * Keeps the agent when Escape is pressed inside the confirmation.
   *
   * @param event - Key press on either confirmation button.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return

    event.preventDefault()
    event.stopPropagation()
    onCancelAgentDeletion()
  }

  if (
    activity.status === "confirming-delete" ||
    activity.status === "deleting"
  ) {
    return (
      <fieldset
        aria-label="Delete for good?"
        className="settings-view__agent-confirm"
        disabled={isPending}
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

  return (
    <div className="settings-view__agent-actions">
      <Button
        disabled={isPending}
        onClick={handleRequestDeletion}
        ref={hasConfirmationOpened ? focusElementOnAttach : undefined}
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
 * @remarks Primary category: presentational. The parent owns the editor
 * state and both actions; the component owns no state or effects. Focus
 * moves to the back button when the component is attached, because the row
 * that opened it has left the screen. Reading is a polite status; a failure
 * is an alert with a Retry button.
 * @param props - Reading editor and the parent-owned actions.
 * @returns The read status with its way back.
 */
export function AgentReadStatus({
  editor,
  onCloseAgentEditor,
  onRetryAgent
}: AgentReadStatusProps): ReactElement {
  return (
    <div className="settings-view__agent-editor">
      <div className="settings-view__agent-editor-top">
        <Button
          aria-label="agents list"
          className="settings-view__agent-back"
          onClick={onCloseAgentEditor}
          ref={focusElementOnAttach}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ChevronLeft aria-hidden="true" />
          agents
        </Button>
        <span className="settings-view__agent-code">{editor.agentCode}</span>
      </div>
      {editor.status === "opening" ? (
        <p aria-live="polite" className="settings-view__note" role="status">
          Reading {editor.agentCode}…
        </p>
      ) : (
        <div className="settings-view__agent-status">
          <p className="settings-view__agent-problem" role="alert">
            {editor.error}
          </p>
          <Button
            onClick={onRetryAgent}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}

/** Properties accepted by {@link AgentEditor}. */
export type AgentEditorProps = {
  /** Editor whose draft is written, owned by the agent store. */
  readonly editor: DraftingAgentEditor
  /** Every listed agent, against which names and codes are checked. */
  readonly agents: readonly AgentSummary[]
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

/**
 * Builds the subject a draft is checked for.
 *
 * @param editor - Editor whose draft is written.
 * @returns A new agent with its typed code, or the stored agent's code.
 */
function buildAgentDraftSubject(
  editor: DraftingAgentEditor
): AgentDraftSubject {
  return editor.status === "creating"
    ? { kind: "new", code: editor.code }
    : { kind: "stored", code: editor.agent.code }
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
 * Focuses the editor field that a problem concerns.
 *
 * @param fieldRefs - Editor host elements.
 * @param field - Field to focus.
 */
function focusAgentDraftField(
  fieldRefs: AgentFieldRefs,
  field: AgentDraftField
): void {
  switch (field) {
    case "name":
      fieldRefs.name.current?.focus()
      return
    case "code":
      fieldRefs.code.current?.focus()
      return
    case "bio":
      fieldRefs.bio.current?.focus()
      return
    case "systemPrompt":
      fieldRefs.systemPrompt.current?.focus()
      return
  }
}

/**
 * Edits one agent's draft and saves, duplicates, or deletes it.
 *
 * @remarks Primary category: composition/view. The agent store owns the
 * draft, the save attempt, and every change; the application store supplies
 * the context estimate for the prompt measure; the parent supplies the
 * drafting editor and the listed agents, and gives each agent its own
 * instance. The editor is a form named after the agent, or `New agent`.
 * Focus moves to the name field when the editor is attached. Enter in a
 * one-line field or Command or Control with Enter anywhere submits; a draft
 * with a problem is not saved, its first problem is shown, and focus moves
 * to that field. Escape closes the editor, discarding the draft, unless a
 * change is pending; while one is, the fields are read-only and the actions
 * disabled.
 * @param props - Drafting editor and the listed agents.
 * @returns The agent editor form.
 */
export function AgentEditor({
  editor,
  agents
}: AgentEditorProps): ReactElement {
  const contextSize = useLysStore((state) => state.settings.model.contextSize)
  const updateAgentDraft = useAgentStore((state) => state.updateAgentDraft)
  const updateNewAgentCode = useAgentStore((state) => state.updateNewAgentCode)
  const saveAgentDraft = useAgentStore((state) => state.saveAgentDraft)
  const closeAgentEditor = useAgentStore((state) => state.closeAgentEditor)
  const nameFieldRef = useRef<HTMLInputElement>(null)
  const codeFieldRef = useRef<HTMLInputElement>(null)
  const bioFieldRef = useRef<HTMLInputElement>(null)
  const systemPromptFieldRef = useRef<HTMLTextAreaElement>(null)
  const problemId = useId()
  const { draft, activity } = editor
  const isPending =
    activity.status === "saving" || activity.status === "deleting"
  const isDraftChanged = isEditorDraftChanged(editor)
  const problem = editor.isSaveAttempted
    ? findAgentDraftProblem(draft, buildAgentDraftSubject(editor), agents)
    : undefined
  const problemField =
    problem === undefined ? undefined : calculateAgentDraftProblemField(problem)

  useEffect(() => {
    nameFieldRef.current?.focus()
  }, [nameFieldRef])

  /**
   * Saves the draft, moving focus to the first problem when it has one.
   *
   * @param event - Submission of the editor form; ignored unless the editor
   * is idle and its draft changed, as the Save button is.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (activity.status !== "idle" || !isDraftChanged) return

    const draftProblem = findAgentDraftProblem(
      draft,
      buildAgentDraftSubject(editor),
      agents
    )
    if (draftProblem !== undefined) {
      const fieldRefs: AgentFieldRefs = {
        name: nameFieldRef,
        code: codeFieldRef,
        bio: bioFieldRef,
        systemPrompt: systemPromptFieldRef
      }
      focusAgentDraftField(
        fieldRefs,
        calculateAgentDraftProblemField(draftProblem)
      )
    }
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
    if (event.key === "Escape" && !isPending) {
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
        agentCode={
          editor.status === "creating" ? editor.code : editor.agent.code
        }
        agentKind={editor.status === "creating" ? "new" : "yours"}
        isCloseEnabled={!isPending}
        isDraftChanged={isDraftChanged}
        onCloseAgentEditor={closeAgentEditor}
      />
      <AgentTextField
        fieldRef={nameFieldRef}
        isReadOnly={isPending}
        label="name"
        maximumLength={MAXIMUM_AGENT_NAME_LENGTH}
        onTextChange={(name) => updateAgentDraft({ ...draft, name })}
        placeholder="Reviewer"
        problemId={problemField === "name" ? problemId : undefined}
        text={draft.name}
      />
      {editor.status === "creating" ? (
        <AgentCodeField
          canUseName={
            editor.code === "" && calculateAgentCodeFromName(draft.name) !== ""
          }
          code={editor.code}
          fieldRef={codeFieldRef}
          isReadOnly={isPending}
          onCodeChange={updateNewAgentCode}
          onUseNameAsCode={() =>
            updateNewAgentCode(calculateAgentCodeFromName(draft.name))
          }
          problemId={problemField === "code" ? problemId : undefined}
        />
      ) : null}
      <AgentTextField
        fieldRef={bioFieldRef}
        isReadOnly={isPending}
        label="bio"
        maximumLength={MAXIMUM_AGENT_BIO_LENGTH}
        onTextChange={(bio) => updateAgentDraft({ ...draft, bio })}
        placeholder="One line on what this agent is for. For you, not the model."
        problemId={problemField === "bio" ? problemId : undefined}
        text={draft.bio}
      />
      <AgentPromptField
        contextSize={contextSize}
        fieldRef={systemPromptFieldRef}
        isReadOnly={isPending}
        onSystemPromptChange={(systemPrompt) =>
          updateAgentDraft({ ...draft, systemPrompt })
        }
        problemId={problemField === "systemPrompt" ? problemId : undefined}
        systemPrompt={draft.systemPrompt}
      />
      <AgentEditorFeedback
        activity={activity}
        problem={problem}
        problemId={problemId}
      />
      <AgentEditorFooter editor={editor} isDraftChanged={isDraftChanged} />
    </form>
  )
}

/** Properties accepted by {@link AgentEditorFooter}. */
export type AgentEditorFooterProps = {
  /** Editor whose draft is written, owned by the agent store. */
  readonly editor: DraftingAgentEditor
  /** Whether the draft holds changes that are not saved. */
  readonly isDraftChanged: boolean
}

/**
 * Presents the editor's actions: the stored agent's own, closing, and
 * saving.
 *
 * @remarks Primary category: composition/view. The agent store owns every
 * action; the parent supplies the editor and whether its draft changed, and
 * owns the form that the Save button submits. Close reads `Discard` while
 * the draft holds changes. Save reads `Create` for a new agent and is
 * enabled only for an idle editor with changes. While a change is pending,
 * every action is disabled.
 * @param props - Drafting editor and whether its draft changed.
 * @returns The editor footer.
 */
export function AgentEditorFooter({
  editor,
  isDraftChanged
}: AgentEditorFooterProps): ReactElement {
  const closeAgentEditor = useAgentStore((state) => state.closeAgentEditor)
  const duplicateAgent = useAgentStore((state) => state.duplicateAgent)
  const openAgentDeleteConfirmation = useAgentStore(
    (state) => state.openAgentDeleteConfirmation
  )
  const closeAgentDeleteConfirmation = useAgentStore(
    (state) => state.closeAgentDeleteConfirmation
  )
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const { activity } = editor
  const isPending =
    activity.status === "saving" || activity.status === "deleting"
  const isNew = editor.status === "creating"

  return (
    <div className="settings-view__agent-footer">
      {editor.status === "editing" ? (
        <StoredAgentActions
          activity={editor.activity}
          onCancelAgentDeletion={closeAgentDeleteConfirmation}
          onDeleteAgent={() => void deleteAgent()}
          onDuplicateAgent={duplicateAgent}
          onRequestAgentDeletion={openAgentDeleteConfirmation}
        />
      ) : null}
      <div className="settings-view__agent-actions settings-view__agent-actions--commit">
        <Button
          disabled={isPending}
          onClick={closeAgentEditor}
          size="sm"
          type="button"
          variant="outline"
        >
          {isDraftChanged ? "Discard" : "Close"}
        </Button>
        <Button
          disabled={!isDraftChanged || activity.status !== "idle"}
          size="sm"
          type="submit"
        >
          {isNew ? "Create" : "Save"}
        </Button>
      </div>
    </div>
  )
}
