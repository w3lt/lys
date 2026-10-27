import type { McpServerSettings, McpServerTransport } from "@lys/share"
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
import { Textarea } from "@/components/ui/textarea"
import {
  buildEmptyMcpServerDraft,
  buildMcpServerDraft,
  isMcpServerDraftChanged,
  parseMcpServerDraft,
  type McpDraftProblemEntries,
  type McpServerDraft,
  type McpServerDraftField,
  type McpServerDraftParse,
  type McpServerDraftProblemReport,
  type McpServerDraftProblems
} from "@/lib/models/mcp-server-draft"
import { parseMcpServerJson } from "@/lib/models/mcp-server-json"
import type { McpSettingsSaveState } from "@/lib/store/mcp-settings"

import { handleFocusTargetAttach } from "./focus-target"
import {
  McpServerDraftFields,
  type McpFieldRefs
} from "./McpServerEditorFields"
import {
  formatMcpDraftProblemSummaryHeading,
  formatMcpEditorHint,
  formatMcpEditorKind,
  formatMcpServerJsonMessage,
  listMcpDraftProblems,
  MCP_SERVER_JSON_HINT,
  type McpDraftProblemListing,
  type McpServerJsonMessage
} from "./mcp-presentation"

/** What the editor is open for: a new server, or a saved one. */
export type McpEditorTarget =
  | {
      /** A server that is not saved yet. */
      readonly kind: "new"
      /** How the new server runs when the editor opens. */
      readonly transport: McpServerTransport
    }
  | {
      /** A saved server. */
      readonly kind: "server"
      /** Its saved settings. */
      readonly server: McpServerSettings
    }

/** Key press of the editor that does something. */
type McpEditorShortcut = "close" | "save" | "none"

/** Example of a config the paste field accepts. */
const MCP_SERVER_JSON_PLACEHOLDER =
  '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }'

/** No field problem. */
const NO_FIELD_PROBLEMS: McpServerDraftProblems = Object.freeze({})

/** No row problem. */
const NO_PROBLEM_ENTRIES: McpDraftProblemEntries = Object.freeze({})

/** No problem shown, before the first save attempt or for a valid draft. */
const NO_PROBLEMS: McpServerDraftProblemReport = Object.freeze({
  problems: NO_FIELD_PROBLEMS,
  problemEntries: NO_PROBLEM_ENTRIES
})

/**
 * Builds the draft the editor opens with.
 *
 * @param target - What the editor is open for.
 * @returns An empty draft of the chosen transport for a new server, or the
 * saved server's draft.
 */
function buildTargetDraft(target: McpEditorTarget): McpServerDraft {
  switch (target.kind) {
    case "new":
      return buildEmptyMcpServerDraft(target.transport)
    case "server":
      return buildMcpServerDraft(target.server)
  }
}

/**
 * Finds the saved name of the server the editor is open for.
 *
 * @param target - What the editor is open for.
 * @returns The saved server's name, or undefined for a new server.
 */
function findMcpEditorServerName(target: McpEditorTarget): string | undefined {
  switch (target.kind) {
    case "new":
      return undefined
    case "server":
      return target.server.name
    default: {
      const unhandledTarget: never = target
      return unhandledTarget
    }
  }
}

/**
 * Builds the problems the editor shows.
 *
 * @param parse - Draft checked against the server rules and the other names.
 * @param saveAttemptCount - Number of save attempts so far.
 * @returns Each field's first problem, and the row input each list's
 * problem concerns, from the first save attempt on; none before it or while
 * the draft is valid.
 */
function buildShownProblems(
  parse: McpServerDraftParse,
  saveAttemptCount: number
): McpServerDraftProblemReport {
  if (saveAttemptCount === 0 || parse.status === "valid") return NO_PROBLEMS
  return parse
}

/**
 * Formats the failure of a save the editor sent.
 *
 * @param saveState - Latest save of the servers.
 * @param hasSentSave - Whether this editor sent a save.
 * @returns Why the latest save failed, once this editor sent one; otherwise
 * an empty string, so an earlier editor's failure is not shown.
 */
