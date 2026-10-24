import {
  MAXIMUM_MCP_SERVER_NAME_LENGTH,
  type McpServerSettings,
  type McpServerTransport
} from "@lys/share"
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
import {
  buildMcpServerDraft,
  EMPTY_MCP_SERVER_DRAFT,
  parseMcpServerDraft,
  type McpServerDraft,
  type McpServerDraftField,
  type McpServerDraftParse,
  type McpServerDraftProblems
} from "@/lib/models/mcp-server-draft"
import type { McpSettingsSaveState } from "@/lib/store/mcp-settings"

import {
  formatMcpDraftFieldLabel,
  formatMcpDraftProblemSummaryHeading,
  formatMcpServerTransportLabel,
  listMcpDraftProblems,
  MCP_SERVER_TRANSPORTS,
  type McpDraftProblemListing
} from "./mcp-presentation"

/** Rule of a server name, shown before entry. */
const MCP_SERVER_NAME_HINT = `up to ${MAXIMUM_MCP_SERVER_NAME_LENGTH} characters: lowercase letters and digits, joined by single hyphens`

/** Field hosts of the editor, which the editor moves focus to. */
type McpFieldRefs = {
  /** Name input. */
  readonly name: RefObject<HTMLInputElement | null>
  /** Command input, attached only for a command server. */
  readonly command: RefObject<HTMLInputElement | null>
  /** Arguments textarea, attached only for a command server. */
  readonly arguments: RefObject<HTMLTextAreaElement | null>
  /** Environment textarea, attached only for a command server. */
  readonly environment: RefObject<HTMLTextAreaElement | null>
  /** URL input, attached only for a URL server. */
  readonly url: RefObject<HTMLInputElement | null>
  /** Headers textarea, attached only for a URL server. */
  readonly headers: RefObject<HTMLTextAreaElement | null>
}

/** Properties every {@link McpDraftField} accepts. */
type McpDraftFieldCommonProps = {
  /** Visible label naming the field. */
  readonly label: string
  /** Rule or format of the field, shown beside the label. */
  readonly hint: string
  /** Text as typed, owned by the parent. */
  readonly text: string
  /** Whether a server needs a value here, shown beside the label. */
  readonly isRequired: boolean
  /** Example shown while the field is empty. */
  readonly placeholder: string
  /** Problem of the field, or undefined while it has none. */
  readonly problem: string | undefined
  /** Whether the text may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the proposed text on each edit. */
  readonly onTextChange: (text: string) => void
}

/** Properties accepted by {@link McpDraftField}. */
type McpDraftFieldProps = McpDraftFieldCommonProps &
  (
    | {
        /** The field takes one line. */
        readonly isMultiline: false
        /** Input host the parent moves focus to. */
        readonly fieldRef: RefObject<HTMLInputElement | null>
      }
    | {
        /** The field takes one item per line. */
        readonly isMultiline: true
        /** Textarea host the parent moves focus to. */
        readonly fieldRef: RefObject<HTMLTextAreaElement | null>
      }
  )

/**
 * Edits one field of a server draft.
 *
 * @remarks The parent owns the text, the problem, and the host; the field
 * owns no state or effects. The control is labeled by the visible label and
 * described by the hint, which gives the field's rule or format before
 * entry, and, while the field has a problem, by the problem, which also
 * marks it invalid. A required field says so beside the label and is marked
 * required. A multi-line field takes one item per line.
 * @param props - Label, hint, text, requirement, problem, host, and the
 * change action.
 * @returns The labeled field.
 */
function McpDraftField({
  label,
  hint,
  text,
  isRequired,
  placeholder,
  problem,
  isReadOnly,
  onTextChange,
  isMultiline,
  fieldRef
}: McpDraftFieldProps): ReactElement {
  const controlId = useId()
  const hintId = useId()
  const problemId = useId()
  const controlProps = {
    "aria-describedby":
      problem === undefined ? hintId : `${hintId} ${problemId}`,
    "aria-invalid": problem !== undefined,
    "aria-required": isRequired,
    autoComplete: "off",
    className: "settings-view__mcp-mono",
    id: controlId,
    placeholder,
    readOnly: isReadOnly,
    spellCheck: false,
    value: text
  }

  return (
    <div className="settings-view__mcp-field">
      <div className="settings-view__mcp-field-top">
        <span className="settings-view__mcp-field-label">
          <label htmlFor={controlId}>{label}</label>
          {isRequired ? <span>required</span> : null}
        </span>
        <span id={hintId}>{hint}</span>
      </div>
      {isMultiline ? (
        <Textarea
          {...controlProps}
          onChange={(event) => onTextChange(event.currentTarget.value)}
          ref={fieldRef}
        />
      ) : (
        <Input
          {...controlProps}
          onChange={(event) => onTextChange(event.currentTarget.value)}
          ref={fieldRef}
          type="text"
        />
      )}
      {problem === undefined ? null : (
        <p className="settings-view__mcp-problem" id={problemId}>
          {problem}
        </p>
      )}
    </div>
  )
}

