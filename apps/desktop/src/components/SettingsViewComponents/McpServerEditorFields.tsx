import type { McpServerTransport } from "@lys/share"
import { Eye, Plus, X } from "lucide-react"
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  addMcpDraftEntry,
  MCP_SIGN_INS,
  removeMcpDraftEntry,
  updateMcpDraftEntry,
  type McpDraftEntry,
  type McpDraftEntryList,
  type McpServerDraft,
  type McpServerDraftField,
  type McpServerDraftProblems,
  type McpSignIn
} from "@/lib/models/mcp-server-draft"

import { handleFocusTargetAttach } from "./focus-target"
import {
  formatMcpDraftFieldLabel,
  formatMcpSignInLabel,
  formatMcpSignInNote,
  formatMcpToolNamePreview,
  getMcpEntryListPresentation,
  getMcpTransportPresentation,
  MCP_SERVER_NAME_RULE,
  MCP_SERVER_TRANSPORTS
} from "./mcp-presentation"

/** Field hosts of the editor, which the editor moves focus to. */
export type McpFieldRefs = {
  /** Name input. */
  readonly name: RefObject<HTMLInputElement | null>
  /** Command input, attached only for a command server. */
  readonly command: RefObject<HTMLInputElement | null>
  /** Arguments input, attached only for a command server. */
  readonly arguments: RefObject<HTMLInputElement | null>
  /** Group of variable rows, attached only for a command server. */
  readonly environment: RefObject<HTMLFieldSetElement | null>
  /** URL input, attached only for a URL server. */
  readonly url: RefObject<HTMLInputElement | null>
  /** Token input, attached only while a URL server signs in with a token. */
  readonly token: RefObject<HTMLInputElement | null>
  /** Group of header rows, attached only for a URL server. */
  readonly headers: RefObject<HTMLFieldSetElement | null>
}

/** Request that a control of a list of rows receive focus. */
type McpEntryFocusRequest =
  | {
      /** Focus stays where it is. */
      readonly kind: "none"
    }
  | {
      /** One row's name input receives focus when it is attached. */
      readonly kind: "entry"
      /** Identity of that row. */
      readonly entryId: number
    }
  | {
      /** The list's add button receives focus. */
      readonly kind: "add"
    }

/** What a field's label names. */
type McpFieldLabelTarget =
  | {
      /** The label names one control. */
      readonly kind: "control"
      /** Identifier of the control. */
      readonly controlId: string
    }
  | {
      /** The label names a group of controls, which refers to it. */
      readonly kind: "group"
      /** Identifier the label takes. */
      readonly labelId: string
    }

/** Focus request that leaves focus where it is. */
const NO_ENTRY_FOCUS: McpEntryFocusRequest = Object.freeze({ kind: "none" })

/**
 * Joins the identifiers of the elements that describe a control.
 *
 * @param ids - Identifiers, with undefined for a description not shown.
 * @returns The shown identifiers separated by spaces, or undefined when none
 * is shown.
 */
function joinDescriptionIds(
  ids: readonly (string | undefined)[]
): string | undefined {
  const shownIds = ids.filter((id) => id !== undefined)
  return shownIds.length === 0 ? undefined : shownIds.join(" ")
}

/**
 * Marks whether one row's value is shown.
 *
 * @param shownValueIds - Identities of the rows whose values are shown.
 * @param entryId - Identity of the row.
 * @param isShown - Whether its value is shown from now on.
 * @returns A new set with the row's identity added or removed.
 */
function markValueShown(
  shownValueIds: ReadonlySet<number>,
  entryId: number,
  isShown: boolean
): ReadonlySet<number> {
  const nextIds = new Set(shownValueIds)
  if (isShown) nextIds.add(entryId)
  else nextIds.delete(entryId)
  return nextIds
}

/** Properties accepted by {@link McpFieldTop}. */
type McpFieldTopProps = {
  /** Control or group the label names. */
  readonly target: McpFieldLabelTarget
  /** Visible label of the field. */
  readonly label: string
  /** Identifier of the hint, which describes the control or group. */
  readonly hintId: string
  /** Rule or format of the field, shown beside the label. */
  readonly hint: string
  /** Whether a server needs a value here, shown beside the label. */
  readonly isRequired: boolean
}