function formatSaveError(
  saveState: McpSettingsSaveState,
  hasSentSave: boolean
): string {
  if (!hasSentSave || saveState.status !== "failed") return ""
  return saveState.error
}

/**
 * Finds what a key press of the editor does.
 *
 * @param event - Key press bubbling from within the editor.
 * @returns `close` for Escape, `save` for ⌘ Enter or Ctrl Enter, and `none`
 * for any other key or while an input method composes text.
 */
function findEditorShortcut(
  event: KeyboardEvent<HTMLFormElement>
): McpEditorShortcut {
  if (event.nativeEvent.isComposing) return "none"
  if (event.key === "Escape") return "close"
  const isCommandEnter =
    event.key === "Enter" && (event.metaKey || event.ctrlKey)
  return isCommandEnter ? "save" : "none"
}

/**
 * Runs the editor shortcut a key press asks for: Escape closes the editor,
 * ⌘ Enter or Ctrl Enter submits it.
 *
 * @remarks Nothing happens while a save runs or for any other key; a handled
 * key's default action is prevented.
 * @param event - Key press bubbling from within the editor form.
 * @param isSaving - Whether a save runs.
 * @param onClose - Closes the editor, discarding the draft.
 */
function runMcpEditorShortcut(
  event: KeyboardEvent<HTMLFormElement>,
  isSaving: boolean,
  onClose: () => void
): void {
  const shortcut = findEditorShortcut(event)
  if (shortcut === "none" || isSaving) return
  event.preventDefault()
  if (shortcut === "close") onClose()
  else event.currentTarget.requestSubmit()
}

/**
 * Finds the control focus moves to for one field's problem.
 *
 * @param fieldRefs - Field hosts of the editor.
 * @param field - Field with the problem.
 * @returns For a list, the row input its problem concerns while one is
 * attached, otherwise the list's group; for another field, its input. Null
 * while that host is not attached.
 */
function findDraftFieldFocusTarget(
  fieldRefs: McpFieldRefs,
  field: McpServerDraftField
): HTMLElement | null {
  switch (field) {
    case "environment":
      return fieldRefs.environmentEntry.current ?? fieldRefs.environment.current
    case "headers":
      return fieldRefs.headersEntry.current ?? fieldRefs.headers.current
    case "name":
    case "command":
    case "arguments":
    case "url":
    case "token":
      return fieldRefs[field].current
  }
}

/**
 * Names the outcome a paste message shows.
 *
 * @param message - Outcome of the latest paste, or undefined before one.
 * @returns `filled`, `problem`, or `none` before a paste.
 */
function findPasteOutcome(message: McpServerJsonMessage | undefined): string {
  if (message === undefined) return "none"
  return message.isFilled ? "filled" : "problem"
}

/** Properties accepted by {@link McpJsonPasteOffer}. */
type McpJsonPasteOfferProps = {
  /** Whether the offer may not be taken. */
  readonly isReadOnly: boolean
  /** Whether its button takes focus when attached, after a close. */
  readonly isFocusedOnAttach: boolean
  /** Requests that the parent open the paste field. */
  readonly onOpen: () => void
}

/**
 * Offers to fill the fields from a config of another app.
 *
 * @remarks The parent owns whether the paste field is open; the offer owns
 * no state. Its button, `paste json`, takes focus when it is attached after
 * the person closed the field.
 * @param props - Read-only state, focus on attach, and the open action.
 * @returns The offer.
 */
function McpJsonPasteOffer({
  isReadOnly,
  isFocusedOnAttach,
  onOpen
}: McpJsonPasteOfferProps): ReactElement {
  return (
    <div className="settings-view__mcp-paste-offer">
      <p>
        Have a config from another app? Paste it and the fields fill themselves.
      </p>
      <button
        className="settings-view__mcp-text-button"
        disabled={isReadOnly}
        onClick={onOpen}
        ref={isFocusedOnAttach ? handleFocusTargetAttach : undefined}
        type="button"
      >
        paste json
      </button>
    </div>
  )
}