/** Properties accepted by {@link McpTransportChoice}. */
type McpTransportChoiceProps = {
  /** Transport chosen, owned by the parent. */
  readonly transport: McpServerTransport
  /** Whether the choice may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the chosen transport. */
  readonly onTransportChange: (transport: McpServerTransport) => void
}

/**
 * Chooses how Lys reaches the server: a command it starts, or a URL.
 *
 * @remarks The parent owns the transport; the choice owns no state. It is a
 * group of radio buttons named Type, disabled while the draft is read-only.
 * Switching keeps what was typed for the other transport.
 * @param props - Transport, read-only state, and the change action.
 * @returns The radio group.
 */
function McpTransportChoice({
  transport,
  isReadOnly,
  onTransportChange
}: McpTransportChoiceProps): ReactElement {
  const groupName = useId()

  /**
   * Builds the radio button of one transport.
   *
   * @param option - Transport the button stands for.
   * @returns The transport's option, keyed by the transport.
   */
  function buildTransportOption(option: McpServerTransport): ReactElement {
    return (
      <McpTransportOption
        groupName={groupName}
        isChosen={transport === option}
        key={option}
        onChoose={onTransportChange}
        transport={option}
      />
    )
  }

  return (
    <fieldset className="settings-view__mcp-transport" disabled={isReadOnly}>
      <legend>Type</legend>
      {MCP_SERVER_TRANSPORTS.map(buildTransportOption)}
    </fieldset>
  )
}

/** Properties accepted by {@link McpTransportOption}. */
type McpTransportOptionProps = {
  /** Name shared by every radio button of the choice. */
  readonly groupName: string
  /** Whether this transport is the chosen one. */
  readonly isChosen: boolean
  /** Receives this transport when the person chooses it. */
  readonly onChoose: (transport: McpServerTransport) => void
  /** Transport this option stands for. */
  readonly transport: McpServerTransport
}

/**
 * Presents one transport of the choice as a labelled radio button.
 *
 * @remarks The parent owns the chosen transport and the group's name and
 * read-only state; the option owns no state.
 * @param props - Transport, its group, whether it is chosen, and the choice
 * action.
 * @returns The labelled radio button.
 */
function McpTransportOption({
  groupName,
  isChosen,
  onChoose,
  transport
}: McpTransportOptionProps): ReactElement {
  return (
    <label>
      <input
        checked={isChosen}
        name={groupName}
        onChange={() => onChoose(transport)}
        type="radio"
        value={transport}
      />
      {formatMcpServerTransportLabel(transport)}
    </label>
  )
}

/**
 * Properties accepted by {@link McpServerDraftFields}, {@link McpUrlFields},
 * and {@link McpCommandFields}.
 */
type McpDraftFieldsProps = {
  /** Draft being edited, owned by the parent. */
  readonly draft: McpServerDraft
  /** Problems shown, by field. */
  readonly problems: McpServerDraftProblems
  /** Whether the fields may be read but not changed. */
  readonly isReadOnly: boolean
  /** Field hosts the parent moves focus to. */
  readonly fieldRefs: McpFieldRefs
  /** Receives the draft with one field changed. */
  readonly onDraftChange: (draft: McpServerDraft) => void
}

/**
 * Edits a URL server's URL and headers.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the
 * fields own no state. The URL is required. Header values can be secrets;
 * the hint says they are saved in plain text. The fields are rendered as
 * siblings, without a wrapper.
 * @param props - Draft, problems, read-only state, hosts, and the change
 * action.
 * @returns The URL fields.
 */
