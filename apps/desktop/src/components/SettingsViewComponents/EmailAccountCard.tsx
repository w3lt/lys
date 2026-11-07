import type { EmailAccount, EmailPassword, EmailSecurity } from "@lys/share"
import { Eye } from "lucide-react"
import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  buildEmailAccountDraft,
  isEmailAccountDraftDifferent,
  parseEmailAccountDraft,
  updateEmailAccountAddress,
  type EmailAccountDraft,
  type EmailAccountDraftField,
  type EmailAccountDraftParse,
  type EmailAccountDraftProblems,
  type EmailServerDraft,
  type EmailServerSide
} from "@/lib/models/email-account-draft"
import {
  isEmailAccountCheckRunning,
  isEmailAccountSaved,
  isEmailAccountSaveRunning,
  type EmailAccountCheckState,
  type EmailAccountRemovalOutcome,
  type EmailAccountSaveOutcome,
  type EmailAccountSaveState
} from "@/lib/store/email-settings"

import {
  EMAIL_ACCOUNT_NOTE,
  EMAIL_ACCOUNT_REMOVAL_QUESTION,
  EMAIL_ADDRESS_HINT,
  EMAIL_DISPLAY_NAME_HINT,
  EMAIL_HOST_HINT,
  EMAIL_PASSWORD_HINT,
  EMAIL_PASSWORD_KEPT_NOTE,
  EMAIL_PORT_HINT,
  EMAIL_SECURITIES,
  EMAIL_SECURITY_HINT,
  EMAIL_SENT_COPY_NOTE,
  EMAIL_USER_NAME_HINT,
  findEmailSecurity,
  formatEmailAccountMessage,
  formatEmailPresetNote,
  formatEmailSecurityLabel,
  formatEmailServerSideLabel,
  listEmailDraftProblems,
  type EmailAccountMessage
} from "./email-presentation"
import { McpDraftProblemSummary } from "./McpDraftProblemSummary"

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

/** Host of one field's input, which the card moves focus to. */
type EmailFieldRef = RefObject<HTMLInputElement | null>

/** Hosts of the card's inputs, by field. */
type EmailFieldRefs = Readonly<Record<EmailAccountDraftField, EmailFieldRef>>

/** What a field's label names. */
type EmailFieldLabelTarget =
  | {
      /** The label names one input. */
      readonly kind: "control"
      /** Identifier of the input. */
      readonly controlId: string
    }
  | {
      /** The label names a group of controls, which refers to it. */
      readonly kind: "group"
      /** Identifier the label takes. */
      readonly labelId: string
    }

/** Properties accepted by {@link EmailFieldTop}. */
type EmailFieldTopProps = {
  /** Input or group the label names. */
  readonly target: EmailFieldLabelTarget
  /** Visible label of the field. */
  readonly label: string
  /** Whether the account needs a value here, shown beside the label. */
  readonly isRequired: boolean
  /** Identifier the hint takes, which the input or group refers to. */
  readonly hintId: string
  /** Rule of the field, shown beside the label before entry. */
  readonly hint: string
}

/** Properties accepted by {@link EmailFieldProblem}. */
type EmailFieldProblemProps = {
  /** Identifier the problem takes, which its input refers to. */
  readonly id: string
  /** Why the field's text breaks a rule, or undefined while it breaks none. */
  readonly problem: string | undefined
}

/** Properties accepted by {@link EmailFieldNote}. */
type EmailFieldNoteProps = {
  /** Identifier the note takes, which the input it explains refers to. */
  readonly id: string
  /** Note under the input, or empty for none. */
  readonly note: string
}