/** Properties accepted by {@link McpJsonPasteField}. */
type McpJsonPasteFieldProps = {
  /** Text as pasted or typed, owned by the parent. */
  readonly text: string
  /** Outcome of the latest paste, or undefined before one. */
  readonly message: McpServerJsonMessage | undefined
  /** Whether the text may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the proposed text on each edit. */
  readonly onTextChange: (text: string) => void
  /** Requests that the parent close the field. */
  readonly onClose: () => void
}

/**
 * Edits the pasted config and says what came of it.
 *
 * @remarks The parent owns the text and the outcome; the field owns no
 * state. It takes focus when it is attached. The outcome, or what the field
 * accepts before anything is pasted, is a polite status that describes it.
 * @param props - Text, outcome, read-only state, and the actions.
 * @returns The paste field.
 */
function McpJsonPasteField({
  text,
  message,
  isReadOnly,
  onTextChange,
  onClose
}: McpJsonPasteFieldProps): ReactElement {
  const fieldId = useId()
  const messageId = useId()

  return (
    <div className="settings-view__mcp-field">
      <div className="settings-view__mcp-field-top">
        <span className="settings-view__mcp-field-label">
          <label htmlFor={fieldId}>Paste JSON</label>
        </span>
        <button
          className="settings-view__mcp-text-button"
          onClick={onClose}
          type="button"
        >
          close
        </button>
      </div>
      <Textarea
        aria-describedby={messageId}
        className="settings-view__mcp-mono"
        id={fieldId}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        placeholder={MCP_SERVER_JSON_PLACEHOLDER}
        readOnly={isReadOnly}
        ref={handleFocusTargetAttach}
        spellCheck={false}
        value={text}
      />
      <p
        aria-live="polite"
        className="settings-view__mcp-paste-message"
        data-outcome={findPasteOutcome(message)}
        id={messageId}
        role="status"
      >
        {message?.text ?? MCP_SERVER_JSON_HINT}
      </p>
    </div>
  )
}

/** Properties accepted by {@link McpJsonPaste}. */
type McpJsonPasteProps = {
  /** Draft as it is now, owned by the parent. */
  readonly draft: McpServerDraft
  /** Whether the paste may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the draft filled from a pasted config. */
  readonly onDraftChange: (draft: McpServerDraft) => void
}

/**
 * Offers to fill a new server's fields from a config of another app.
 *
 * @remarks The parent owns the draft; the component owns whether the paste
 * field is open, its text, and the outcome of the latest paste. Opening the
 * field moves focus into it; closing it moves focus back to the button that
 * opens it. Each edit reads the text: a config that names a server fills
 * the draft, and the outcome is shown under the field.
 * @param props - Draft, read-only state, and the change action.
 * @returns The offer, or the open paste field.
 */
function McpJsonPaste({
  draft,
  isReadOnly,
  onDraftChange
}: McpJsonPasteProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [hasClosed, setHasClosed] = useState(false)
  const [text, setText] = useState("")
  const [message, setMessage] = useState<McpServerJsonMessage>()

  /**
   * Keeps the pasted text and fills the draft from it when it can.
   *
   * @param nextText - Text as typed or pasted.
   */
  function handleTextChange(nextText: string): void {
    setText(nextText)
    if (nextText.trim() === "") {
      setMessage(undefined)
      return
    }
    const parse = parseMcpServerJson(nextText, draft)
    setMessage(formatMcpServerJsonMessage(parse))
    if (parse.status === "filled") onDraftChange(parse.draft)
  }

  /** Closes the paste field; focus returns to the button that opens it. */
  function handleClose(): void {
    setIsOpen(false)
    setHasClosed(true)
  }

  if (!isOpen) {
    return (
      <McpJsonPasteOffer
        isFocusedOnAttach={hasClosed}
        isReadOnly={isReadOnly}
        onOpen={() => setIsOpen(true)}
      />
    )
  }
  return (
    <McpJsonPasteField
      isReadOnly={isReadOnly}
      message={message}
      onClose={handleClose}
      onTextChange={handleTextChange}
      text={text}
    />
  )
}