function McpUrlFields({
  draft,
  problems,
  isReadOnly,
  fieldRefs,
  onDraftChange
}: McpDraftFieldsProps): ReactElement {
  return (
    <>
      <McpDraftField
        fieldRef={fieldRefs.url}
        hint="https://, or http:// for localhost"
        isMultiline={false}
        isReadOnly={isReadOnly}
        isRequired
        label={formatMcpDraftFieldLabel("url")}
        onTextChange={(url) => onDraftChange({ ...draft, url })}
        placeholder="https://mcp.example.com/mcp"
        problem={problems.url}
        text={draft.url}
      />
      <McpDraftField
        fieldRef={fieldRefs.headers}
        hint="Name: value, one per line · saved in plain text"
        isMultiline
        isReadOnly={isReadOnly}
        isRequired={false}
        label={formatMcpDraftFieldLabel("headers")}
        onTextChange={(headerLines) => onDraftChange({ ...draft, headerLines })}
        placeholder="Authorization: Bearer …"
        problem={problems.headers}
        text={draft.headerLines}
      />
    </>
  )
}

/**
 * Edits a command server's command, arguments, and environment.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the
 * fields own no state. The command is required. Environment values can be
 * secrets; the hint says they are saved in plain text. The fields are
 * rendered as siblings, without a wrapper.
 * @param props - Draft, problems, read-only state, hosts, and the change
 * action.
 * @returns The command fields.
 */
function McpCommandFields({
  draft,
  problems,
  isReadOnly,
  fieldRefs,
  onDraftChange
}: McpDraftFieldsProps): ReactElement {
  return (
    <>
      <McpDraftField
        fieldRef={fieldRefs.command}
        hint="full path, such as /opt/homebrew/bin/npx"
        isMultiline={false}
        isReadOnly={isReadOnly}
        isRequired
        label={formatMcpDraftFieldLabel("command")}
        onTextChange={(command) => onDraftChange({ ...draft, command })}
        placeholder="/opt/homebrew/bin/npx"
        problem={problems.command}
        text={draft.command}
      />
      <McpDraftField
        fieldRef={fieldRefs.arguments}
        hint="one per line"
        isMultiline
        isReadOnly={isReadOnly}
        isRequired={false}
        label={formatMcpDraftFieldLabel("arguments")}
        onTextChange={(argumentLines) =>
          onDraftChange({ ...draft, argumentLines })
        }
        placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
        problem={problems.arguments}
        text={draft.argumentLines}
      />
      <McpDraftField
        fieldRef={fieldRefs.environment}
        hint="NAME=value, one per line · saved in plain text"
        isMultiline
        isReadOnly={isReadOnly}
        isRequired={false}
        label={formatMcpDraftFieldLabel("environment")}
        onTextChange={(environmentLines) =>
          onDraftChange({ ...draft, environmentLines })
        }
        placeholder="LOG_LEVEL=warn"
        problem={problems.environment}
        text={draft.environmentLines}
      />
    </>
  )
}

/**
 * Edits every field of a server draft: its name, its transport, and the
 * fields of that transport.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the
 * fields own no state. The name is required, and its hint states the name
 * rule before entry. Only the chosen transport's fields are shown; what was
 * typed for the other transport stays in the draft. The fields are rendered
 * as siblings, without a wrapper.
 * @param props - Draft, problems, read-only state, hosts, and the change
 * action.
 * @returns The draft's fields.
 */
function McpServerDraftFields({
  draft,
  problems,
  isReadOnly,
  fieldRefs,
  onDraftChange
}: McpDraftFieldsProps): ReactElement {
  const TransportFields =
    draft.transport === "http" ? McpUrlFields : McpCommandFields

  return (
    <>
      <McpDraftField
        fieldRef={fieldRefs.name}
        hint={MCP_SERVER_NAME_HINT}
        isMultiline={false}
        isReadOnly={isReadOnly}
        isRequired
        label={formatMcpDraftFieldLabel("name")}
        onTextChange={(name) => onDraftChange({ ...draft, name })}
        placeholder="files"
        problem={problems.name}
        text={draft.name}
      />
      <McpTransportChoice
        isReadOnly={isReadOnly}
        onTransportChange={(transport) =>
          onDraftChange({ ...draft, transport })
        }
        transport={draft.transport}
      />
      <TransportFields
        draft={draft}
        fieldRefs={fieldRefs}
        isReadOnly={isReadOnly}
        onDraftChange={onDraftChange}
        problems={problems}
      />
    </>
  )
}