/**
 * Presents a field's label, whether it is required, and its hint on one
 * line.
 *
 * @remarks The parent owns every value; the component owns no state. A
 * control's label is a `label` element; a group's is a plain span that the
 * group refers to.
 * @param props - Label target, label, hint, and requirement.
 * @returns The label line.
 */
function McpFieldTop({
  target,
  label,
  hintId,
  hint,
  isRequired
}: McpFieldTopProps): ReactElement {
  return (
    <div className="settings-view__mcp-field-top">
      <span className="settings-view__mcp-field-label">
        {target.kind === "control" ? (
          <label htmlFor={target.controlId}>{label}</label>
        ) : (
          <span id={target.labelId}>{label}</span>
        )}
        {isRequired ? <span>required</span> : null}
      </span>
      <span id={hintId}>{hint}</span>
    </div>
  )
}

/** Properties accepted by {@link McpFieldProblem}. */
type McpFieldProblemProps = {
  /** Identifier the problem takes, which its control refers to. */
  readonly id: string
  /** Problem of the field, or undefined while it has none. */
  readonly problem: string | undefined
}

/**
 * Presents the problem of one field under its controls.
 *
 * @remarks The parent owns the problem; the component owns no state.
 * @param props - Identifier and problem.
 * @returns The problem paragraph, or nothing while the field has none.
 */
function McpFieldProblem({
  id,
  problem
}: McpFieldProblemProps): ReactElement | null {
  if (problem === undefined) return null
  return (
    <p className="settings-view__mcp-problem" id={id}>
      {problem}
    </p>
  )
}

/** Properties accepted by {@link McpTextField}. */
type McpTextFieldProps = {
  /** Field the input edits, which names its label. */
  readonly field: McpServerDraftField
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
  /** Line shown under the input, or empty for none. */
  readonly note: string
  /** Whether the text may be read but not changed. */
  readonly isReadOnly: boolean
  /** Input host the parent moves focus to. */
  readonly fieldRef: RefObject<HTMLInputElement | null>
  /** Receives the proposed text on each edit. */
  readonly onTextChange: (text: string) => void
}

/**
 * Edits one line of a server draft.
 *
 * @remarks The parent owns the text, the problem, and the host; the field
 * owns no state or effects. The input is labeled by the visible label and
 * described by the hint, which gives the field's rule or format before
 * entry, by the note under it, and, while the field has a problem, by the
 * problem, which also marks it invalid. A required field says so beside the
 * label and is marked required.
 * @param props - Field, hint, text, requirement, problem, note, host, and
 * the change action.
 * @returns The labeled field.
 */
function McpTextField({
  field,
  hint,
  text,
  isRequired,
  placeholder,
  problem,
  note,
  isReadOnly,
  fieldRef,
  onTextChange
}: McpTextFieldProps): ReactElement {
  const controlId = useId()
  const hintId = useId()
  const noteId = useId()
  const problemId = useId()

  return (
    <div className="settings-view__mcp-field">
      <McpFieldTop
        hint={hint}
        hintId={hintId}
        isRequired={isRequired}
        label={formatMcpDraftFieldLabel(field)}
        target={{ kind: "control", controlId }}
      />
      <Input
        aria-describedby={joinDescriptionIds([
          hintId,
          note === "" ? undefined : noteId,
          problem === undefined ? undefined : problemId
        ])}
        aria-invalid={problem !== undefined}
        aria-required={isRequired}
        autoComplete="off"
        className="settings-view__mcp-mono"
        id={controlId}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        placeholder={placeholder}
        readOnly={isReadOnly}
        ref={fieldRef}
        spellCheck={false}
        type="text"
        value={text}
      />
      {note === "" ? null : (
        <p className="settings-view__mcp-field-note" id={noteId}>
          {note}
        </p>
      )}
      <McpFieldProblem id={problemId} problem={problem} />
    </div>
  )
}