/** Properties accepted by {@link McpEditorTopBar}. */
type McpEditorTopBarProps = {
  /** What the editor is open for. */
  readonly target: McpEditorTarget
  /** Whether the person changed a saved server's draft. */
  readonly isChanged: boolean
  /** Whether a save runs, which disables the back button. */
  readonly isSaving: boolean
  /** Requests that the parent close the editor, discarding the draft. */
  readonly onClose: () => void
}

/**
 * Presents the way back to the servers, whether the draft is unsaved, and
 * what the editor is open for.
 *
 * @remarks The parent owns every value; the bar owns no state. The back
 * button is named by its visible text, `mcp servers`, after a chevron
 * hidden from assistive technology. The kind, `new server` or
 * `editing · <name>`, is the editor's heading.
 * @param props - Target, change and save states, and the close action.
 * @returns The top bar.
 */
function McpEditorTopBar({
  target,
  isChanged,
  isSaving,
  onClose
}: McpEditorTopBarProps): ReactElement {
  return (
    <div className="settings-view__mcp-editor-top">
      <button
        className="settings-view__mcp-back"
        disabled={isSaving}
        onClick={onClose}
        type="button"
      >
        <ChevronLeft aria-hidden="true" />
        mcp servers
      </button>
      <span className="settings-view__mcp-editor-tags">
        {isChanged ? (
          <span className="settings-view__mcp-unsaved">unsaved</span>
        ) : null}
        <h2 className="settings-view__mcp-editor-kind">
          {formatMcpEditorKind(findMcpEditorServerName(target))}
        </h2>
      </span>
    </div>
  )
}

/** Properties accepted by {@link McpDraftProblemSummary}. */
type McpDraftProblemSummaryProps = {
  /** Fields with a problem, in the editor's order; two or more. */
  readonly problems: readonly McpDraftProblemListing[]
  /** Host the parent moves focus to when a save is rejected. */
  readonly summaryRef: RefObject<HTMLFieldSetElement | null>
  /** Requests that the parent move focus to one field. */
  readonly onSelectField: (field: McpServerDraftField) => void
}

/**
 * Lists every field whose problem stopped a save, each leading to its field.
 *
 * @remarks The parent owns the problems, the host, and moving focus; the
 * summary owns no state. It is a group named by its heading, `Fix N fields
 * to save:`, that takes focus only programmatically. Each field is a button
 * named by the field's label and its problem, in the editor's order, that
 * asks the parent to move focus to the field's control.
 * @param props - Problems, the host, and the parent-owned focus move.
 * @returns The summary.
 */
function McpDraftProblemSummary({
  problems,
  summaryRef,
  onSelectField
}: McpDraftProblemSummaryProps): ReactElement {
  const headingId = useId()

  return (
    <fieldset
      aria-labelledby={headingId}
      className="settings-view__mcp-summary"
      ref={summaryRef}
      tabIndex={-1}
    >
      <h3 id={headingId}>
        {formatMcpDraftProblemSummaryHeading(problems.length)}
      </h3>
      <ul>
        {problems.map((listing) => (
          <McpDraftProblemItem
            key={listing.field}
            listing={listing}
            onSelectField={onSelectField}
          />
        ))}
      </ul>
    </fieldset>
  )
}

/** Properties accepted by {@link McpDraftProblemItem}. */
type McpDraftProblemItemProps = {
  /** Field and its problem. */
  readonly listing: McpDraftProblemListing
  /** Requests that the parent move focus to the field. */
  readonly onSelectField: (field: McpServerDraftField) => void
}

/**
 * Presents one field of the problem summary as a button leading to it.
 *
 * @remarks The list owner supplies the key; the item owns no state.
 * @param props - Field, its problem, and the parent-owned focus move.
 * @returns One list item.
 */