/** Properties accepted by {@link McpServerEditor}. */
export type McpServerEditorProps = {
  /** Saved settings of the server being edited, or undefined for a new one. */
  readonly server: McpServerSettings | undefined
  /** Names of the other saved servers, which the name may not take. */
  readonly otherServerNames: ReadonlySet<string>
  /** Latest save of the servers, owned by the application store. */
  readonly saveState: McpSettingsSaveState
  /** Requests that the parent save the valid server. */
  readonly onSaveServer: (server: McpServerSettings) => void
  /** Requests that the parent close the editor, discarding the draft. */
  readonly onClose: () => void
}

/** No problem shown, before the first save attempt or for a valid draft. */
const NO_PROBLEMS: McpServerDraftProblems = Object.freeze({})

/**
 * Selects the problems the editor shows.
 *
 * @param parse - Draft checked against the server rules and the other names.
 * @param saveAttemptCount - Number of save attempts so far.
 * @returns Each field's first problem from the first save attempt on; none
 * before it or while the draft is valid.
 */
function selectShownProblems(
  parse: McpServerDraftParse,
  saveAttemptCount: number
): McpServerDraftProblems {
  if (saveAttemptCount === 0 || parse.status === "valid") return NO_PROBLEMS
  return parse.problems
}

/** Properties accepted by {@link McpDraftProblemSummary}. */
type McpDraftProblemSummaryProps = {
  /** Fields with a problem, in the editor's order; two or more. */
  readonly problems: readonly McpDraftProblemListing[]
  /** Host the parent moves focus to when a save is rejected. */
  readonly summaryRef: RefObject<HTMLFieldSetElement | null>
  /** Requests that the parent move focus to one field. */
  readonly onFieldSelect: (field: McpServerDraftField) => void
}

/**
 * Lists every field whose problem stopped a save, each leading to its field.
 *
 * @remarks The parent owns the problems, the host, and moving focus; the
 * summary owns no state. It is a group named by its heading, `Fix N fields
 * to save:`, that takes focus only programmatically. Each field is a button
 * named by the field's label and its problem, in the editor's order.
 * @param props - Problems, the host, and the parent-owned focus move.
 * @returns The summary.
 */