/** Properties accepted by {@link McpSecretInput}. */
type McpSecretInputProps = {
  /** Name of the input, such as `Value of variable 1`. */
  readonly inputLabel: string
  /** Name of the button that shows the secret, such as `Show token`. */
  readonly showLabel: string
  /** Secret as typed, owned by the parent. */
  readonly secret: string
  /** Example shown while the input is empty. */
  readonly placeholder: string
  /** Whether the secret is shown as text, owned by the parent. */
  readonly isShown: boolean
  /** Whether the secret may be read but not changed. */
  readonly isReadOnly: boolean
  /** Whether the secret breaks a rule of the field. */
  readonly isInvalid: boolean
  /** Identifiers of the elements that describe the input, or undefined. */
  readonly descriptionIds: string | undefined
  /** Input host the parent moves focus to, or undefined when none does. */
  readonly inputRef: RefObject<HTMLInputElement | null> | undefined
  /** Receives the proposed secret on each edit. */
  readonly onSecretChange: (secret: string) => void
  /** Receives whether the person asked to show the secret. */
  readonly onIsShownChange: (isShown: boolean) => void
}

/**
 * Edits a secret, hidden as dots until the person shows it.
 *
 * @remarks The parent owns the secret and whether it is shown; the input
 * owns no state. The show button is a toggle named by `showLabel` whose
 * pressed state says the secret is shown; it stays enabled while the secret
 * is read-only.
 * @param props - Names, secret, visibility, read-only state, descriptions,
 * host, and the change actions.
 * @returns The input and its show button.
 */