function McpDraftProblemItem({
  listing,
  onSelectField
}: McpDraftProblemItemProps): ReactElement {
  return (
    <li>
      <button
        className="settings-view__mcp-summary-link"
        onClick={() => onSelectField(listing.field)}
        type="button"
      >
        {listing.label}: {listing.problem}
      </button>
    </li>
  )
}

/** Hosts the editor moves focus to. */
type McpDraftFocusHosts = {
  /** Field hosts. */
  readonly fieldRefs: McpFieldRefs
  /** Problem summary host. */
  readonly summaryRef: RefObject<HTMLFieldSetElement | null>
}

/**
 * Owns the editor's field and summary hosts and moves focus to the one that
 * needs it.
 *
 * @remarks Focus moves to the name field when the editor appears. In the
 * layout phase after each save attempt, focus moves to the control of the
 * only field with a problem, which for a list is the row input its problem
 * concerns, when there is one, or the list's group; when several fields
 * have one, focus moves to the summary. An attempt without a problem leaves
 * focus where it is.
 * @param saveAttemptCount - Reactive count of the editor's save attempts.
 * @param problems - Problems shown in the current render, read when focus
 * moves.
 * @returns The hosts for the caller to attach. Each host ref keeps its
 * identity for the editor's lifetime; the record holding the field hosts is
 * rebuilt on every render.
 */
function useMcpDraftFocus(
  saveAttemptCount: number,
  problems: McpServerDraftProblems
): McpDraftFocusHosts {
  const problemListings = listMcpDraftProblems(problems)
  const nameRef = useRef<HTMLInputElement>(null)
  const commandRef = useRef<HTMLInputElement>(null)
  const argumentsRef = useRef<HTMLInputElement>(null)
  const environmentRef = useRef<HTMLFieldSetElement>(null)
  const environmentEntryRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef<HTMLInputElement>(null)
  const headersRef = useRef<HTMLFieldSetElement>(null)
  const headersEntryRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLFieldSetElement>(null)
  const fieldRefs: McpFieldRefs = {
    name: nameRef,
    command: commandRef,
    arguments: argumentsRef,
    environment: environmentRef,
    environmentEntry: environmentEntryRef,
    url: urlRef,
    token: tokenRef,
    headers: headersRef,
    headersEntry: headersEntryRef
  }
  const handleSaveAttempt = useEffectEvent((): void => {
    if (problemListings.length > 1) summaryRef.current?.focus()
    else if (problemListings.length === 1)
      findDraftFieldFocusTarget(fieldRefs, problemListings[0].field)?.focus()
  })

  useLayoutEffect(() => {
    nameRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (saveAttemptCount > 0) handleSaveAttempt()
  }, [saveAttemptCount])

  return { fieldRefs, summaryRef }
}

/** Save attempts of one editor and the submission that makes one. */
type McpEditorSave = {
  /** Number of save attempts so far, current for this render. */
  readonly saveAttemptCount: number
  /**
   * Why the latest save this editor sent failed, or an empty string before
   * it sent one, while one runs, or after one succeeded.
   */
  readonly saveError: string
  /** Handles a submission of the editor form; rebuilt on every render. */
  readonly handleSubmit: (event: FormEvent<HTMLFormElement>) => void
}

/**
 * Owns the editor's save attempts and whether it sent a save.
 *
 * @remarks The state lives as long as the editor instance; the parent gives
 * each target its own. `parse` and `saveState` are reactive: the result and
 * the submission handler read the values of the render that built them.
 * `onSaveServer` is a request invoked during a submission with a valid
 * server; it proposes a save that the application store runs and reports
 * through `saveState`. A submission while a save runs does nothing;
 * otherwise it prevents the browser's submission, counts an attempt, and
 * requests the save when the draft is valid.
 * @param parse - Draft checked against the server rules and the other names.
 * @param saveState - Latest save of the servers.
 * @param onSaveServer - Requests that the parent save a valid server.
 * @returns The attempt count, the save failure, and the submission handler.
 */