function McpDraftProblemSummary({
  problems,
  summaryRef,
  onFieldSelect
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
            onFieldSelect={onFieldSelect}
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
  readonly onFieldSelect: (field: McpServerDraftField) => void
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
  onFieldSelect
}: McpDraftProblemItemProps): ReactElement {
  return (
    <li>
      <button
        className="settings-view__mcp-summary-link"
        onClick={() => onFieldSelect(listing.field)}
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
 * layout phase after each save attempt, focus moves to the only field with
 * a problem, or to the summary when several have one; an attempt without a
 * problem leaves focus where it is.
 * @param saveAttemptCount - Reactive count of the editor's save attempts.
 * @param problems - Fields with a problem shown in the current render, read
 * when focus moves.
 * @returns The hosts for the caller to attach. Each host ref keeps its
 * identity for the editor's lifetime; the record holding the field hosts is
 * rebuilt on every render.
 */
function useMcpDraftFocus(
  saveAttemptCount: number,
  problems: readonly McpDraftProblemListing[]
): McpDraftFocusHosts {
  const nameRef = useRef<HTMLInputElement>(null)
  const commandRef = useRef<HTMLInputElement>(null)
  const argumentsRef = useRef<HTMLTextAreaElement>(null)
  const environmentRef = useRef<HTMLTextAreaElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const headersRef = useRef<HTMLTextAreaElement>(null)
  const summaryRef = useRef<HTMLFieldSetElement>(null)
  const fieldRefs: McpFieldRefs = {
    name: nameRef,
    command: commandRef,
    arguments: argumentsRef,
    environment: environmentRef,
    url: urlRef,
    headers: headersRef
  }
  const handleSaveAttempt = useEffectEvent((): void => {
    if (problems.length > 1) summaryRef.current?.focus()
    else if (problems.length === 1)
      fieldRefs[problems[0].field].current?.focus()
  })

  useLayoutEffect(() => {
    nameRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (saveAttemptCount > 0) handleSaveAttempt()
  }, [saveAttemptCount])

  return { fieldRefs, summaryRef }
}

/**
 * Edits one server's settings, or a new server's, and saves them.
 *
 * @remarks The component owns the draft, the number of save attempts, and
 * whether it sent a save, so a failure of an earlier save is not shown;
 * the parent supplies the saved server, the other names, and the save, and
 * gives each server its own instance. The editor is a form named after the
 * server, or `New MCP server`; focus moves to the name field when it
 * appears. Save or Enter in a one-line field checks the draft: the first
 * problem of each field is shown from then on, as the person types, and
 * focus moves to the only field with one or, when several have one, to a
 * summary that lists them, shown while two or more remain, whose buttons
 * move focus to their field; a valid draft is handed to the parent. Escape
 * or Cancel closes the editor. While a save runs, the fields are read-only
 * and the actions disabled; a failed save is announced as an alert.
 * @param props - Server, other names, the save, and the parent's actions.
 * @returns The editor form.
 */
export function McpServerEditor({
  server,
  otherServerNames,
  saveState,
  onSaveServer,
  onClose
}: McpServerEditorProps): ReactElement {
  const [draft, setDraft] = useState<McpServerDraft>(() =>
    server === undefined ? EMPTY_MCP_SERVER_DRAFT : buildMcpServerDraft(server)
  )
  const [saveAttemptCount, setSaveAttemptCount] = useState(0)
  const [hasSentSave, setHasSentSave] = useState(false)
  const parse = parseMcpServerDraft(draft, otherServerNames)
  const isSaving = saveState.status === "saving"
  const problems = selectShownProblems(parse, saveAttemptCount)
  const problemListings = listMcpDraftProblems(problems)
  const { fieldRefs, summaryRef } = useMcpDraftFocus(
    saveAttemptCount,
    problemListings
  )
  const saveError =
    hasSentSave && saveState.status === "failed" ? saveState.error : ""

  /**
   * Checks the draft and hands a valid one to the parent.
   *
   * @param event - Submission of the editor form; ignored while a save runs.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSaving) return
    setSaveAttemptCount((count) => count + 1)
    if (parse.status !== "valid") return
    setHasSentSave(true)
    onSaveServer(parse.server)
  }

  /**
   * Closes the editor on Escape unless a save runs.
   *
   * @param event - Key press bubbling from within the editor.
   */
  function handleEditorKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return
    if (isSaving) return
    event.preventDefault()
    onClose()
  }

  return (
    <form
      aria-label={server?.name ?? "New MCP server"}
      className="settings-view__mcp-editor"
      noValidate
      onKeyDown={handleEditorKeyDown}
      onSubmit={handleSubmit}
    >
      <div className="settings-view__section-heading">
        <h2>{server === undefined ? "new server" : server.name}</h2>
        <span>{server === undefined ? "not saved" : "editing"}</span>
      </div>
      {problemListings.length > 1 ? (
        <McpDraftProblemSummary
          onFieldSelect={(field) => fieldRefs[field].current?.focus()}
          problems={problemListings}
          summaryRef={summaryRef}
        />
      ) : null}
      <McpServerDraftFields
        draft={draft}
        fieldRefs={fieldRefs}
        isReadOnly={isSaving}
        onDraftChange={setDraft}
        problems={problems}
      />
      <McpServerEditorFooter
        error={saveError}
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
  /** Whether a save runs, which disables both actions. */
  readonly isSaving: boolean
  /** Requests that the parent close the editor. */
  readonly onClose: () => void
}

/**
 * Presents the editor's save status and its actions: Cancel and Save.
 *
 * @remarks The parent owns the form that Save submits, the save, and the
 * close action; the footer owns no state. The saving status is a polite
 * live region and a failed save an alert; both stay mounted so updates are
 * announced.
 * @param props - Save failure, the save, and the close action.
 * @returns The editor footer.
 */
function McpServerEditorFooter({
  error,
  isSaving,
  onClose
}: McpServerEditorFooterProps): ReactElement {
  return (
    <div className="settings-view__mcp-footer">
      <div className="settings-view__mcp-feedback">
        <p aria-live="polite" className="settings-view__note" role="status">
          {isSaving ? "Saving…" : ""}
        </p>
        <p className="settings-view__mcp-problem" role="alert">
          {error}
        </p>
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
          Save
        </Button>
      </div>
    </div>
  )
}