function McpSecretInput({
  inputLabel,
  showLabel,
  secret,
  placeholder,
  isShown,
  isReadOnly,
  isInvalid,
  descriptionIds,
  inputRef,
  onSecretChange,
  onIsShownChange
}: McpSecretInputProps): ReactElement {
  return (
    <div className="settings-view__mcp-secret">
      <Input
        aria-describedby={descriptionIds}
        aria-invalid={isInvalid}
        aria-label={inputLabel}
        autoComplete="off"
        className="settings-view__mcp-mono"
        onChange={(event) => onSecretChange(event.currentTarget.value)}
        placeholder={placeholder}
        readOnly={isReadOnly}
        ref={inputRef}
        spellCheck={false}
        type={isShown ? "text" : "password"}
        value={secret}
      />
      <Button
        aria-label={showLabel}
        aria-pressed={isShown}
        onClick={() => onIsShownChange(!isShown)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Eye aria-hidden="true" />
      </Button>
    </div>
  )
}

/** Properties accepted by {@link McpEntryRow}. */
type McpEntryRowProps = {
  /** Row as typed, owned by the parent. */
  readonly entry: McpDraftEntry
  /** What the row is called, such as `variable 1`. */
  readonly itemLabel: string
  /** Example name, shown while the name is empty. */
  readonly namePlaceholder: string
  /** Whether the value is shown as text, owned by the parent. */
  readonly isValueShown: boolean
  /** Whether the person just added the row, so its name takes focus. */
  readonly isJustAdded: boolean
  /** Whether the row may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the row with its name or value changed. */
  readonly onEntryChange: (entry: McpDraftEntry) => void
  /** Requests that the parent remove the row. */
  readonly onRemoveEntry: (entryId: number) => void
  /** Receives whether the person asked to show the value. */
  readonly onIsValueShownChange: (isShown: boolean) => void
}

/**
 * Edits one name and its value: a variable or a header.
 *
 * @remarks The parent owns the row, whether its value is shown, and its
 * removal; the row owns no state. Its controls are named after the row,
 * such as `Name of variable 1`, `Value of variable 1`, and `Remove variable
 * 1`. The name input takes focus when it is attached to a row the person
 * just added. While read-only, the remove button is disabled.
 * @param props - Row, its label, visibility, and the change actions.
 * @returns One list item.
 */
function McpEntryRow({
  entry,
  itemLabel,
  namePlaceholder,
  isValueShown,
  isJustAdded,
  isReadOnly,
  onEntryChange,
  onRemoveEntry,
  onIsValueShownChange
}: McpEntryRowProps): ReactElement {
  return (
    <li className="settings-view__mcp-entry">
      <Input
        aria-label={`Name of ${itemLabel}`}
        autoComplete="off"
        className="settings-view__mcp-mono"
        onChange={(event) =>
          onEntryChange({ ...entry, name: event.currentTarget.value })
        }
        placeholder={namePlaceholder}
        readOnly={isReadOnly}
        ref={isJustAdded ? handleFocusTargetAttach : undefined}
        spellCheck={false}
        type="text"
        value={entry.name}
      />
      <McpSecretInput
        descriptionIds={undefined}
        inputLabel={`Value of ${itemLabel}`}
        inputRef={undefined}
        isInvalid={false}
        isReadOnly={isReadOnly}
        isShown={isValueShown}
        onIsShownChange={onIsValueShownChange}
        onSecretChange={(value) => onEntryChange({ ...entry, value })}
        placeholder="value"
        secret={entry.value}
        showLabel={`Show value of ${itemLabel}`}
      />
      <Button
        aria-label={`Remove ${itemLabel}`}
        className="settings-view__mcp-entry-remove"
        disabled={isReadOnly}
        onClick={() => onRemoveEntry(entry.id)}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  )
}

/** Editing state and actions of one list of rows. */
type McpEntryRowsEditing = {
  /** Identities of the rows whose values are shown. */
  readonly shownValueIds: ReadonlySet<number>
  /** Identity of the row the person just added, or undefined. */
  readonly addedEntryId: number | undefined
  /** Adds an empty row with its value shown; its name takes focus. */
  readonly addEntry: () => void
  /** Replaces one row with its changed name or value. */
  readonly changeEntry: (entry: McpDraftEntry) => void
  /** Removes one row; the add button takes focus. */
  readonly removeEntry: (entryId: number) => void
  /** Shows or hides one row's value. */
  readonly showValue: (entryId: number, isShown: boolean) => void
}

/**
 * Owns which rows of one list show their values and where focus goes after
 * the person adds or removes a row.
 *
 * @remarks The state lives as long as the calling field; switching the
 * transport mounts another field with its own. Saved and pasted values
 * start hidden; a row the person adds starts with its value shown. `draft`,
 * `list`, and `onDraftChange` are reactive: each action uses those of the
 * render that built it. `onDraftChange` is a notification invoked during an
 * action with the proposed draft; the parent decides whether to keep it.
 * After a removal, a layout effect moves focus to the add button that the
 * caller attaches to `addButtonRef`, when it is attached. The actions are
 * rebuilt on every render; no identity is promised.
 * @param draft - Draft holding the list.
 * @param list - List the rows belong to.
 * @param addButtonRef - Add button host, owned by the caller.
 * @param onDraftChange - Receives the draft with a row added, changed, or
 * removed.
 * @returns The rows' editing state and actions.
 */
function useMcpEntryRows(
  draft: McpServerDraft,
  list: McpDraftEntryList,
  addButtonRef: RefObject<HTMLButtonElement | null>,
  onDraftChange: (draft: McpServerDraft) => void
): McpEntryRowsEditing {
  const [shownValueIds, setShownValueIds] = useState<ReadonlySet<number>>(
    () => new Set()
  )
  const [focusRequest, setFocusRequest] =
    useState<McpEntryFocusRequest>(NO_ENTRY_FOCUS)

  useLayoutEffect(() => {
    if (focusRequest.kind === "add") addButtonRef.current?.focus()
  }, [addButtonRef, focusRequest])

  /** Implements {@link McpEntryRowsEditing.addEntry}. */
  function addEntry(): void {
    const addition = addMcpDraftEntry(draft, list)
    onDraftChange(addition.draft)
    setShownValueIds((ids) => markValueShown(ids, addition.entryId, true))
    setFocusRequest({ kind: "entry", entryId: addition.entryId })
  }

  /**
   * Implements {@link McpEntryRowsEditing.removeEntry}.
   *
   * @param entryId - Identity of the row.
   */
  function removeEntry(entryId: number): void {
    onDraftChange(removeMcpDraftEntry(draft, list, entryId))
    setFocusRequest({ kind: "add" })
  }

  return {
    shownValueIds,
    addedEntryId:
      focusRequest.kind === "entry" ? focusRequest.entryId : undefined,
    addEntry,
    changeEntry: (entry) =>
      onDraftChange(updateMcpDraftEntry(draft, list, entry)),
    removeEntry,
    showValue: (entryId, isShown) =>
      setShownValueIds((ids) => markValueShown(ids, entryId, isShown))
  }
}

/** Properties accepted by {@link McpEntryRows}. */
type McpEntryRowsProps = {
  /** Rows of the list, owned by the parent. */
  readonly entries: readonly McpDraftEntry[]
  /** What one row is called, such as `variable`. */
  readonly itemName: string
  /** Example name, shown while a row's name is empty. */
  readonly namePlaceholder: string
  /** Whether the rows may be read but not changed. */
  readonly isReadOnly: boolean
  /** Editing state and actions of the rows, owned by the parent. */
  readonly editing: McpEntryRowsEditing
}

/**
 * Lists the rows of one list of names and values.
 *
 * @remarks The parent owns the rows and their editing state; the list owns
 * no state. Each row is named by its one-based position, such as `variable
 * 1`. Nothing is rendered while the list is empty.
 * @param props - Rows, their names, read-only state, and editing state.
 * @returns The list of rows, or nothing while it is empty.
 */
function McpEntryRows({
  entries,
  itemName,
  namePlaceholder,
  isReadOnly,
  editing
}: McpEntryRowsProps): ReactElement | null {
  if (entries.length === 0) return null
  return (
    <ul className="settings-view__mcp-entry-list">
      {entries.map((entry, index) => (
        <McpEntryRow
          entry={entry}
          isJustAdded={editing.addedEntryId === entry.id}
          isReadOnly={isReadOnly}
          isValueShown={editing.shownValueIds.has(entry.id)}
          itemLabel={`${itemName} ${index + 1}`}
          key={entry.id}
          namePlaceholder={namePlaceholder}
          onEntryChange={editing.changeEntry}
          onIsValueShownChange={(isShown) =>
            editing.showValue(entry.id, isShown)
          }
          onRemoveEntry={editing.removeEntry}
        />
      ))}
    </ul>
  )
}

/** Properties accepted by {@link McpEntryListField}. */
type McpEntryListFieldProps = {
  /** List the field edits. */
  readonly list: McpDraftEntryList
  /** Draft holding the list, owned by the parent. */
  readonly draft: McpServerDraft
  /** Problem of the list, or undefined while it has none. */
  readonly problem: string | undefined
  /** Whether the rows may be read but not changed. */
  readonly isReadOnly: boolean
  /** Group host the parent moves focus to. */
  readonly fieldRef: RefObject<HTMLFieldSetElement | null>
  /** Receives the draft with a row added, changed, or removed. */
  readonly onDraftChange: (draft: McpServerDraft) => void
}

/**
 * Edits one list of names and values: a command server's variables or a
 * URL server's headers.
 *
 * @remarks The parent owns the draft, the problem, and the host; the field
 * owns which rows show their values and where focus goes after the person
 * adds or removes a row, through {@link useMcpEntryRows}. The field is a
 * group named by its label and described by its hint and problem; it takes
 * focus only programmatically.
 * @param props - List, draft, problem, read-only state, host, and the change
 * action.
 * @returns The group of rows and its add button.
 */
function McpEntryListField({
  list,
  draft,
  problem,
  isReadOnly,
  fieldRef,
  onDraftChange
}: McpEntryListFieldProps): ReactElement {
  const labelId = useId()
  const hintId = useId()
  const problemId = useId()
  const presentation = getMcpEntryListPresentation(list)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const editing = useMcpEntryRows(draft, list, addButtonRef, onDraftChange)

  return (
    <fieldset
      aria-describedby={joinDescriptionIds([
        hintId,
        problem === undefined ? undefined : problemId
      ])}
      aria-labelledby={labelId}
      className="settings-view__mcp-field settings-view__mcp-entries"
      ref={fieldRef}
      tabIndex={-1}
    >
      <McpFieldTop
        hint={presentation.hint}
        hintId={hintId}
        isRequired={false}
        label={formatMcpDraftFieldLabel(list)}
        target={{ kind: "group", labelId }}
      />
      <McpEntryRows
        editing={editing}
        entries={draft[list]}
        isReadOnly={isReadOnly}
        itemName={presentation.itemName}
        namePlaceholder={presentation.namePlaceholder}
      />
      <button
        className="settings-view__mcp-entry-add"
        disabled={isReadOnly}
        onClick={editing.addEntry}
        ref={addButtonRef}
        type="button"
      >
        <Plus aria-hidden="true" />
        add {presentation.itemName}
      </button>
      <McpFieldProblem id={problemId} problem={problem} />
    </fieldset>
  )
}

/** Properties accepted by {@link McpSignInToggle}. */
type McpSignInToggleProps = {
  /** How Lys signs in, owned by the parent. */
  readonly signIn: McpSignIn
  /** Whether the choice may be read but not changed. */
  readonly isReadOnly: boolean
  /** Identifier of the label that names the choice. */
  readonly labelId: string
  /** Identifier of the note that describes the choice. */
  readonly noteId: string
  /** Receives the chosen way to sign in. */
  readonly onSignInChange: (signIn: McpSignIn) => void
}

/**
 * Chooses how Lys signs in to a URL server.
 *
 * @remarks The parent owns the choice; the toggle owns no state. It is a
 * single-choice toggle group named by the parent's label and described by
 * its note; pressing the chosen way again proposes nothing.
 * @param props - Choice, read-only state, label and note, and the change
 * action.
 * @returns The toggle group.
 */
function McpSignInToggle({
  signIn,
  isReadOnly,
  labelId,
  noteId,
  onSignInChange
}: McpSignInToggleProps): ReactElement {
  /**
   * Proposes the way to sign in that the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleSignInValueChange(groupValue: string[]): void {
    const [chosen] = groupValue
    const nextSignIn = MCP_SIGN_INS.find((option) => option === chosen)
    if (nextSignIn !== undefined) onSignInChange(nextSignIn)
  }

  return (
    <ToggleGroup
      aria-describedby={noteId}
      aria-labelledby={labelId}
      disabled={isReadOnly}
      onValueChange={handleSignInValueChange}
      size="sm"
      value={[signIn]}
      variant="outline"
    >
      {MCP_SIGN_INS.map((option) => (
        <ToggleGroupItem
          className="settings-view__tool-segment"
          key={option}
          value={option}
        >
          {formatMcpSignInLabel(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Properties accepted by {@link McpSignInChoice}. */
type McpSignInChoiceProps = {
  /** How Lys signs in, owned by the parent. */
  readonly signIn: McpSignIn
  /** Token as typed, owned by the parent. */
  readonly token: string
  /** Problem of the token, or undefined while it has none. */
  readonly problem: string | undefined
  /** Whether the choice and the token may be read but not changed. */
  readonly isReadOnly: boolean
  /** Token input host the parent moves focus to. */
  readonly tokenRef: RefObject<HTMLInputElement | null>
  /** Receives the chosen way to sign in. */
  readonly onSignInChange: (signIn: McpSignIn) => void
  /** Receives the proposed token on each edit. */
  readonly onTokenChange: (token: string) => void
}

/**
 * Chooses how Lys signs in to a URL server, and edits the token.
 *
 * @remarks The parent owns the choice, the token, and the problem; the
 * component owns only whether the token is shown, which starts hidden. The
 * choice is a single-choice toggle group named Sign-in and described by the
 * note of the chosen way; pressing the chosen way again proposes nothing.
 * While signing in with a token, the token input, named Token, follows the
 * note and is described by it and by the token's problem.
 * @param props - Choice, token, problem, read-only state, host, and the
 * change actions.
 * @returns The sign-in field.
 */
function McpSignInChoice({
  signIn,
  token,
  problem,
  isReadOnly,
  tokenRef,
  onSignInChange,
  onTokenChange
}: McpSignInChoiceProps): ReactElement {
  const labelId = useId()
  const noteId = useId()
  const problemId = useId()
  const [isTokenShown, setIsTokenShown] = useState(false)

  return (
    <div className="settings-view__mcp-field">
      <div className="settings-view__mcp-field-top">
        <span className="settings-view__mcp-field-label">
          <span id={labelId}>Sign-in</span>
        </span>
        <McpSignInToggle
          isReadOnly={isReadOnly}
          labelId={labelId}
          noteId={noteId}
          onSignInChange={onSignInChange}
          signIn={signIn}
        />
      </div>
      <p className="settings-view__mcp-field-note" id={noteId}>
        {formatMcpSignInNote(signIn)}
      </p>
      {signIn === "token" ? (
        <McpSecretInput
          descriptionIds={joinDescriptionIds([
            noteId,
            problem === undefined ? undefined : problemId
          ])}
          inputLabel={formatMcpDraftFieldLabel("token")}
          inputRef={tokenRef}
          isInvalid={problem !== undefined}
          isReadOnly={isReadOnly}
          isShown={isTokenShown}
          onIsShownChange={setIsTokenShown}
          onSecretChange={onTokenChange}
          placeholder="token"
          secret={token}
          showLabel="Show token"
        />
      ) : null}
      <McpFieldProblem id={problemId} problem={problem} />
    </div>
  )
}

/** Properties accepted by {@link McpTransportCards}. */
type McpTransportCardsProps = {
  /** Transport chosen, owned by the parent. */
  readonly transport: McpServerTransport
  /** Whether the choice may be read but not changed. */
  readonly isReadOnly: boolean
  /** Receives the chosen transport. */
  readonly onTransportChange: (transport: McpServerTransport) => void
}

/**
 * Chooses how the server runs: a local program Lys starts, or a remote
 * server Lys reaches by URL.
 *
 * @remarks The parent owns the transport; the choice owns no state. It is a
 * group of radio buttons named How it runs, each shown as a card, disabled
 * while the draft is read-only. Switching keeps what was typed for the other
 * transport.
 * @param props - Transport, read-only state, and the change action.
 * @returns The radio group.
 */
function McpTransportCards({
  transport,
  isReadOnly,
  onTransportChange
}: McpTransportCardsProps): ReactElement {
  const groupName = useId()

  return (
    <fieldset className="settings-view__mcp-transport" disabled={isReadOnly}>
      <legend className="settings-view__mcp-field-label">How it runs</legend>
      <div className="settings-view__mcp-transport-cards">
        {MCP_SERVER_TRANSPORTS.map((option) => (
          <McpTransportCard
            groupName={groupName}
            isChosen={option === transport}
            key={option}
            onTransportChange={onTransportChange}
            transport={option}
          />
        ))}
      </div>
    </fieldset>
  )
}

/** Properties accepted by {@link McpTransportCard}. */
type McpTransportCardProps = {
  /** Name shared by every radio button of the choice. */
  readonly groupName: string
  /** Transport the card stands for. */
  readonly transport: McpServerTransport
  /** Whether this transport is the chosen one. */
  readonly isChosen: boolean
  /** Receives this transport when the person chooses it. */
  readonly onTransportChange: (transport: McpServerTransport) => void
}

/**
 * Presents one transport as a card holding its radio button.
 *
 * @remarks The parent owns the chosen transport, the group's name, and its
 * read-only state; the card owns no state. The radio button is hidden from
 * sight but not from the keyboard; it is named by the transport's name and
 * described by its blurb, and the card shows its focus and choice.
 * @param props - Transport, its group, whether it is chosen, and the choice
 * action.
 * @returns The card.
 */
function McpTransportCard({
  groupName,
  transport,
  isChosen,
  onTransportChange
}: McpTransportCardProps): ReactElement {
  const nameId = useId()
  const blurbId = useId()
  const presentation = getMcpTransportPresentation(transport)

  return (
    <label className="settings-view__mcp-transport-card">
      <input
        aria-describedby={blurbId}
        aria-labelledby={nameId}
        checked={isChosen}
        className="settings-view__mcp-transport-radio"
        name={groupName}
        onChange={() => onTransportChange(transport)}
        type="radio"
        value={transport}
      />
      <span aria-hidden="true" className="settings-view__mcp-transport-ring" />
      <span className="settings-view__mcp-transport-text">
        <span className="settings-view__mcp-transport-title">
          <span id={nameId}>{presentation.name}</span>
          <span
            className="settings-view__mcp-transport-tag"
            data-transport={transport}
          >
            {presentation.tag}
          </span>
        </span>
        <span className="settings-view__mcp-transport-blurb" id={blurbId}>
          {presentation.blurb}
        </span>
      </span>
    </label>
  )
}

/** Properties accepted by {@link McpServerDraftFields}. */
export type McpServerDraftFieldsProps = {
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

/** Properties accepted by {@link McpCommandFields}. */
type McpCommandFieldsProps = McpServerDraftFieldsProps

/**
 * Edits a local program's command, arguments, and environment.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the
 * command and arguments own no state. The command is required. The
 * arguments are one line, split at spaces outside quotes. Environment
 * values can be secrets; the hint says they are saved in plain text. The
 * fields are rendered as siblings, without a wrapper.
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
}: McpCommandFieldsProps): ReactElement {
  return (
    <>
      <McpTextField
        field="command"
        fieldRef={fieldRefs.command}
        hint="the program Lys starts, by its full path"
        isReadOnly={isReadOnly}
        isRequired
        note=""
        onTextChange={(command) => onDraftChange({ ...draft, command })}
        placeholder="/opt/homebrew/bin/npx"
        problem={problems.command}
        text={draft.command}
      />
      <McpTextField
        field="arguments"
        fieldRef={fieldRefs.arguments}
        hint="space separated · quote paths with spaces"
        isReadOnly={isReadOnly}
        isRequired={false}
        note=""
        onTextChange={(argumentText) =>
          onDraftChange({ ...draft, argumentText })
        }
        placeholder="-y @modelcontextprotocol/server-github"
        problem={problems.arguments}
        text={draft.argumentText}
      />
      <McpEntryListField
        draft={draft}
        fieldRef={fieldRefs.environment}
        isReadOnly={isReadOnly}
        list="environment"
        onDraftChange={onDraftChange}
        problem={problems.environment}
      />
    </>
  )
}

/** Properties accepted by {@link McpUrlFields}. */
type McpUrlFieldsProps = McpServerDraftFieldsProps

/**
 * Edits a remote server's URL, sign-in, and headers.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the URL
 * owns no state. The URL is required. The token and header values can be
 * secrets; their notes say they are saved in plain text. The fields are
 * rendered as siblings, without a wrapper.
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
}: McpUrlFieldsProps): ReactElement {
  return (
    <>
      <McpTextField
        field="url"
        fieldRef={fieldRefs.url}
        hint="streamable http · https://, or http:// for localhost"
        isReadOnly={isReadOnly}
        isRequired
        note=""
        onTextChange={(url) => onDraftChange({ ...draft, url })}
        placeholder="https://mcp.example.com/mcp"
        problem={problems.url}
        text={draft.url}
      />
      <McpSignInChoice
        isReadOnly={isReadOnly}
        onSignInChange={(signIn) => onDraftChange({ ...draft, signIn })}
        onTokenChange={(token) => onDraftChange({ ...draft, token })}
        problem={problems.token}
        signIn={draft.signIn}
        token={draft.token}
        tokenRef={fieldRefs.token}
      />
      <McpEntryListField
        draft={draft}
        fieldRef={fieldRefs.headers}
        isReadOnly={isReadOnly}
        list="headers"
        onDraftChange={onDraftChange}
        problem={problems.headers}
      />
    </>
  )
}

/**
 * Edits every field of a server draft: how it runs, its name, and the
 * fields of its transport.
 *
 * @remarks The parent owns the draft, the problems, and the hosts; the
 * fields own no state beyond what their lists and token show. The name is
 * required; its hint states the name rule before entry and its note shows
 * the names the model calls the server's tools by. Only the chosen
 * transport's fields are shown; what was typed for the other transport
 * stays in the draft. The fields are rendered as siblings, without a
 * wrapper.
 * @param props - Draft, problems, read-only state, hosts, and the change
 * action.
 * @returns The draft's fields.
 */
export function McpServerDraftFields({
  draft,
  problems,
  isReadOnly,
  fieldRefs,
  onDraftChange
}: McpServerDraftFieldsProps): ReactElement {
  const TransportFields =
    draft.transport === "http" ? McpUrlFields : McpCommandFields

  return (
    <>
      <McpTransportCards
        isReadOnly={isReadOnly}
        onTransportChange={(transport) =>
          onDraftChange({ ...draft, transport })
        }
        transport={draft.transport}
      />
      <McpTextField
        field="name"
        fieldRef={fieldRefs.name}
        hint={MCP_SERVER_NAME_RULE}
        isReadOnly={isReadOnly}
        isRequired
        note={formatMcpToolNamePreview(draft.name)}
        onTextChange={(name) => onDraftChange({ ...draft, name })}
        placeholder="github"
        problem={problems.name}
        text={draft.name}
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