function useMcpEditorSave(
  parse: McpServerDraftParse,
  saveState: McpSettingsSaveState,
  onSaveServer: (server: McpServerSettings) => void
): McpEditorSave {
  const [saveAttemptCount, setSaveAttemptCount] = useState(0)
  const [hasSentSave, setHasSentSave] = useState(false)

  /**
   * Checks the draft and hands a valid one to the parent.
   *
   * @param event - Submission of the editor form.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (saveState.status === "saving") return
    setSaveAttemptCount((count) => count + 1)
    if (parse.status !== "valid") return
    setHasSentSave(true)
    onSaveServer(parse.server)
  }

  return {
    saveAttemptCount,
    saveError: formatSaveError(saveState, hasSentSave),
    handleSubmit
  }
}

/** Properties accepted by {@link McpServerEditorBody}. */
type McpServerEditorBodyProps = {
  /** Whether the editor is open for a new server, which can paste a config. */
  readonly isNew: boolean
  /** Draft as typed, owned by the parent. */
  readonly draft: McpServerDraft
  /** First problem of each field shown, owned by the parent. */
  readonly problems: McpServerDraftProblems
  /** Row input each shown list problem concerns, owned by the parent. */
  readonly problemEntries: McpDraftProblemEntries
  /** Field and summary hosts, owned by the parent. */
  readonly focusHosts: McpDraftFocusHosts
  /** Whether the draft may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the proposed draft on each edit or paste. */
  readonly onDraftChange: (draft: McpServerDraft) => void
}

/**
 * Presents what the editor edits: the paste offer for a new server, the
 * problem summary while two or more fields have a problem, and the fields.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the body
 * owns no state. A summary button moves focus to its field's control: for a
 * list, the row input its problem concerns, when there is one.
 * @param props - Whether the server is new, draft, problems and the row
 * inputs they concern, hosts, read-only state, and the change action.
 * @returns The editor's content between its top bar and its footer.
 */
function McpServerEditorBody({
  isNew,
  draft,
  problems,
  problemEntries,
  focusHosts,
  isReadOnly,
  onDraftChange
}: McpServerEditorBodyProps): ReactElement {
  const problemListings = listMcpDraftProblems(problems)

  return (
    <>
      {isNew ? (
        <McpJsonPaste
          draft={draft}
          isReadOnly={isReadOnly}
          onDraftChange={onDraftChange}
        />
      ) : null}
      {problemListings.length > 1 ? (
        <McpDraftProblemSummary
          onSelectField={(field) =>
            findDraftFieldFocusTarget(focusHosts.fieldRefs, field)?.focus()
          }
          problems={problemListings}
          summaryRef={focusHosts.summaryRef}
        />
      ) : null}
      <McpServerDraftFields
        draft={draft}
        fieldRefs={focusHosts.fieldRefs}
        isReadOnly={isReadOnly}
        onDraftChange={onDraftChange}
        problemEntries={problemEntries}
        problems={problems}
      />
    </>
  )
}

/** Properties accepted by {@link McpServerEditor}. */
export type McpServerEditorProps = {
  /** What the editor is open for; the parent gives each its own instance. */
  readonly target: McpEditorTarget
  /** Names of the other saved servers, which the name may not take. */
  readonly otherServerNames: ReadonlySet<string>
  /** Latest save of the servers, owned by the application store. */
  readonly saveState: McpSettingsSaveState
  /** Requests that the parent save the valid server. */
  readonly onSaveServer: (server: McpServerSettings) => void
  /** Requests that the parent close the editor, discarding the draft. */
  readonly onClose: () => void
}

/**
 * Edits one server's settings, or a new server's, and saves them.
 *
 * @remarks The component owns the draft it opened with and the draft, and,
 * through {@link useMcpEditorSave}, the number of save attempts and whether
 * it sent a save, so a failure of an earlier save is not shown; the parent
 * supplies the target, the other names, and the save, and gives each target
 * its own instance. The editor is a form named after the server, or `New
 * MCP server`; focus moves to the name field when it appears. A new
 * server's fields can be filled from a pasted config. A saved server whose
 * draft changed shows `unsaved`. Save, Enter in a one-line field, or ⌘
 * Enter checks the draft: the first problem of each field is shown from then
 * on, as the person types, the row input a list's problem concerns marked
 * invalid, and focus moves to the only field's control with one or, when
 * several have one, to a summary that lists them, shown while two or more
 * remain, whose buttons move focus to their field's control; a valid draft
 * is handed to the parent. Escape, Cancel, or the back button closes the
 * editor. While a save runs, the fields are read-only and the actions
 * disabled; a failed save is announced as an alert.
 * @param props - Target, other names, the save, and the parent's actions.
 * @returns The editor form.
 */
export function McpServerEditor({
  target,
  otherServerNames,
  saveState,
  onSaveServer,
  onClose
}: McpServerEditorProps): ReactElement {
  const [initialDraft] = useState(() => buildTargetDraft(target))
  const [draft, setDraft] = useState(initialDraft)
  const parse = parseMcpServerDraft(draft, otherServerNames)
  const isSaving = saveState.status === "saving"
  const save = useMcpEditorSave(parse, saveState, onSaveServer)
  const shownProblems = buildShownProblems(parse, save.saveAttemptCount)
  const focusHosts = useMcpDraftFocus(
    save.saveAttemptCount,
    shownProblems.problems
  )

  return (
    <form
      aria-label={findMcpEditorServerName(target) ?? "New MCP server"}
      className="settings-view__mcp-editor"
      noValidate
      onKeyDown={(event) => runMcpEditorShortcut(event, isSaving, onClose)}
      onSubmit={save.handleSubmit}
    >
      <McpEditorTopBar
        isChanged={
          target.kind === "server" &&
          isMcpServerDraftChanged(initialDraft, draft)
        }
        isSaving={isSaving}
        onClose={onClose}
        target={target}
      />
      <McpServerEditorBody
        draft={draft}
        focusHosts={focusHosts}
        isNew={target.kind === "new"}
        isReadOnly={isSaving}
        onDraftChange={setDraft}
        problemEntries={shownProblems.problemEntries}
        problems={shownProblems.problems}
      />
      <McpServerEditorFooter
        error={save.saveError}
        isNew={target.kind === "new"}
        isSaving={isSaving}
        onClose={onClose}
      />
    </form>
  )
}

/** Properties accepted by {@link McpServerEditorFooter}. */
type McpServerEditorFooterProps = {
  /** Why the latest save from this editor failed, or an empty string. */
  readonly error: string
  /** Whether the editor is open for a new server, which Save adds. */
  readonly isNew: boolean
  /** Whether a save runs, which disables both actions. */
  readonly isSaving: boolean
  /** Requests that the parent close the editor. */
  readonly onClose: () => void
}

/**
 * Presents how to save from the keyboard, the editor's save status, and its
 * actions: Cancel and Save, named Add server for a new server.
 *
 * @remarks The parent owns the form that Save submits, the save, and the
 * close action; the footer owns no state. The keyboard hint shows while
 * nothing else needs saying. The saving status is a polite live region and
 * a failed save an alert; both stay mounted so updates are announced.
 * @param props - Save failure, whether the server is new, the save, and the
 * close action.
 * @returns The editor footer.
 */
function McpServerEditorFooter({
  error,
  isNew,
  isSaving,
  onClose
}: McpServerEditorFooterProps): ReactElement {
  const isHintShown = !isSaving && error === ""

  return (
    <div className="settings-view__mcp-footer">
      <div className="settings-view__mcp-feedback">
        <p aria-live="polite" className="settings-view__note" role="status">
          {isSaving ? "Saving…" : ""}
        </p>
        <p className="settings-view__mcp-problem" role="alert">
          {error}
        </p>
        {isHintShown ? (
          <p className="settings-view__mcp-footer-hint">
            {formatMcpEditorHint(isNew)}
          </p>
        ) : null}
      </div>
      <div className="settings-view__mcp-actions">
        <Button
          disabled={isSaving}
          onClick={onClose}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={isSaving} size="sm" type="submit">
          {isNew ? "Add server" : "Save"}
        </Button>
      </div>
    </div>
  )
}
