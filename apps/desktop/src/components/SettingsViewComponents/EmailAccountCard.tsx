import type { EmailAccount, EmailPassword } from "@lys/share"
import { Eye } from "lucide-react"
import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  buildEmailAccountDraft,
  EMAIL_ACCOUNT_DRAFT_FIELDS,
  parseEmailAccountDraft,
  updateEmailAccountAddress,
  type EmailAccountDraft,
  type EmailAccountDraftField,
  type EmailAccountDraftProblems,
  type EmailServerDraft,
  type EmailServerSide
} from "@/lib/models/email-account-draft"
import type {
  EmailAccountCheckState,
  EmailAccountRemovalOutcome,
  EmailAccountSaveOutcome,
  EmailAccountSaveState
} from "@/lib/store/email-settings"

import {
  EMAIL_ACCOUNT_NOTE,
  EMAIL_ACCOUNT_REMOVAL_QUESTION,
  EMAIL_PASSWORD_KEPT_NOTE,
  EMAIL_SECURITIES,
  EMAIL_SENT_COPY_NOTE,
  findEmailSecurity,
  formatEmailAccountMessage,
  formatEmailPresetNote,
  formatEmailSecurityLabel,
  formatEmailServerSideLabel,
  type EmailAccountMessage
} from "./email-presentation"

/** Properties accepted by {@link EmailAccountCard}. */
type EmailAccountCardProps = {
  /** Saved account, or null when none is saved. */
  readonly savedAccount: EmailAccount | null
  /** Saved password, or null when none is saved; never shown. */
  readonly savedPassword: EmailPassword | null
  /** Latest save or removal, owned by the application store. */
  readonly saveState: EmailAccountSaveState
  /** Latest check, owned by the application store. */
  readonly checkState: EmailAccountCheckState
  /** Whether the backend is running, which signing in needs. */
  readonly isBackendRunning: boolean
  /**
   * Requests that the parent sign in with an account and save it with its
   * password. Resolves with the outcome once the save settled; never
   * rejects.
   */
  readonly onSaveEmailAccount: (
    account: EmailAccount,
    password: EmailPassword
  ) => Promise<EmailAccountSaveOutcome>
  /** Requests that the parent remove the saved account; same completion as a save. */
  readonly onRemoveEmailAccount: () => Promise<EmailAccountRemovalOutcome>
}

/** Attaches one field's input, so the card can move focus to it. */
type EmailFieldRef = (element: HTMLInputElement | null) => void