/** Properties accepted by {@link EmailTextField}. */
type EmailTextFieldProps = {
  /** Visible label of the field, which names the input. */
  readonly label: string
  /** Whether the account needs a value here, shown beside the label. */
  readonly isRequired: boolean
  /**
   * Rule of the field, shown beside the label before entry and describing
   * the input.
   */
  readonly hint: string
  /** Text in the field. */
  readonly text: string
  /** Why the text breaks a rule, or undefined. */
  readonly problem: string | undefined
  /**
   * Identifier of a note that also describes the input; omitted while no
   * note explains it.
   */
  readonly noteId?: string
  /** Autofill token of the input. */
  readonly autoComplete: string
  /** Keyboard offered for the input; omitted for text. */
  readonly inputMode?: "numeric"
  /** Host of the input, which the card moves focus to. */
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
  /** Text in the field. */
  readonly text: string
  /** Why the text breaks a rule, or undefined. */
  readonly problem: string | undefined
  /** Whether a password is saved, which an empty field keeps. */
  readonly hasSavedPassword: boolean
  /** Whether the password shows as text instead of bullets. */
  readonly isPasswordShown: boolean
  /** Host of the input, which the card moves focus to. */
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

/** Properties accepted by {@link EmailPasswordInput}. */
type EmailPasswordInputProps = {
  /** Identifier of the input, which the field's label names. */
  readonly fieldId: string
  /** Text in the input. */
  readonly text: string
  /** Identifiers of the elements that describe the input, or undefined. */
  readonly descriptionIds: string | undefined
  /** Whether the text breaks a rule. */
  readonly isInvalid: boolean
  /** Whether a password is saved, which an empty input keeps. */
  readonly hasSavedPassword: boolean
  /** Whether the password shows as text instead of bullets. */
  readonly isPasswordShown: boolean
  /** Host of the input, which the card moves focus to. */
  readonly fieldRef: EmailFieldRef
  /** Proposes new text for the input. */
  readonly onTextChange: (text: string) => void
  /** Proposes showing or hiding the password. */
  readonly onIsPasswordShownChange: (isPasswordShown: boolean) => void
  /**
   * Proposes discarding the card's edit on Escape; omitted while there is no
   * edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailSecurityChoice}. */
type EmailSecurityChoiceProps = {
  /** How the server's connection is secured. */
  readonly security: EmailSecurity
  /** Proposes another way to secure the connection. */
  readonly onSecurityChange: (security: EmailSecurity) => void
}

/** Properties accepted by {@link EmailServerFields}. */
type EmailServerFieldsProps = {
  /** Which server the fields hold. */
  readonly side: EmailServerSide
  /** The server's fields. */
  readonly server: EmailServerDraft
  /** First problem of each input that has one. */
  readonly problems: EmailAccountDraftProblems
  /** Host of the host input, which the card moves focus to. */
  readonly hostRef: EmailFieldRef
  /** Host of the port input, which the card moves focus to. */
  readonly portRef: EmailFieldRef
  /** Proposes new fields for the server. */
  readonly onServerChange: (server: EmailServerDraft) => void
  /**
   * Proposes discarding the card's edit on Escape in the host or port;
   * omitted while there is no edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailSentCopyField}. */
type EmailSentCopyFieldProps = {
  /** Whether the server keeps a copy of sent mail, as the fields hold it. */
  readonly serverKeepsSentCopy: boolean
  /** Whether a check, save, or removal runs, which disables the switch. */
  readonly isBusy: boolean
  /** Proposes whether the server keeps a copy of sent mail. */
  readonly onServerKeepsSentCopyChange: (serverKeepsSentCopy: boolean) => void
}

/** Properties accepted by {@link EmailIdentityFields}. */
type EmailIdentityFieldsProps = {
  /** The fields the card shows. */
  readonly draft: EmailAccountDraft
  /** First problem of each input that has one. */
  readonly problems: EmailAccountDraftProblems
  /** Hosts of the inputs, which the card moves focus to. */
  readonly fieldRefs: EmailFieldRefs
  /** Proposes new fields for the card. */
  readonly onDraftChange: (draft: EmailAccountDraft) => void
  /**
   * Proposes discarding the card's edit on Escape; omitted while there is no
   * edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailAccountServers}. */
type EmailAccountServersProps = {
  /** The fields the card shows. */
  readonly draft: EmailAccountDraft
  /** First problem of each input that has one. */
  readonly problems: EmailAccountDraftProblems
  /** Hosts of the inputs, which the card moves focus to. */
  readonly fieldRefs: EmailFieldRefs
  /** Whether a check, save, or removal runs, which disables the switch. */
  readonly isBusy: boolean
  /** Proposes new fields for the card. */
  readonly onDraftChange: (draft: EmailAccountDraft) => void
  /**
   * Proposes discarding the card's edit on Escape in a host or port;
   * omitted while there is no edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailAccountFields}. */
type EmailAccountFieldsProps = {
  /** The fields the card shows: the edit, or the saved account. */
  readonly draft: EmailAccountDraft
  /** First problem of each input that has one, shown from a tried save on. */
  readonly problems: EmailAccountDraftProblems
  /** Hosts of the inputs, which the card moves focus to. */
  readonly fieldRefs: EmailFieldRefs
  /** Host of the problem summary, which a rejected save moves focus to. */
  readonly summaryRef: RefObject<HTMLFieldSetElement | null>
  /** Whether a password is saved, which an empty password field keeps. */
  readonly hasSavedPassword: boolean
  /** Whether the password shows as text instead of bullets. */
  readonly isPasswordShown: boolean
  /** Whether a check, save, or removal runs, which disables every field. */
  readonly isBusy: boolean
  /** Proposes new fields for the card. */
  readonly onDraftChange: (draft: EmailAccountDraft) => void
  /** Proposes showing or hiding the password. */
  readonly onIsPasswordShownChange: (isPasswordShown: boolean) => void
  /** Requests that the card move focus to one field's input. */
  readonly onSelectField: (field: EmailAccountDraftField) => void
  /**
   * Proposes discarding the card's edit on Escape; omitted while there is no
   * edit, which leaves Escape its native action.
   */
  readonly onDiscardEdit?: () => void
}

/** Properties accepted by {@link EmailAccountRemovalQuestion}. */
type EmailAccountRemovalQuestionProps = {
  /** Whether a check, save, or removal runs, which disables both choices. */
  readonly isBusy: boolean
  /** Requests that the footer keep the account. */
  readonly onKeepEmailAccount: () => void
  /** Requests that the footer remove the account. */
  readonly onRemoveEmailAccount: () => void
}

/** Properties accepted by {@link EmailAccountFooter}. */
type EmailAccountFooterProps = {
  /** The line under the fields. */
  readonly message: EmailAccountMessage
  /**
   * Whether Remove account is offered: an account is saved and the fields
   * show it unedited.
   */
  readonly isRemovalOffered: boolean
  /** Whether a check, save, or removal runs, which disables the actions. */
  readonly isBusy: boolean
  /** Whether Save is disabled. */
  readonly isSaveDisabled: boolean
  /**
   * Requests that the parent remove the saved account, after the person
   * confirmed. Resolves with the outcome once the removal settled; never
   * rejects.
   */
  readonly onRemoveEmailAccount: () => Promise<EmailAccountRemovalOutcome>
  /**
   * Reports to the card that the removal of the account was saved, after the
   * question closed.
   */
  readonly onRemoveEmailAccountComplete: () => void
}

/**
 * Where the removal of the saved account stands: `idle` while the actions
 * show; `confirming` while the question whether to remove shows in their
 * place, also while the removal runs; `returning` once the question closed
 * without a removal, until Remove account is attached again and takes
 * focus.
 */
type EmailAccountRemovalStep = "idle" | "confirming" | "returning"

/** The footer's removal of the saved account and the requests that move it. */
type EmailAccountRemoval = {
  /** Where the removal stands. */
  readonly removalStep: EmailAccountRemovalStep
  /** Opens the question whether to remove the account. */
  readonly openRemovalQuestion: () => void
  /** Closes the question keeping the account; Remove account takes focus. */
  readonly closeRemovalQuestion: () => void
  /**
   * Requests the removal and closes the question once it settled. Resolves
   * after the step moved; never rejects.
   */
  readonly handleRemoveAccount: () => Promise<void>
  /** Attaches Remove account while it must take focus; undefined otherwise. */
  readonly removeAccountRef:
    ((element: HTMLButtonElement | null) => void) | undefined
}

/** Hosts the card moves focus to, and the focus moves it makes. */
type EmailFieldFocusHosts = {
  /**
   * Hosts of each field's input; each keeps its identity for the card's
   * lifetime, and the record holding them is rebuilt on every render.
   */
  readonly fieldRefs: EmailFieldRefs
  /** Host of the problem summary; the same for the card's lifetime. */
  readonly summaryRef: RefObject<HTMLFieldSetElement | null>
  /** Handles a summary button's choice of a field, by moving focus to it. */
  readonly handleFieldSelect: (field: EmailAccountDraftField) => void
  /** Handles the removal of the account, by moving focus to the address. */
  readonly handleRemovedAccount: () => void
}

/** The save the person tried since the card's edit last started afresh. */
type EmailAccountSaveTry =
  | {
      /** No save was tried. */
      readonly status: "none"
    }
  | {
      /** A save was tried. */
      readonly status: "tried"
      /**
       * Edit the save was tried with, or null when the fields showed the
       * saved account.
       */
      readonly draft: EmailAccountDraft | null
    }

/** The card's own state: the person's edit and what the card did with it. */
type EmailAccountEdit = {
  /** The person's edit, or null while the fields show the saved account. */
  readonly editedDraft: EmailAccountDraft | null
  /** The save tried last, from which the fields' problems are shown. */
  readonly saveTry: EmailAccountSaveTry
  /** Whether the password shows as text instead of bullets. */
  readonly isPasswordShown: boolean
  /** How many saves the fields' problems rejected; it never goes down. */
  readonly rejectedSaveCount: number
}

/** One change to the card's own state. */
type EmailAccountEditChange =
  | {
      /** The person changed the fields. */
      readonly kind: "edited"
      /** Fields after the change. */
      readonly draft: EmailAccountDraft
    }
  | {
      /** The edit was discarded, on Escape or after a removal. */
      readonly kind: "reset"
    }
  | {
      /** The person showed or hid the password. */
      readonly kind: "password-shown"
      /** Whether the password shows as text from now on. */
      readonly isPasswordShown: boolean
    }
  | {
      /** A save was tried. */
      readonly kind: "save-tried"
      /** Whether the fields' problems rejected it. */
      readonly isRejected: boolean
    }
  | {
      /** A tried save succeeded. */
      readonly kind: "saved"
      /** Edit the save was tried with, or null for the saved account. */
      readonly triedDraft: EmailAccountDraft | null
    }

/** Facts the card's edit is read against; all reactive. */
type EmailAccountEditFacts = Pick<
  EmailAccountCardProps,
  | "savedAccount"
  | "savedPassword"
  | "saveState"
  | "checkState"
  | "isBackendRunning"
>

/** What the card shows of its edit in one render. */
type EmailAccountEditView = {
  /** Fields the card shows: the edit, or the saved account while none. */
  readonly draft: EmailAccountDraft
  /** First problem of each input that has one, shown from a tried save on. */
  readonly problems: EmailAccountDraftProblems
  /** Whether the fields hold an edit. */
  readonly isEdited: boolean
  /** Whether the password shows as text instead of bullets. */
  readonly isPasswordShown: boolean
  /** Reactive count of the saves the fields' problems rejected. */
  readonly rejectedSaveCount: number
  /** Whether a check, save, or removal runs. */
  readonly isBusy: boolean
  /** Whether Save is disabled. */
  readonly isSaveDisabled: boolean
  /** The line under the fields. */
  readonly message: EmailAccountMessage
}

/** One render's reading of the card's edit. */
type EmailAccountEditReading = {
  /** What the card shows. */
  readonly view: EmailAccountEditView
  /** The fields checked against the account rules and the saved account. */
  readonly draftParse: EmailAccountDraftParse
  /** Whether a submission can save: nothing runs and the backend does. */
  readonly canSubmit: boolean
}

/** The card's edit as one render shows it, and the requests that change it. */
type EmailAccountEditing = EmailAccountEditView & {
  /** Proposes new fields. */
  readonly updateDraft: (draft: EmailAccountDraft) => void
  /** Discards the edit, the tried save, and the shown password. */
  readonly resetEdit: () => void
  /** Proposes showing or hiding the password. */
  readonly handleIsPasswordShownChange: (isPasswordShown: boolean) => void
  /** Handles a submission of the card's form. */
  readonly handleSubmit: (event: FormEvent<HTMLFormElement>) => void
}

/** No problem shown, before the first save attempt or for a valid draft. */
const NO_PROBLEMS: EmailAccountDraftProblems = Object.freeze({})

/** Bullets standing for the saved password in the empty password field. */
const PASSWORD_PLACEHOLDER = "••••••••"

/** No save tried since the edit last started afresh. */
const NO_SAVE_TRY: EmailAccountSaveTry = Object.freeze({ status: "none" })

/** The card's own state before the person changes anything. */
const INITIAL_EMAIL_ACCOUNT_EDIT: EmailAccountEdit = Object.freeze({
  editedDraft: null,
  saveTry: NO_SAVE_TRY,
  isPasswordShown: false,
  rejectedSaveCount: 0
})

/** The change that discards the edit. */
const RESET_EDIT: EmailAccountEditChange = Object.freeze({ kind: "reset" })

/**
 * Builds the identifiers of the elements that describe an input.
 *
 * @param ids - Identifiers, with undefined for a description not shown.
 * @returns The shown identifiers separated by spaces, or undefined when none
 * is shown.
 */
function buildDescriptionIds(
  ids: readonly (string | undefined)[]
): string | undefined {
  const shownIds = ids.filter((id) => id !== undefined)
  return shownIds.length === 0 ? undefined : shownIds.join(" ")
}

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
 * Presents a field's label, whether the account needs a value there, and
 * the field's rule, on one line.
 *
 * @remarks The field owns every value; the component owns no state or
 * effects. An input's label is a `label` element; a group's is a plain span
 * that the group refers to. The required marker is text beside the label,
 * outside it, so the name stays the label; the input itself carries the
 * required state. The hint takes `hintId`, so that the input or group whose
 * rule it states refers to it.
 * @param props - Label target, label, requirement, and hint.
 * @returns The label line.
 */
function EmailFieldTop({
  target,
  label,
  isRequired,
  hintId,
  hint
}: EmailFieldTopProps): ReactElement {
  return (
    <div className="settings-view__email-field-top">
      <span className="settings-view__email-field-label">
        {buildEmailFieldLabel(target, label)}
        {isRequired ? (
          <span className="settings-view__email-field-rule">required</span>
        ) : null}
      </span>
      <span className="settings-view__email-field-rule" id={hintId}>
        {hint}
      </span>
    </div>
  )
}

/**
 * Builds the label of one field.
 *
 * @param target - Input or group the label names.
 * @param label - Visible label of the field.
 * @returns A `label` element for an input, or a span with the identifier
 * that a group refers to.
 */
function buildEmailFieldLabel(
  target: EmailFieldLabelTarget,
  label: string
): ReactElement {
  switch (target.kind) {
    case "control":
      return <label htmlFor={target.controlId}>{label}</label>
    case "group":
      return <span id={target.labelId}>{label}</span>
    default: {
      const unhandledTarget: never = target
      return unhandledTarget
    }
  }
}

/**
 * Presents why one field's text breaks a rule, under its input.
 *
 * @remarks The field owns the problem; the component owns no state.
 * @param props - Identifier and problem.
 * @returns The problem paragraph, or nothing while the text breaks no rule.
 */
function EmailFieldProblem({
  id,
  problem
}: EmailFieldProblemProps): ReactElement | null {
  if (problem === undefined) return null
  return (
    <p className="settings-view__email-field-error" id={id}>
      {problem}
    </p>
  )
}

/**
 * Presents a note that explains one input.
 *
 * @remarks The parent owns the note; the component owns no state.
 * @param props - Identifier and note.
 * @returns The note paragraph, or nothing while the note is empty.
 */
function EmailFieldNote({
  id,
  note
}: EmailFieldNoteProps): ReactElement | null {
  if (note === "") return null
  return (
    <p className="settings-view__email-field-note" id={id}>
      {note}
    </p>
  )
}

/**
 * Presents one labelled text field of the account and, when its text
 * breaks a rule, what to change.
 *
 * @remarks The card owns the text; the field owns no state or effects. A
 * required field says so beside the label and is marked required, and a
 * hint beside the label states the field's rule before entry. The input is
 * described by its hint, then by its problem, when it has one, then by the
 * note when there is one. Escape in the input proposes discarding the
 * card's edit, except an Escape that ends text composition.
 * @param props - Label, requirement, hint, text, problem, note identifier,
 * input settings, ref, and the proposals.
 * @returns The field.
 */
function EmailTextField({
  label,
  isRequired,
  hint,
  text,
  problem,
  noteId,
  autoComplete,
  inputMode,
  fieldRef,
  onTextChange,
  onDiscardEdit
}: EmailTextFieldProps): ReactElement {
  const fieldId = useId()
  const hintId = `${fieldId}-hint`
  const problemId = `${fieldId}-problem`

  return (
    <div className="settings-view__email-field">
      <EmailFieldTop
        hint={hint}
        hintId={hintId}
        isRequired={isRequired}
        label={label}
        target={{ kind: "control", controlId: fieldId }}
      />
      <Input
        aria-describedby={buildDescriptionIds([
          hintId,
          problem === undefined ? undefined : problemId,
          noteId
        ])}
        aria-invalid={problem === undefined ? undefined : true}
        aria-required={isRequired}
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
      <EmailFieldProblem id={problemId} problem={problem} />
    </div>
  )
}

/**
 * Edits the password, hidden as bullets until the person shows it.
 *
 * @remarks The card owns the text and whether the password is shown; the
 * input owns no state or effects. While a password is saved, bullets stand
 * for it in the empty input and the input is not marked required; otherwise
 * it is. The show button is a toggle named `Show password` whose pressed
 * state says the password is shown. Escape in the input proposes discarding
 * the card's edit, except an Escape that ends text composition.
 * @param props - Identifier, text, descriptions, validity, saved and shown
 * state, ref, and the proposals.
 * @returns The input and its show button.
 */
function EmailPasswordInput({
  fieldId,
  text,
  descriptionIds,
  isInvalid,
  hasSavedPassword,
  isPasswordShown,
  fieldRef,
  onTextChange,
  onIsPasswordShownChange,
  onDiscardEdit
}: EmailPasswordInputProps): ReactElement {
  return (
    <div className="settings-view__secret-field">
      <Input
        aria-describedby={descriptionIds}
        aria-invalid={isInvalid ? true : undefined}
        aria-required={!hasSavedPassword}
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
  )
}

/**
 * Presents the password field with its show and hide button and, when the
 * text breaks a rule, what to change.
 *
 * @remarks The card owns the text and whether the password is shown; the
 * field owns no state or effects. It starts empty, and a hint beside the
 * label states the password's rule before entry. While a password is
 * saved, bullets stand for it and a note says an empty field keeps it;
 * otherwise the field says beside the label that it is required and is
 * marked required. The input is described by its hint, then by its
 * problem, when it has one, then by the note while a password is saved.
 * The saved password is never put in the field.
 * @param props - Text, problem, saved state, shown state, ref, and the
 * proposals.
 * @returns The field.
 */
function EmailPasswordField({
  text,
  problem,
  hasSavedPassword,
  isPasswordShown,
  fieldRef,
  onTextChange,
  onIsPasswordShownChange,
  onDiscardEdit
}: EmailPasswordFieldProps): ReactElement {
  const fieldId = useId()
  const hintId = `${fieldId}-hint`
  const problemId = `${fieldId}-problem`
  const noteId = `${fieldId}-note`

  return (
    <div className="settings-view__email-field">
      <EmailFieldTop
        hint={EMAIL_PASSWORD_HINT}
        hintId={hintId}
        isRequired={!hasSavedPassword}
        label="Password"
        target={{ kind: "control", controlId: fieldId }}
      />
      <EmailPasswordInput
        descriptionIds={buildDescriptionIds([
          hintId,
          problem === undefined ? undefined : problemId,
          hasSavedPassword ? noteId : undefined
        ])}
        fieldId={fieldId}
        fieldRef={fieldRef}
        hasSavedPassword={hasSavedPassword}
        isInvalid={problem !== undefined}
        isPasswordShown={isPasswordShown}
        onDiscardEdit={onDiscardEdit}
        onIsPasswordShownChange={onIsPasswordShownChange}
        onTextChange={onTextChange}
        text={text}
      />
      <EmailFieldProblem id={problemId} problem={problem} />
      <EmailFieldNote
        id={noteId}
        note={hasSavedPassword ? EMAIL_PASSWORD_KEPT_NOTE : ""}
      />
    </div>
  )
}

/**
 * Presents how one server's connection is secured, as a single choice.
 *
 * @remarks The card owns the way; the choice owns no state or effects. It
 * is a toggle group named Security with one item per way, in the order of
 * {@link EMAIL_SECURITIES}; pressing the chosen way again proposes nothing.
 * A hint beside the label states, before a choice, the hosts the way
 * without TLS is allowed for, and describes the group.
 * @param props - The way and the proposal.
 * @returns The labelled toggle group.
 */
function EmailSecurityChoice({
  security,
  onSecurityChange
}: EmailSecurityChoiceProps): ReactElement {
  const labelId = useId()
  const hintId = `${labelId}-hint`

  /**
   * Proposes the way to secure the connection the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleSecurityValueChange(groupValue: string[]): void {
    const selected = findEmailSecurity(groupValue)
    if (selected !== undefined) onSecurityChange(selected)
  }

  return (
    <div className="settings-view__email-security">
      <EmailFieldTop
        hint={EMAIL_SECURITY_HINT}
        hintId={hintId}
        isRequired={false}
        label="Security"
        target={{ kind: "group", labelId }}
      />
      <ToggleGroup
        aria-describedby={hintId}
        aria-labelledby={labelId}
        onValueChange={handleSecurityValueChange}
        size="sm"
        value={[security]}
        variant="outline"
      >
        {EMAIL_SECURITIES.map((way) => (
          <ToggleGroupItem
            className="settings-view__tool-segment"
            key={way}
            value={way}
          >
            {formatEmailSecurityLabel(way)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/**
 * Presents the fields of one mail server: its host, port, and how the
 * connection is secured.
 *
 * @remarks The card owns the fields; the group owns no state or effects.
 * It is a group named by its legend, such as `IMAP server`. The host and
 * the port are required; the host's hint states its format, and the port's
 * its range. Escape in the host or port proposes discarding the card's
 * edit.
 * @param props - Side, fields, problems, refs, and the proposals.
 * @returns The group of fields.
 */
function EmailServerFields({
  side,
  server,
  problems,
  hostRef,
  portRef,
  onServerChange,
  onDiscardEdit
}: EmailServerFieldsProps): ReactElement {
  return (
    <fieldset className="settings-view__email-server">
      <legend>{formatEmailServerSideLabel(side)}</legend>
      <EmailTextField
        autoComplete="off"
        fieldRef={hostRef}
        hint={EMAIL_HOST_HINT}
        isRequired
        label="Host"
        onDiscardEdit={onDiscardEdit}
        onTextChange={(host) => onServerChange({ ...server, host })}
        problem={problems[`${side}Host`]}
        text={server.host}
      />
      <EmailTextField
        autoComplete="off"
        fieldRef={portRef}
        hint={EMAIL_PORT_HINT}
        inputMode="numeric"
        isRequired
        label="Port"
        onDiscardEdit={onDiscardEdit}
        onTextChange={(port) => onServerChange({ ...server, port })}
        problem={problems[`${side}Port`]}
        text={server.port}
      />
      <EmailSecurityChoice
        onSecurityChange={(security) => onServerChange({ ...server, security })}
        security={server.security}
      />
    </fieldset>
  )
}

/**
 * Presents whether the mail server keeps a copy of sent mail, as a switch
 * with its note.
 *
 * @remarks The card owns the value; the field owns no state or effects.
 * The switch is named by its label and described by the note. While a
 * check, save, or removal runs it is disabled, so it says so and leaves
 * the tab order, which the disabled group around it does not do for it.
 * @param props - Value, busy state, and the proposal.
 * @returns The switch row.
 */
function EmailSentCopyField({
  serverKeepsSentCopy,
  isBusy,
  onServerKeepsSentCopyChange
}: EmailSentCopyFieldProps): ReactElement {
  const noteId = useId()

  return (
    <div className="settings-view__email-switch-row">
      <div className="settings-view__identity-lines">
        <span className="settings-view__email-switch-label">
          Server keeps a copy of sent mail
        </span>
        <p id={noteId}>{EMAIL_SENT_COPY_NOTE}</p>
      </div>
      <Switch
        aria-describedby={noteId}
        aria-label="Server keeps a copy of sent mail"
        checked={serverKeepsSentCopy}
        disabled={isBusy}
        onCheckedChange={(checked) => onServerKeepsSentCopyChange(checked)}
      />
    </div>
  )
}

/**
 * Presents who the account is: its address, with the note of the preset
 * that applies, its display name, and its user name.
 *
 * @remarks The card owns the fields; the component owns no state or
 * effects. Typing an address proposes the fields with the address's preset
 * filled in where {@link updateEmailAccountAddress} allows it. The address
 * and the user name are required, and each field's hint states its rule
 * before entry. The note under the address says which preset applies and
 * describes the address. Escape in an input proposes discarding the card's
 * edit.
 * @param props - Fields, problems, refs, and the proposals.
 * @returns The address, its note, the display name, and the user name, in
 * that order and in no wrapper.
 */
function EmailIdentityFields({
  draft,
  problems,
  fieldRefs,
  onDraftChange,
  onDiscardEdit
}: EmailIdentityFieldsProps): ReactElement {
  const presetId = useId()
  const presetNote = formatEmailPresetNote(draft)

  return (
    <>
      <EmailTextField
        autoComplete="email"
        fieldRef={fieldRefs.address}
        hint={EMAIL_ADDRESS_HINT}
        isRequired
        label="Address"
        noteId={presetNote === "" ? undefined : presetId}
        onDiscardEdit={onDiscardEdit}
        onTextChange={(address) =>
          onDraftChange(updateEmailAccountAddress(draft, address))
        }
        problem={problems.address}
        text={draft.address}
      />
      <EmailFieldNote id={presetId} note={presetNote} />
      <EmailTextField
        autoComplete="name"
        fieldRef={fieldRefs.displayName}
        hint={EMAIL_DISPLAY_NAME_HINT}
        isRequired={false}
        label="Display name"
        onDiscardEdit={onDiscardEdit}
        onTextChange={(displayName) => onDraftChange({ ...draft, displayName })}
        problem={problems.displayName}
        text={draft.displayName}
      />
      <EmailTextField
        autoComplete="username"
        fieldRef={fieldRefs.userName}
        hint={EMAIL_USER_NAME_HINT}
        isRequired
        label="User name"
        onDiscardEdit={onDiscardEdit}
        onTextChange={(userName) => onDraftChange({ ...draft, userName })}
        problem={problems.userName}
        text={draft.userName}
      />
    </>
  )
}

/**
 * Presents the account's mail servers and how they file sent mail: the
 * IMAP and SMTP servers, side by side where the card is wide enough, and
 * the Sent copy switch.
 *
 * @remarks The card owns the fields; the component owns no state or
 * effects. Each server is its own group of fields.
 * @param props - Fields, problems, refs, busy state, and the proposals.
 * @returns The two servers and the Sent copy switch, in that order and in
 * no wrapper.
 */
function EmailAccountServers({
  draft,
  problems,
  fieldRefs,
  isBusy,
  onDraftChange,
  onDiscardEdit
}: EmailAccountServersProps): ReactElement {
  return (
    <>
      <div className="settings-view__email-servers">
        <EmailServerFields
          hostRef={fieldRefs.imapHost}
          onDiscardEdit={onDiscardEdit}
          onServerChange={(imap) => onDraftChange({ ...draft, imap })}
          portRef={fieldRefs.imapPort}
          problems={problems}
          server={draft.imap}
          side="imap"
        />
        <EmailServerFields
          hostRef={fieldRefs.smtpHost}
          onDiscardEdit={onDiscardEdit}
          onServerChange={(smtp) => onDraftChange({ ...draft, smtp })}
          portRef={fieldRefs.smtpPort}
          problems={problems}
          server={draft.smtp}
          side="smtp"
        />
      </div>
      <EmailSentCopyField
        isBusy={isBusy}
        onServerKeepsSentCopyChange={(serverKeepsSentCopy) =>
          onDraftChange({ ...draft, serverKeepsSentCopy })
        }
        serverKeepsSentCopy={draft.serverKeepsSentCopy}
      />
    </>
  )
}

/**
 * Presents the account's fields, after the summary of their problems while
 * two or more have one.
 *
 * @remarks The card owns the fields, the problems, the hosts, and whether
 * the password is shown; the component owns no state or effects. The
 * summary is a group named `Fix N fields to save:` with a level-four
 * heading, under the card's, whose buttons, one per input with a problem in
 * the card's order, ask the card to move focus to their input. The fields
 * form one group, disabled while a check, save, or removal runs: the
 * address with its preset note, the display name, the user name, the
 * password, the two servers, and the Sent copy switch.
 * @param props - Fields, problems, hosts, saved and shown password, busy
 * state, and the proposals.
 * @returns The summary, while shown, and the group of fields.
 */
function EmailAccountFields({
  draft,
  problems,
  fieldRefs,
  summaryRef,
  hasSavedPassword,
  isPasswordShown,
  isBusy,
  onDraftChange,
  onIsPasswordShownChange,
  onSelectField,
  onDiscardEdit
}: EmailAccountFieldsProps): ReactElement {
  const problemListings = listEmailDraftProblems(problems)

  return (
    <>
      {problemListings.length > 1 ? (
        <McpDraftProblemSummary
          headingLevel={4}
          onSelectField={onSelectField}
          problems={problemListings}
          summaryRef={summaryRef}
        />
      ) : null}
      <fieldset className="settings-view__email-fields" disabled={isBusy}>
        <EmailIdentityFields
          draft={draft}
          fieldRefs={fieldRefs}
          onDiscardEdit={onDiscardEdit}
          onDraftChange={onDraftChange}
          problems={problems}
        />
        <EmailPasswordField
          fieldRef={fieldRefs.password}
          hasSavedPassword={hasSavedPassword}
          isPasswordShown={isPasswordShown}
          onDiscardEdit={onDiscardEdit}
          onIsPasswordShownChange={onIsPasswordShownChange}
          onTextChange={(password) => onDraftChange({ ...draft, password })}
          problem={problems.password}
          text={draft.password}
        />
        <EmailAccountServers
          draft={draft}
          fieldRefs={fieldRefs}
          isBusy={isBusy}
          onDiscardEdit={onDiscardEdit}
          onDraftChange={onDraftChange}
          problems={problems}
        />
      </fieldset>
    </>
  )
}

/**
 * Asks whether to remove the saved account.
 *
 * @remarks The footer owns both choices; the component owns no state. The
 * question names the group; its choices are named `Keep the email account`
 * and `Remove the email account`. Focus starts on Keep, the least
 * destructive choice, and Escape on either choice keeps the account. While
 * a check, save, or removal runs, both choices are disabled.
 * @param props - Busy state and the footer-owned choices.
 * @returns The confirmation group.
 */
function EmailAccountRemovalQuestion({
  isBusy,
  onKeepEmailAccount,
  onRemoveEmailAccount
}: EmailAccountRemovalQuestionProps): ReactElement {
  const questionId = useId()

  /**
   * Keeps the account when Escape is pressed on either choice.
   *
   * @param event - Key press on a confirmation button.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    onKeepEmailAccount()
  }

  return (
    <fieldset
      aria-labelledby={questionId}
      className="settings-view__mcp-confirm"
      disabled={isBusy}
    >
      <span id={questionId}>{EMAIL_ACCOUNT_REMOVAL_QUESTION}</span>
      <Button
        aria-label="Keep the email account"
        autoFocus
        onClick={onKeepEmailAccount}
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
  )
}

/**
 * Answers whether the question whether to remove the account shows in
 * place of the actions.
 *
 * @param removalStep - Where the removal stands.
 * @returns True from the moment the question opens until it closes, also
 * while the removal runs.
 */
function isRemovalQuestionShown(removalStep: EmailAccountRemovalStep): boolean {
  switch (removalStep) {
    case "confirming":
      return true
    case "idle":
    case "returning":
      return false
    default: {
      const unhandledStep: never = removalStep
      return unhandledStep
    }
  }
}

/**
 * Answers whether Remove account takes focus once it is attached again.
 *
 * @param removalStep - Where the removal stands.
 * @returns True once the question closed without a removal, until Remove
 * account took focus.
 */
function shouldFocusRemoveAccount(
  removalStep: EmailAccountRemovalStep
): boolean {
  switch (removalStep) {
    case "returning":
      return true
    case "idle":
    case "confirming":
      return false
    default: {
      const unhandledStep: never = removalStep
      return unhandledStep
    }
  }
}

/**
 * Owns the footer's removal of the saved account: whether the question
 * shows, and whether Remove account takes focus back.
 *
 * @remarks The step lives as long as the footer instance and starts idle.
 * Both callbacks come from the render whose question the person
 * confirmed: the removal is requested then, and reported once it was
 * saved. A removal keeps the question shown, disabled while it runs, then
 * closes it; one that was not saved leaves Remove account to take focus
 * back, and one that was saved reports to the card. The requests and the
 * ref callback are rebuilt on every render.
 * @param onRemoveEmailAccount - Requests that the parent remove the saved
 * account; resolves with the outcome and never rejects.
 * @param onRemoveEmailAccountComplete - Notified once a removal was saved,
 * after the question closed.
 * @returns The step and the requests that move it.
 */
function useEmailAccountRemoval(
  onRemoveEmailAccount: () => Promise<EmailAccountRemovalOutcome>,
  onRemoveEmailAccountComplete: () => void
): EmailAccountRemoval {
  const [removalStep, setRemovalStep] =
    useState<EmailAccountRemovalStep>("idle")

  /** Opens the question whether to remove the account. */
  function openRemovalQuestion(): void {
    setRemovalStep("confirming")
  }

  /** Closes the question keeping the account; Remove account takes focus. */
  function closeRemovalQuestion(): void {
    setRemovalStep("returning")
  }

  /**
   * Removes the saved account and closes the question once the removal
   * settled, reporting a saved removal to the card, or letting Remove
   * account take focus back after one that was not saved.
   */
  async function handleRemoveAccount(): Promise<void> {
    const outcome = await onRemoveEmailAccount()
    switch (outcome) {
      case "saved":
        setRemovalStep("idle")
        onRemoveEmailAccountComplete()
        return
      case "failed":
      case "busy":
        setRemovalStep("returning")
        return
      default: {
        const unhandledOutcome: never = outcome
        return unhandledOutcome
      }
    }
  }

  /**
   * Focuses Remove account once it is attached again, and stops attaching it
   * for focus.
   *
   * @param element - Attached button, or null when React detaches it,
   * which is ignored.
   */
  function handleRemoveAccountAttach(element: HTMLButtonElement | null): void {
    if (element === null) return
    element.focus()
    setRemovalStep("idle")
  }

  return {
    removalStep,
    openRemovalQuestion,
    closeRemovalQuestion,
    handleRemoveAccount,
    removeAccountRef: shouldFocusRemoveAccount(removalStep)
      ? handleRemoveAccountAttach
      : undefined
  }
}

/**
 * Presents the card's status line and its actions: Save, and Remove
 * account with the question whether to remove it.
 *
 * @remarks The card owns the message, the busy state, Save, which submits
 * the card's form, and the removal itself; the footer owns, through
 * {@link useEmailAccountRemoval}, whether the question shows and whether
 * Remove account takes focus back. The status line is a polite live region.
 * Remove account shows while it is offered and opens the question, which
 * replaces the actions until the person keeps the account or the removal
 * settled. After the person kept the account, or a removal was not saved,
 * Remove account takes focus once it is attached again. Every action is
 * disabled while a check, save, or removal runs.
 * @param props - Message, removal offer, busy state, Save's state, and the
 * removal request and report.
 * @returns The footer.
 */
function EmailAccountFooter({
  message,
  isRemovalOffered,
  isBusy,
  isSaveDisabled,
  onRemoveEmailAccount,
  onRemoveEmailAccountComplete
}: EmailAccountFooterProps): ReactElement {
  const { removeAccountRef, ...removal } = useEmailAccountRemoval(
    onRemoveEmailAccount,
    onRemoveEmailAccountComplete
  )

  return (
    <div className="settings-view__email-footer">
      <p
        aria-live="polite"
        className="settings-view__email-status"
        data-tone={message.tone}
        role="status"
      >
        {message.text}
      </p>
      {isRemovalQuestionShown(removal.removalStep) ? (
        <EmailAccountRemovalQuestion
          isBusy={isBusy}
          onKeepEmailAccount={removal.closeRemovalQuestion}
          onRemoveEmailAccount={() => void removal.handleRemoveAccount()}
        />
      ) : (
        <div className="settings-view__email-actions">
          {isRemovalOffered ? (
            <Button
              className="settings-view__mcp-remove"
              disabled={isBusy}
              onClick={removal.openRemovalQuestion}
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
 * Keeps the host of each field's input and of the problem summary, so a
 * rejected save can move focus to the only input with a problem or to the
 * summary, a summary button to its input, and a removal to the address.
 *
 * @remarks The hook owns the hosts for the card's lifetime and reads them
 * only to move focus. In the layout phase after each rejected save, focus
 * moves to the summary while two or more inputs have a problem, and
 * otherwise to the input that has one. A focus move to an input that is
 * not attached does nothing.
 * @param rejectedSaveCount - Reactive count of the saves the fields'
 * problems rejected.
 * @param problems - Problems shown in the current render, read when focus
 * moves.
 * @returns The hosts for the card to attach, and the focus moves.
 */
function useEmailFieldHosts(
  rejectedSaveCount: number,
  problems: EmailAccountDraftProblems
): EmailFieldFocusHosts {
  const problemListings = listEmailDraftProblems(problems)
  const addressRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)
  const userNameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const imapHostRef = useRef<HTMLInputElement>(null)
  const imapPortRef = useRef<HTMLInputElement>(null)
  const smtpHostRef = useRef<HTMLInputElement>(null)
  const smtpPortRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLFieldSetElement>(null)
  const fieldRefs: EmailFieldRefs = {
    address: addressRef,
    displayName: displayNameRef,
    userName: userNameRef,
    password: passwordRef,
    imapHost: imapHostRef,
    imapPort: imapPortRef,
    smtpHost: smtpHostRef,
    smtpPort: smtpPortRef
  }
  const handleRejectedSave = useEffectEvent((): void => {
    if (problemListings.length > 1) summaryRef.current?.focus()
    else if (problemListings.length === 1)
      fieldRefs[problemListings[0].field].current?.focus()
  })

  /**
   * Handles a summary button's choice of a field, by moving focus to its
   * input.
   *
   * @param field - The field.
   */
  function handleFieldSelect(field: EmailAccountDraftField): void {
    fieldRefs[field].current?.focus()
  }

  /**
   * Handles the removal of the saved account, by moving focus to the
   * address input.
   */
  function handleRemovedAccount(): void {
    addressRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (rejectedSaveCount > 0) handleRejectedSave()
  }, [rejectedSaveCount])

  return { fieldRefs, summaryRef, handleFieldSelect, handleRemovedAccount }
}

/**
 * Calculates the card's own state after one change.
 *
 * @param edit - The card's state now.
 * @param change - What happened.
 * @returns After an edit, the new fields; after a reset, a fresh state
 * that keeps the count of rejected saves; after the password was shown or
 * hidden, the new visibility; after a tried save, that save with the edit
 * it was tried with, counted when the fields' problems rejected it; after
 * a save succeeded, a fresh state that keeps the count and any edit made
 * while the save ran.
 */
function calculateEmailAccountEdit(
  edit: EmailAccountEdit,
  change: EmailAccountEditChange
): EmailAccountEdit {
  switch (change.kind) {
    case "edited":
      return { ...edit, editedDraft: change.draft }
    case "reset":
      return {
        ...INITIAL_EMAIL_ACCOUNT_EDIT,
        rejectedSaveCount: edit.rejectedSaveCount
      }
    case "password-shown":
      return { ...edit, isPasswordShown: change.isPasswordShown }
    case "save-tried": {
      const saveTry: EmailAccountSaveTry = {
        status: "tried",
        draft: edit.editedDraft
      }
      return {
        ...edit,
        saveTry,
        rejectedSaveCount: edit.rejectedSaveCount + (change.isRejected ? 1 : 0)
      }
    }
    case "saved":
      return {
        ...INITIAL_EMAIL_ACCOUNT_EDIT,
        editedDraft:
          edit.editedDraft === change.triedDraft ? null : edit.editedDraft,
        rejectedSaveCount: edit.rejectedSaveCount
      }
  }
}

/**
 * Answers whether a save was tried since the card's edit last started
 * afresh, from which the fields' problems show.
 *
 * @param saveTry - The save tried last.
 * @returns True once a save was tried.
 */
function hasTriedSave(saveTry: EmailAccountSaveTry): boolean {
  switch (saveTry.status) {
    case "tried":
      return true
    case "none":
      return false
    default: {
      const unhandledTry: never = saveTry
      return unhandledTry
    }
  }
}

/**
 * Answers whether the fields changed since the last save was tried, after
 * which what that save found no longer concerns them.
 *
 * @param edit - The card's own state.
 * @returns True while the edit is not the one the last save was tried
 * with, or, before any tried save, while there is an edit.
 */
function isEditedSinceTriedSave(edit: EmailAccountEdit): boolean {
  switch (edit.saveTry.status) {
    case "tried":
      return edit.editedDraft !== edit.saveTry.draft
    case "none":
      return edit.editedDraft !== null
    default: {
      const unhandledTry: never = edit.saveTry
      return unhandledTry
    }
  }
}

/**
 * Gets the problems a reading of the fields found.
 *
 * @param draftParse - Outcome of reading the fields.
 * @returns The first problem of each input that has one; none while the
 * fields hold an account to save or the saved one.
 */
function getDraftParseProblems(
  draftParse: EmailAccountDraftParse
): EmailAccountDraftProblems {
  switch (draftParse.status) {
    case "invalid":
      return draftParse.problems
    case "changed":
    case "unchanged":
      return NO_PROBLEMS
    default: {
      const unhandledParse: never = draftParse
      return unhandledParse
    }
  }
}

/**
 * Answers whether the fields hold the saved account and no new password,
 * which leaves Save nothing to save.
 *
 * @param draftParse - Outcome of reading the fields.
 * @returns True while nothing differs from the saved account.
 */
function isDraftUnchanged(draftParse: EmailAccountDraftParse): boolean {
  switch (draftParse.status) {
    case "unchanged":
      return true
    case "changed":
    case "invalid":
      return false
    default: {
      const unhandledParse: never = draftParse
      return unhandledParse
    }
  }
}

/**
 * Builds one render's reading of the card's edit.
 *
 * @param edit - The card's own state.
 * @param facts - Saved account and password, the latest save and check,
 * and whether the backend runs.
 * @returns What the card shows, the fields checked against the account
 * rules and the saved account, and whether a submission can save.
 */
function buildEmailAccountEditReading(
  edit: EmailAccountEdit,
  facts: EmailAccountEditFacts
): EmailAccountEditReading {
  const { savedAccount, saveState, checkState, isBackendRunning } = facts
  const draft = edit.editedDraft ?? buildEmailAccountDraft(savedAccount)
  const draftParse = parseEmailAccountDraft(
    draft,
    savedAccount,
    facts.savedPassword
  )
  const hasSubmitted = hasTriedSave(edit.saveTry)
  const isBusy =
    isEmailAccountSaveRunning(saveState) ||
    isEmailAccountCheckRunning(checkState)
  const canSubmit = !isBusy && isBackendRunning
  const message = formatEmailAccountMessage({
    savedAccount,
    draftParse,
    isDraftDifferent: isEmailAccountDraftDifferent(draft, savedAccount),
    hasSubmitted,
    isEditedSinceSubmit: isEditedSinceTriedSave(edit),
    saveState,
    checkState,
    isBackendRunning
  })
  const view: EmailAccountEditView = {
    draft,
    problems: hasSubmitted ? getDraftParseProblems(draftParse) : NO_PROBLEMS,
    isEdited: edit.editedDraft !== null,
    isPasswordShown: edit.isPasswordShown,
    rejectedSaveCount: edit.rejectedSaveCount,
    isBusy,
    isSaveDisabled: isDraftUnchanged(draftParse) || !canSubmit,
    message
  }

  return { view, draftParse, canSubmit }
}

/**
 * Answers whether a field breaks a rule, which rejects a save.
 *
 * @param draftParse - Outcome of reading the fields.
 * @returns True while at least one field breaks a rule.
 */
function isDraftInvalid(draftParse: EmailAccountDraftParse): boolean {
  switch (draftParse.status) {
    case "invalid":
      return true
    case "changed":
    case "unchanged":
      return false
    default: {
      const unhandledParse: never = draftParse
      return unhandledParse
    }
  }
}

/**
 * Owns the person's edit of the account and the saves it tries, and reads
 * what the card shows of them.
 *
 * @remarks The state lives as long as the card instance and starts from the
 * saved account, with no save tried and the password hidden. `facts` is
 * reactive: the result and the submission handler read the values of the
 * render that built them. A submission prevents the browser's submission
 * and does nothing else while a check, save, or removal runs or the backend
 * is not running; otherwise it records the tried save, from which the
 * fields' problems show, counts it when a field breaks a rule, and asks the
 * parent to save when the fields hold an account to save. A save that
 * succeeded resets the edit unless the fields changed while it ran; one
 * that did not succeed keeps it. The other requests change only the card's
 * own state. The requests are rebuilt on every render.
 * @param facts - Saved account and password, the latest save and check, and
 * whether the backend runs.
 * @param onSaveEmailAccount - Requests that the parent sign in and save an
 * account with its password, invoked during a submission; resolves with the
 * outcome and never rejects.
 * @returns What the card shows of the edit, and the requests that change it.
 */
function useEmailAccountEdit(
  facts: EmailAccountEditFacts,
  onSaveEmailAccount: EmailAccountCardProps["onSaveEmailAccount"]
): EmailAccountEditing {
  const [edit, updateEdit] = useReducer(
    calculateEmailAccountEdit,
    INITIAL_EMAIL_ACCOUNT_EDIT
  )
  const { view, draftParse, canSubmit } = buildEmailAccountEditReading(
    edit,
    facts
  )

  /**
   * Proposes new fields.
   *
   * @param draft - Fields after the person's change.
   */
  function updateDraft(draft: EmailAccountDraft): void {
    updateEdit({ kind: "edited", draft })
  }

  /** Discards the edit, the tried save, and the shown password. */
  function resetEdit(): void {
    updateEdit(RESET_EDIT)
  }

  /**
   * Shows or hides the password.
   *
   * @param isPasswordShown - Whether the password shows as text from now on.
   */
  function handleIsPasswordShownChange(isPasswordShown: boolean): void {
    updateEdit({ kind: "password-shown", isPasswordShown })
  }

  /**
   * Signs in and saves the account and, once it is saved, resets the edit
   * unless the fields changed since the save was tried.
   *
   * @param account - Valid account that differs from the saved one, or
   * the saved one with a new password.
   * @param password - Its password.
   * @param triedDraft - Edit the account was read from.
   */
  async function saveAccount(
    account: EmailAccount,
    password: EmailPassword,
    triedDraft: EmailAccountDraft | null
  ): Promise<void> {
    const outcome = await onSaveEmailAccount(account, password)
    if (isEmailAccountSaved(outcome)) updateEdit({ kind: "saved", triedDraft })
  }

  /**
   * Asks the parent to sign in and save when the fields hold an account to
   * save, or records a save the fields' problems rejected.
   *
   * @param event - Submission of the card's form.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!canSubmit) return
    updateEdit({ kind: "save-tried", isRejected: isDraftInvalid(draftParse) })
    switch (draftParse.status) {
      case "changed":
        void saveAccount(
          draftParse.account,
          draftParse.password,
          edit.editedDraft
        )
        return
      case "unchanged":
      case "invalid":
        return
      default: {
        const unhandledParse: never = draftParse
        return unhandledParse
      }
    }
  }

  return {
    ...view,
    updateDraft,
    resetEdit,
    handleIsPasswordShownChange,
    handleSubmit
  }
}

/**
 * Presents the email account card: its note, the address, names, and
 * password, the IMAP and SMTP servers, the Sent copy switch, the status
 * line, Save, and Remove account.
 *
 * @remarks The application store owns the saved account and password, the
 * save, and the check. The card owns, through {@link useEmailAccountEdit},
 * the person's edit, which starts from the saved account, whether the
 * password is shown, which save was tried last and with which edit, and how
 * many saves the fields' problems rejected; its footer owns whether the
 * removal is being confirmed and whether Remove account takes focus back
 * after the confirmation left without removing. Typing an address whose
 * provider has a preset fills the server fields and the Sent copy switch
 * while they all still hold what an empty card holds or the preset that
 * last filled them, which for the saved account is its address's preset,
 * also when the address is typed one character at a time; values the
 * person typed are never replaced. Problems show from the first Save on,
 * each under its input, and a rejected Save moves focus to the only input
 * with a problem or, when several have one, to a summary above the fields
 * that lists them, shown while two or more remain, whose buttons move
 * focus to their input. Enter or Save asks the parent to sign in and save
 * when the fields hold a valid account that differs from the saved one or
 * a new password, no check, save, or removal runs, and the backend runs;
 * Save is disabled while nothing differs, while a save runs, or while the
 * backend is not running, which the status line says once the fields
 * differ from the saved account, valid or not. What the latest save or
 * check found shows until the fields are edited again, also when it ended
 * while the card was not shown. Escape in an input discards the edit while
 * there is one. A save that succeeded resets the edit unless the person
 * changed the fields while it ran. After a removal succeeds, the edit is
 * discarded and focus moves to the address field, because Remove leaves.
 * The status line is a polite live region. Each field, and each server's
 * Security choice, states its rule beside its label before entry.
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
  const headingId = useId()
  const edit = useEmailAccountEdit(
    { savedAccount, savedPassword, saveState, checkState, isBackendRunning },
    onSaveEmailAccount
  )
  const focusHosts = useEmailFieldHosts(edit.rejectedSaveCount, edit.problems)

  /**
   * Handles the saved removal of the account, by discarding the edit and
   * moving focus to the address, because Remove leaves.
   */
  function handleRemoveEmailAccountComplete(): void {
    edit.resetEdit()
    focusHosts.handleRemovedAccount()
  }

  return (
    <form
      aria-labelledby={headingId}
      className="settings-view__email-card"
      onSubmit={edit.handleSubmit}
    >
      <div className="settings-view__identity-lines">
        <h3 id={headingId}>Email account</h3>
        <p>{EMAIL_ACCOUNT_NOTE}</p>
      </div>
      <EmailAccountFields
        draft={edit.draft}
        fieldRefs={focusHosts.fieldRefs}
        hasSavedPassword={savedPassword !== null}
        isBusy={edit.isBusy}
        isPasswordShown={edit.isPasswordShown}
        onDiscardEdit={edit.isEdited ? edit.resetEdit : undefined}
        onDraftChange={edit.updateDraft}
        onIsPasswordShownChange={edit.handleIsPasswordShownChange}
        onSelectField={focusHosts.handleFieldSelect}
        problems={edit.problems}
        summaryRef={focusHosts.summaryRef}
      />
      <EmailAccountFooter
        isBusy={edit.isBusy}
        isRemovalOffered={savedAccount !== null && !edit.isEdited}
        isSaveDisabled={edit.isSaveDisabled}
        message={edit.message}
        onRemoveEmailAccount={onRemoveEmailAccount}
        onRemoveEmailAccountComplete={handleRemoveEmailAccountComplete}
      />
    </form>
  )
}