/** Properties accepted by {@link EmailTextField}. */
type EmailTextFieldProps = {
  /** Visible label of the field. */
  readonly label: string
  /** Identifier of the input, which its label names. */
  readonly fieldId: string
  /** Text in the field. */
  readonly text: string
  /** Why the text breaks a rule, or undefined. */
  readonly problem: string | undefined
  /**
   * Identifier of a note that also describes the input; omitted when the
   * problem is the only description.
   */
  readonly noteId?: string
  /** Autofill token of the input. */
  readonly autoComplete: string
  /** Keyboard offered for the input; omitted for text. */
  readonly inputMode?: "numeric"
  /** Attaches the input for the card's focus moves. */
  readonly fieldRef: EmailFieldRef
  /** Proposes new text for the field. */
  readonly onTextChange: (text: string) => void
  /**
   * Proposes discarding the card's edit on Escape; omitted while there is no
   * edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailPasswordField}. */
type EmailPasswordFieldProps = {
  /** Identifier of the input, which its label names. */
  readonly fieldId: string
  /** Text in the field. */
  readonly text: string
  /** Why the text breaks a rule, or undefined. */
  readonly problem: string | undefined
  /** Whether a password is saved, which an empty field keeps. */
  readonly hasSavedPassword: boolean
  /** Whether the password shows as text instead of bullets. */
  readonly isPasswordShown: boolean
  /** Attaches the input for the card's focus moves. */
  readonly fieldRef: EmailFieldRef
  /** Proposes new text for the field. */
  readonly onTextChange: (text: string) => void
  /** Proposes showing or hiding the password. */
  readonly onIsPasswordShownChange: (isPasswordShown: boolean) => void
  /**
   * Proposes discarding the card's edit on Escape; omitted while there is no
   * edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailServerFields}. */
type EmailServerFieldsProps = {
  /** Which server the fields hold. */
  readonly side: EmailServerSide
  /** Identifier prefix of the server's inputs. */
  readonly fieldIdPrefix: string
  /** The server's fields. */
  readonly server: EmailServerDraft
  /** First problem of each input that has one. */
  readonly problems: EmailAccountDraftProblems
  /** Attaches the host input for the card's focus moves. */
  readonly hostRef: EmailFieldRef
  /** Attaches the port input for the card's focus moves. */
  readonly portRef: EmailFieldRef
  /** Proposes new fields for the server. */
  readonly onServerChange: (server: EmailServerDraft) => void
  /**
   * Proposes discarding the card's edit on Escape in the host or port;
   * omitted while there is no edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailAccountFooter}. */
type EmailAccountFooterProps = {
  /** Identifier of the status line. */
  readonly statusId: string
  /** The line under the fields. */
  readonly message: EmailAccountMessage
  /** Whether an account is saved, which Remove account removes. */
  readonly hasSavedAccount: boolean
  /** Whether the fields differ from the saved account, which hides Remove account. */
  readonly isEdited: boolean
  /** Whether a check, save, or removal runs, which disables the actions. */
  readonly isBusy: boolean
  /** Whether Save is disabled. */
  readonly isSaveDisabled: boolean
  /** Whether the removal is being confirmed. */
  readonly isConfirmingRemoval: boolean
  /**
   * Attaches Remove account while it must take focus, after the
   * confirmation left without removing; omitted otherwise.
   */
  readonly removeAccountRef?: (element: HTMLButtonElement | null) => void
  /** Proposes confirming or ending the confirmation of the removal. */
  readonly onIsConfirmingRemovalChange: (isConfirmingRemoval: boolean) => void
  /** Requests that the card remove the saved account, after the person confirmed. */
  readonly onRemoveEmailAccount: () => void
}

/** Inputs of the card by field, as far as they are attached. */
type EmailFieldHosts = Partial<Record<EmailAccountDraftField, HTMLInputElement>>

/** No problem shown, before the first save attempt or for a valid draft. */
const NO_PROBLEMS: EmailAccountDraftProblems = Object.freeze({})

/** Bullets standing for the saved password in the empty password field. */
const PASSWORD_PLACEHOLDER = "••••••••"

/**
 * Handles a key press in one of the card's inputs by proposing to discard
 * the card's edit when the key is Escape.
 *
 * @param event - Key press in an input; an Escape that ends text
 * composition is ignored.
 * @param onDiscardEdit - Proposes discarding the card's edit; undefined
 * while there is no edit, which leaves Escape its native action.
 */
function handleFieldKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  onDiscardEdit: (() => void) | undefined
): void {
  if (event.key !== "Escape" || event.nativeEvent.isComposing) return
  if (onDiscardEdit === undefined) return

  event.preventDefault()
  onDiscardEdit()
}

/**
 * Presents one labelled text field of the account and, when its text
 * breaks a rule, what to change.
 *
 * @remarks The card owns the text; the field owns no state or effects. The
 * input is described by its problem, when it has one, then by the note
 * when there is one. Escape in the input proposes discarding the card's
 * edit, except an Escape that ends text composition.
 * @param props - Label, identifiers, text, problem, ref, and the proposals.
 * @returns The field.
 */
function EmailTextField({
  label,
  fieldId,
  text,
  problem,
  noteId,
  autoComplete,
  inputMode,
  fieldRef,
  onTextChange,
  onDiscardEdit
}: EmailTextFieldProps): ReactElement {
  const problemId = `${fieldId}-problem`
  const descriptionIds = [
    problem === undefined ? undefined : problemId,
    noteId
  ].filter((id) => id !== undefined)

  return (
    <div className="settings-view__email-field">
      <label htmlFor={fieldId}>{label}</label>
      <Input
        aria-describedby={
          descriptionIds.length === 0 ? undefined : descriptionIds.join(" ")
        }
        aria-invalid={problem === undefined ? undefined : true}
        autoComplete={autoComplete}
        id={fieldId}
        inputMode={inputMode}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => handleFieldKeyDown(event, onDiscardEdit)}
        ref={fieldRef}
        spellCheck={false}
        type="text"
        value={text}
      />
      {problem === undefined ? null : (
        <p className="settings-view__email-field-error" id={problemId}>
          {problem}
        </p>
      )}
    </div>
  )
}

/**
 * Presents the password field with its show and hide button and, when the
 * text breaks a rule, what to change.
 *
 * @remarks The card owns the text and whether the password is shown; the
 * field owns no state or effects. It starts empty; while a password is
 * saved, bullets stand for it and a note says an empty field keeps it. The
 * saved password is never put in the field. Escape in the input proposes
 * discarding the card's edit, except an Escape that ends text composition.
 * @param props - Identifier, text, problem, saved state, shown state, ref,
 * and the proposals.
 * @returns The field.
 */
function EmailPasswordField({
  fieldId,
  text,
  problem,
  hasSavedPassword,
  isPasswordShown,
  fieldRef,
  onTextChange,
  onIsPasswordShownChange,
  onDiscardEdit
}: EmailPasswordFieldProps): ReactElement {
  const problemId = `${fieldId}-problem`
  const noteId = `${fieldId}-note`
  const descriptionIds = [
    problem === undefined ? undefined : problemId,
    hasSavedPassword ? noteId : undefined
  ].filter((id) => id !== undefined)

  return (
    <div className="settings-view__email-field">
      <label htmlFor={fieldId}>Password</label>
      <div className="settings-view__secret-field">
        <Input
          aria-describedby={
            descriptionIds.length === 0 ? undefined : descriptionIds.join(" ")
          }
          aria-invalid={problem === undefined ? undefined : true}
          autoComplete="off"
          id={fieldId}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => handleFieldKeyDown(event, onDiscardEdit)}
          placeholder={hasSavedPassword ? PASSWORD_PLACEHOLDER : undefined}
          ref={fieldRef}
          spellCheck={false}
          type={isPasswordShown ? "text" : "password"}
          value={text}
        />
        <Button
          aria-label="Show password"
          aria-pressed={isPasswordShown}
          onClick={() => onIsPasswordShownChange(!isPasswordShown)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Eye aria-hidden="true" />
        </Button>
      </div>
      {problem === undefined ? null : (
        <p className="settings-view__email-field-error" id={problemId}>
          {problem}
        </p>
      )}
      {hasSavedPassword ? (
        <p className="settings-view__email-field-note" id={noteId}>
          {EMAIL_PASSWORD_KEPT_NOTE}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Presents the fields of one mail server: its host, port, and how the
 * connection is secured.
 *
 * @remarks The card owns the fields; the group owns no state or effects.
 * It is a group named by its legend, such as `IMAP server`. The security
 * is a single-choice toggle group named Security; pressing the chosen way
 * again proposes nothing. Escape in the host or port proposes discarding
 * the card's edit.
 * @param props - Side, identifiers, fields, problems, refs, and the
 * proposals.
 * @returns The group of fields.
 */
function EmailServerFields({
  side,
  fieldIdPrefix,
  server,
  problems,
  hostRef,
  portRef,
  onServerChange,
  onDiscardEdit
}: EmailServerFieldsProps): ReactElement {
  const securityLabelId = `${fieldIdPrefix}-security`

  /**
   * Proposes the way to secure the connection the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleSecurityValueChange(groupValue: string[]): void {
    const security = findEmailSecurity(groupValue)
    if (security !== undefined) onServerChange({ ...server, security })
  }

  return (
    <fieldset className="settings-view__email-server">
      <legend>{formatEmailServerSideLabel(side)}</legend>
      <EmailTextField
        autoComplete="off"
        fieldId={`${fieldIdPrefix}-host`}
        fieldRef={hostRef}
        label="Host"
        onDiscardEdit={onDiscardEdit}
        onTextChange={(host) => onServerChange({ ...server, host })}
        problem={problems[`${side}Host`]}
        text={server.host}
      />
      <EmailTextField
        autoComplete="off"
        fieldId={`${fieldIdPrefix}-port`}
        fieldRef={portRef}
        inputMode="numeric"
        label="Port"
        onDiscardEdit={onDiscardEdit}
        onTextChange={(port) => onServerChange({ ...server, port })}
        problem={problems[`${side}Port`]}
        text={server.port}
      />
      <div className="settings-view__email-security">
        <span id={securityLabelId}>Security</span>
        <ToggleGroup
          aria-labelledby={securityLabelId}
          onValueChange={handleSecurityValueChange}
          size="sm"
          value={[server.security]}
          variant="outline"
        >
          {EMAIL_SECURITIES.map((security) => (
            <ToggleGroupItem
              className="settings-view__tool-segment"
              key={security}
              value={security}
            >
              {formatEmailSecurityLabel(security)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </fieldset>
  )
}

/**
 * Presents the card's status line and its actions: Save, and Remove
 * account with its confirmation.
 *
 * @remarks The card owns every value, the confirmation, and the actions;
 * the footer owns no state or effects. The status line is a polite live
 * region. Remove account shows while an account is saved and the fields
 * are not edited; its confirmation asks the question, offers Keep and
 * Remove, named by their text and the account, starts focus on Keep, and
 * keeps the account on Escape. Every action is disabled while a check,
 * save, or removal runs. The card attaches Remove account for focus when
 * the confirmation left without removing.
 * @param props - Status identifier, message, saved and edited state, busy
 * state, confirmation, and the card-owned actions.
 * @returns The footer.
 */
function EmailAccountFooter({
  statusId,
  message,
  hasSavedAccount,
  isEdited,
  isBusy,
  isSaveDisabled,
  isConfirmingRemoval,
  removeAccountRef,
  onIsConfirmingRemovalChange,
  onRemoveEmailAccount
}: EmailAccountFooterProps): ReactElement {
  const questionId = `${statusId}-question`

  /**
   * Keeps the account when Escape is pressed on either choice.
   *
   * @param event - Key press on a confirmation button.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    onIsConfirmingRemovalChange(false)
  }

  return (
    <div className="settings-view__email-footer">
      <p
        aria-live="polite"
        className="settings-view__email-status"
        data-tone={message.tone}
        id={statusId}
        role="status"
      >
        {message.text}
      </p>
      {isConfirmingRemoval ? (
        <fieldset
          aria-labelledby={questionId}
          className="settings-view__mcp-confirm"
          disabled={isBusy}
        >
          <span id={questionId}>{EMAIL_ACCOUNT_REMOVAL_QUESTION}</span>
          <Button
            aria-label="Keep the email account"
            autoFocus
            onClick={() => onIsConfirmingRemovalChange(false)}
            onKeyDown={handleConfirmationKeyDown}
            size="sm"
            type="button"
            variant="outline"
          >
            Keep
          </Button>
          <Button
            aria-label="Remove the email account"
            onClick={onRemoveEmailAccount}
            onKeyDown={handleConfirmationKeyDown}
            size="sm"
            type="button"
            variant="destructive"
          >
            Remove
          </Button>
        </fieldset>
      ) : (
        <div className="settings-view__email-actions">
          {hasSavedAccount && !isEdited ? (
            <Button
              className="settings-view__mcp-remove"
              disabled={isBusy}
              onClick={() => onIsConfirmingRemovalChange(true)}
              ref={removeAccountRef}
              size="sm"
              type="button"
              variant="outline"
            >
              Remove account
            </Button>
          ) : null}
          <Button disabled={isSaveDisabled} size="sm" type="submit">
            Save
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Keeps the input of each field, so a rejected save can move focus to the
 * first input with a problem and a removal to the address.
 *
 * @remarks The hook owns the inputs it is told about through the refs it
 * returns, which React attaches and detaches; it reads them only when
 * asked to move focus. It returns the same operations each render; the
 * refs it builds are new each call, which React tolerates.
 * @returns A ref builder for each field, and the handlers of a rejected
 * save and of a removed account, which move focus.
 */
function useEmailFieldHosts() {
  const hosts = useRef<EmailFieldHosts>({})

  /**
   * Builds the ref that attaches one field's input.
   *
   * @param field - The field.
   * @returns The ref callback.
   */
  function buildFieldRef(field: EmailAccountDraftField): EmailFieldRef {
    return (element) => {
      if (element === null) delete hosts.current[field]
      else hosts.current[field] = element
    }
  }

  /**
   * Handles a save the fields' problems rejected, by moving focus to the
   * first input with a problem, in the card's order, when it is attached.
   *
   * @param problems - First problem of each input that has one.
   */
  function handleRejectedSave(problems: EmailAccountDraftProblems): void {
    const field = EMAIL_ACCOUNT_DRAFT_FIELDS.find(
      (candidate) => problems[candidate] !== undefined
    )
    if (field !== undefined) hosts.current[field]?.focus()
  }

  /**
   * Handles the removal of the saved account, by moving focus to the
   * address input, when it is attached.
   */
  function handleRemovedAccount(): void {
    hosts.current.address?.focus()
  }

  return { buildFieldRef, handleRejectedSave, handleRemovedAccount }
}

/**
 * Presents the email account card: its note, the address, names, and
 * password, the IMAP and SMTP servers, the Sent copy switch, the status
 * line, Save, and Remove account.
 *
 * @remarks The application store owns the saved account and password, the
 * save, and the check; the card owns only the person's edit, which starts
 * from the saved account, whether the password is shown, whether a save
 * was tried and with which edit, whether the removal is being confirmed,
 * and whether Remove account takes focus back after the confirmation left
 * without removing. Typing an address whose provider has a preset fills the server
 * fields and the Sent copy switch while they all still hold what an empty
 * card holds or the previous address's preset. Problems
 * show from the first Save on, each under its input, and a rejected Save
 * moves focus to the first input with a problem. Enter or Save asks the
 * parent to sign in and save when the fields hold a valid account that
 * differs from the saved one or a new password, no check, save, or removal
 * runs, and the backend runs; Save is disabled while nothing differs, while
 * a save runs, or while the backend is not running, which the status line
 * says. What the latest save or check found shows until the fields are
 * edited again, also when it ended while the card was not shown. Escape in
 * an input discards the edit while there is one. A save that
 * succeeded resets the edit unless the person changed the fields while it
 * ran. After a removal succeeds, focus moves to the address field, because
 * Remove leaves. The status line is a polite live region.
 * @param props - Saved account and password, save and check state, backend
 * status, and the requests.
 * @returns The card.
 */
export default function EmailAccountCard({
  savedAccount,
  savedPassword,
  saveState,
  checkState,
  isBackendRunning,
  onSaveEmailAccount,
  onRemoveEmailAccount
}: EmailAccountCardProps): ReactElement {
  const [editedDraft, setEditedDraft] = useState<EmailAccountDraft | null>(null)
  const [submittedDraft, setSubmittedDraft] =
    useState<EmailAccountDraft | null>(null)
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [isPasswordShown, setIsPasswordShown] = useState(false)
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false)
  const [isRemoveFocusedOnAttach, setIsRemoveFocusedOnAttach] = useState(false)
  const { buildFieldRef, handleRejectedSave, handleRemovedAccount } =
    useEmailFieldHosts()
  const cardId = useId()
  const statusId = `${cardId}-status`
  const presetId = `${cardId}-preset`
  const draft = editedDraft ?? buildEmailAccountDraft(savedAccount)
  const isEdited = editedDraft !== null
  const draftParse = parseEmailAccountDraft(draft, savedAccount, savedPassword)
  const problems =
    hasSubmitted && draftParse.status === "invalid"
      ? draftParse.problems
      : NO_PROBLEMS
  const presetNote = formatEmailPresetNote(draft)
  const isBusy =
    saveState.status === "saving" || checkState.status === "checking"
  const message = formatEmailAccountMessage({
    savedAccount,
    draftParse,
    hasSubmitted,
    isEditedSinceSubmit: editedDraft !== submittedDraft,
    saveState,
    checkState,
    isBackendRunning
  })

  /** Discards the edit, the tried save, and the shown password. */
  function resetEdit(): void {
    setEditedDraft(null)
    setSubmittedDraft(null)
    setHasSubmitted(false)
    setIsPasswordShown(false)
  }

  /**
   * Replaces the edit.
   *
   * @param next - Fields after the person's change.
   */
  function updateDraft(next: EmailAccountDraft): void {
    setEditedDraft(next)
  }

  /**
   * Signs in and saves the account and, once it is saved, resets the edit
   * when the fields still hold the draft it was read from.
   *
   * @param account - Valid account that differs from the saved one, or
   * the saved one with a new password.
   * @param password - Its password.
   * @param submittedDraft - Edit the account was read from; any later
   * change to the fields is a new edit, which the save keeps.
   */
  async function handleSaveAccount(
    account: EmailAccount,
    password: EmailPassword,
    submittedDraft: EmailAccountDraft | null
  ): Promise<void> {
    if ((await onSaveEmailAccount(account, password)) !== "saved") return
    setEditedDraft((current) => (current === submittedDraft ? null : current))
    setSubmittedDraft(null)
    setHasSubmitted(false)
    setIsPasswordShown(false)
  }

  /**
   * Asks the parent to sign in and save when the fields are valid and new,
   * or shows the problems and moves focus to the first of them.
   *
   * @param event - Submit event of the form.
   */
  function handleSubmitAccount(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isBusy || !isBackendRunning) return
    setSubmittedDraft(editedDraft)
    setHasSubmitted(true)
    if (draftParse.status === "invalid") {
      handleRejectedSave(draftParse.problems)
      return
    }
    if (draftParse.status === "changed") {
      void handleSaveAccount(
        draftParse.account,
        draftParse.password,
        editedDraft
      )
    }
  }

  /**
   * Confirms the removal, or ends the confirmation keeping the account,
   * after which Remove account takes focus back.
   *
   * @param isConfirming - Whether the removal is being confirmed.
   */
  function handleIsConfirmingRemovalChange(isConfirming: boolean): void {
    setIsConfirmingRemoval(isConfirming)
    if (!isConfirming) setIsRemoveFocusedOnAttach(true)
  }

  /**
   * Focuses Remove account once it returns after the confirmation, and
   * stops attaching it for focus.
   *
   * @param element - Attached button, or null when React detaches it,
   * which is ignored.
   */
  function handleRemoveAccountAttach(element: HTMLButtonElement | null): void {
    if (element === null) return
    element.focus()
    setIsRemoveFocusedOnAttach(false)
  }

  /**
   * Removes the saved account and moves focus to the address once it is
   * gone, or back to Remove account when the removal failed.
   */
  async function handleRemoveAccount(): Promise<void> {
    const outcome = await onRemoveEmailAccount()
    setIsConfirmingRemoval(false)
    if (outcome !== "saved") {
      setIsRemoveFocusedOnAttach(true)
      return
    }
    resetEdit()
    handleRemovedAccount()
  }

  return (
    <form
      aria-labelledby={`${cardId}-name`}
      className="settings-view__email-card"
      onSubmit={handleSubmitAccount}
    >
      <div className="settings-view__identity-lines">
        <h3 id={`${cardId}-name`}>Email account</h3>
        <p>{EMAIL_ACCOUNT_NOTE}</p>
      </div>
      <fieldset className="settings-view__email-fields" disabled={isBusy}>
        <EmailTextField
          autoComplete="email"
          fieldId={`${cardId}-address`}
          fieldRef={buildFieldRef("address")}
          label="Address"
          noteId={presetNote === "" ? undefined : presetId}
          onDiscardEdit={isEdited ? resetEdit : undefined}
          onTextChange={(address) =>
            updateDraft(updateEmailAccountAddress(draft, address))
          }
          problem={problems.address}
          text={draft.address}
        />
        {presetNote === "" ? null : (
          <p className="settings-view__email-field-note" id={presetId}>
            {presetNote}
          </p>
        )}
        <EmailTextField
          autoComplete="name"
          fieldId={`${cardId}-display-name`}
          fieldRef={buildFieldRef("displayName")}
          label="Display name"
          onDiscardEdit={isEdited ? resetEdit : undefined}
          onTextChange={(displayName) => updateDraft({ ...draft, displayName })}
          problem={problems.displayName}
          text={draft.displayName}
        />
        <EmailTextField
          autoComplete="username"
          fieldId={`${cardId}-user-name`}
          fieldRef={buildFieldRef("userName")}
          label="User name"
          onDiscardEdit={isEdited ? resetEdit : undefined}
          onTextChange={(userName) => updateDraft({ ...draft, userName })}
          problem={problems.userName}
          text={draft.userName}
        />
        <EmailPasswordField
          fieldId={`${cardId}-password`}
          fieldRef={buildFieldRef("password")}
          hasSavedPassword={savedPassword !== null}
          isPasswordShown={isPasswordShown}
          onDiscardEdit={isEdited ? resetEdit : undefined}
          onIsPasswordShownChange={setIsPasswordShown}
          onTextChange={(password) => updateDraft({ ...draft, password })}
          problem={problems.password}
          text={draft.password}
        />
        <div className="settings-view__email-servers">
          <EmailServerFields
            fieldIdPrefix={`${cardId}-imap`}
            hostRef={buildFieldRef("imapHost")}
            onDiscardEdit={isEdited ? resetEdit : undefined}
            onServerChange={(imap) => updateDraft({ ...draft, imap })}
            portRef={buildFieldRef("imapPort")}
            problems={problems}
            server={draft.imap}
            side="imap"
          />
          <EmailServerFields
            fieldIdPrefix={`${cardId}-smtp`}
            hostRef={buildFieldRef("smtpHost")}
            onDiscardEdit={isEdited ? resetEdit : undefined}
            onServerChange={(smtp) => updateDraft({ ...draft, smtp })}
            portRef={buildFieldRef("smtpPort")}
            problems={problems}
            server={draft.smtp}
            side="smtp"
          />
        </div>
        <div className="settings-view__email-switch-row">
          <div className="settings-view__identity-lines">
            <span className="settings-view__email-switch-label">
              Server keeps a copy of sent mail
            </span>
            <p id={`${cardId}-sent-copy-note`}>{EMAIL_SENT_COPY_NOTE}</p>
          </div>
          <Switch
            aria-describedby={`${cardId}-sent-copy-note`}
            aria-label="Server keeps a copy of sent mail"
            checked={draft.serverKeepsSentCopy}
            disabled={isBusy}
            onCheckedChange={(serverKeepsSentCopy) =>
              updateDraft({ ...draft, serverKeepsSentCopy })
            }
          />
        </div>
      </fieldset>
      <EmailAccountFooter
        hasSavedAccount={savedAccount !== null}
        isBusy={isBusy}
        isConfirmingRemoval={isConfirmingRemoval}
        isEdited={isEdited}
        isSaveDisabled={
          draftParse.status === "unchanged" || isBusy || !isBackendRunning
        }
        message={message}
        onIsConfirmingRemovalChange={handleIsConfirmingRemovalChange}
        onRemoveEmailAccount={() => void handleRemoveAccount()}
        removeAccountRef={
          isRemoveFocusedOnAttach ? handleRemoveAccountAttach : undefined
        }
        statusId={statusId}
      />
    </form>
  )
}
