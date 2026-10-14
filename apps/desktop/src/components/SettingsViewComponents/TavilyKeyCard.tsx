import type { TavilyApiKey } from "@lys/share"
import { Eye } from "lucide-react"
import {
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
import type {
  SecretsSaveOutcome,
  SecretsSaveState,
  TavilyKeyCheckState
} from "@/lib/store/secrets-settings"

import {
  calculateTavilyKeyBadge,
  calculateTavilyKeyFieldValue,
  formatTavilyKeyMessage,
  formatTavilyKeyPlaceholder,
  parseTavilyKeyDraft,
  TAVILY_KEY_PAGE_URL,
  type TavilyKeyBadge,
  type TavilyKeyDraft
} from "./secrets-presentation"

/** Properties accepted by {@link TavilyKeyCard}. */
type TavilyKeyCardProps = {
  /** Saved key, or null when none is saved. */
  readonly savedApiKey: TavilyApiKey | null
  /** Latest save, owned by the application store. */
  readonly saveState: SecretsSaveState
  /** Latest check, owned by the application store. */
  readonly keyCheck: TavilyKeyCheckState
  /**
   * Requests that the parent save a new key. Resolves with the outcome once
   * the save settled; never rejects.
   */
  readonly onSaveTavilyApiKey: (
    apiKey: TavilyApiKey
  ) => Promise<SecretsSaveOutcome>
  /** Requests that the parent remove the saved key; same completion as a save. */
  readonly onRemoveTavilyApiKey: () => Promise<SecretsSaveOutcome>
  /** Requests that the parent check the saved key; the parent owns the outcome. */
  readonly onSendTavilyKeyCheck: () => Promise<void>
}

/** Properties accepted by {@link TavilyKeyCardHeader}. */
type TavilyKeyCardHeaderProps = {
  /** Identifier of the service name, which labels the card. */
  readonly nameId: string
  /** State shown on the badge. */
  readonly badge: TavilyKeyBadge
}

/** Properties accepted by {@link TavilyKeyField}. */
type TavilyKeyFieldProps = {
  /** Identifier of the input, which the form's label names. */
  readonly fieldId: string
  /** Identifier of the status line that describes the input. */
  readonly statusId: string
  /**
   * Parent-owned ref attached to the input.
   *
   * @remarks The card uses it only to move focus into the field after a
   * removal, because Remove leaves.
   */
  readonly fieldRef: RefObject<HTMLInputElement | null>
  /** Saved key, or null when none is saved. */
  readonly savedApiKey: TavilyApiKey | null
  /** The person's edit, owned by the card. */
  readonly draft: TavilyKeyDraft
  /** Whether the edited text is not a valid key. */
  readonly isInvalid: boolean
  /** Whether the key shows as text instead of bullets. */
  readonly isKeyShown: boolean
  /** Proposes a replacement for the card's edit: typed text, or unedited on Escape. */
  readonly onDraftChange: (draft: TavilyKeyDraft) => void
  /** Proposes showing or hiding the key. */
  readonly onIsKeyShownChange: (isKeyShown: boolean) => void
}

/** Properties accepted by {@link TavilyKeyForm}. */
type TavilyKeyFormProps = Omit<TavilyKeyFieldProps, "isInvalid"> & {
  /** Whether a save runs, which blocks another. */
  readonly isSaving: boolean
  /**
   * Requests that the card save a valid key that differs from the saved one;
   * called once per accepted submit.
   */
  readonly onSaveTavilyApiKey: (apiKey: TavilyApiKey) => void
}

/** Properties accepted by {@link TavilyKeyFooter}. */
type TavilyKeyFooterProps = {
  /** Identifier of the status line, which describes the key field. */
  readonly statusId: string
  /** Saved key, or null when none is saved. */
  readonly savedApiKey: TavilyApiKey | null
  /** The person's edit, owned by the card. */
  readonly draft: TavilyKeyDraft
  /** Latest save, owned by the application store. */
  readonly saveState: SecretsSaveState
  /** Latest check, owned by the application store. */
  readonly keyCheck: TavilyKeyCheckState
  /** Requests that the card check the saved key. */
  readonly onSendTavilyKeyCheck: () => void
  /** Requests that the card remove the saved key. */
  readonly onRemoveTavilyApiKey: () => void
}

/** Field state while the person has not edited it. */
const UNEDITED_DRAFT: TavilyKeyDraft = Object.freeze({ status: "unedited" })

/**
 * Presents the Tavily card's header: the service's name, what Lys asks of
 * it, and the key's state.
 *
 * @remarks A pure projection of its props.
 * @param props - Name identifier and badge.
 * @returns The header.
 */
function TavilyKeyCardHeader({
  nameId,
  badge
}: TavilyKeyCardHeaderProps): ReactElement {
  return (
    <div className="settings-view__secret-card-header">
      <div className="settings-view__identity-lines">
        <h3 id={nameId}>Tavily</h3>
        <p>
          Search built for agents. Lys asks it for titles, links, and short
          snippets.
        </p>
      </div>
      <span className="settings-view__secret-state" data-tone={badge.tone}>
        {badge.label}
      </span>
    </div>
  )
}

/**
 * Presents the API key input with its show and hide button.
 *
 * @remarks The card owns the edit and whether the key is shown; the field
 * owns no state or effects. It starts empty, with the masked saved key as its
 * placeholder; showing the key puts the saved key in it. Escape proposes
 * discarding the edit.
 * @param props - Identifiers, ref, saved key, edit, and the proposals.
 * @returns The input and its button.
 */
function TavilyKeyField({
  fieldId,
  statusId,
  fieldRef,
  savedApiKey,
  draft,
  isInvalid,
  isKeyShown,
  onDraftChange,
  onIsKeyShownChange
}: TavilyKeyFieldProps): ReactElement {
  /**
   * Proposes discarding the edit on Escape.
   *
   * @param event - Key pressed in the input.
   */
  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape" || draft.status === "unedited") return
    event.preventDefault()
    onDraftChange(UNEDITED_DRAFT)
  }

  return (
    <div className="settings-view__secret-field">
      <Input
        aria-describedby={statusId}
        aria-invalid={isInvalid ? true : undefined}
        autoComplete="off"
        id={fieldId}
        onChange={(event) =>
          onDraftChange({ status: "edited", text: event.target.value })
        }
        onKeyDown={handleFieldKeyDown}
        placeholder={formatTavilyKeyPlaceholder(savedApiKey)}
        ref={fieldRef}
        spellCheck={false}
        type={isKeyShown ? "text" : "password"}
        value={calculateTavilyKeyFieldValue(draft, isKeyShown, savedApiKey)}
      />
      <Button
        aria-label="Show Tavily API key"
        aria-pressed={isKeyShown}
        onClick={() => onIsKeyShownChange(!isKeyShown)}
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
 * Presents the form that saves a new key: its label, a link to Tavily's key
 * page, the key field, and Save.
 *
 * @remarks The card owns the edit and the save; the form owns no state or
 * effects. Enter submits it. A submit asks the card to save only a valid key
 * that differs from the saved one while no save runs, and Save is disabled
 * otherwise.
 * @param props - The field's properties, whether a save runs, and the save
 * request.
 * @returns The form.
 */
function TavilyKeyForm({
  fieldId,
  statusId,
  fieldRef,
  savedApiKey,
  draft,
  isKeyShown,
  isSaving,
  onDraftChange,
  onIsKeyShownChange,
  onSaveTavilyApiKey
}: TavilyKeyFormProps): ReactElement {
  const parsedDraft = parseTavilyKeyDraft(draft, savedApiKey)

  /**
   * Asks the card to save the edited key when it is valid and new.
   *
   * @param event - Submit event of the form.
   */
  function handleSubmitKey(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (parsedDraft.status !== "changed" || isSaving) return
    onSaveTavilyApiKey(parsedDraft.apiKey)
  }

  return (
    <form className="settings-view__secret-form" onSubmit={handleSubmitKey}>
      <div className="settings-view__secret-label-line">
        <label htmlFor={fieldId}>API key</label>
        <a href={TAVILY_KEY_PAGE_URL} rel="noreferrer" target="_blank">
          get a key <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="settings-view__secret-entry">
        <TavilyKeyField
          draft={draft}
          fieldId={fieldId}
          fieldRef={fieldRef}
          isInvalid={parsedDraft.status === "invalid"}
          isKeyShown={isKeyShown}
          onDraftChange={onDraftChange}
          onIsKeyShownChange={onIsKeyShownChange}
          savedApiKey={savedApiKey}
          statusId={statusId}
        />
        <Button
          disabled={parsedDraft.status !== "changed" || isSaving}
          size="sm"
          type="submit"
        >
          Save
        </Button>
      </div>
    </form>
  )
}

/**
 * Presents the card's status line and, while a key is saved and unedited,
 * Test and Remove.
 *
 * @remarks The card and the store own every input; the footer owns no state
 * or effects. The status line is a polite live region. Test is disabled while
 * a check or a save runs, since a check during a removal would report on the
 * key being removed; Remove is disabled while a save runs.
 * @param props - Status identifier, the facts the line describes, and the
 * requests.
 * @returns The footer.
 */
function TavilyKeyFooter({
  statusId,
  savedApiKey,
  draft,
  saveState,
  keyCheck,
  onSendTavilyKeyCheck,
  onRemoveTavilyApiKey
}: TavilyKeyFooterProps): ReactElement {
  const message = formatTavilyKeyMessage({
    savedApiKey,
    draft,
    saveState,
    keyCheck
  })

  return (
    <div className="settings-view__secret-footer">
      <p
        aria-live="polite"
        className="settings-view__secret-status"
        data-tone={message.tone}
        id={statusId}
        role="status"
      >
        {message.text}
      </p>
      {savedApiKey !== null && draft.status === "unedited" ? (
        <div className="settings-view__secret-actions">
          <Button
            disabled={
              keyCheck.status === "checking" || saveState.status === "saving"
            }
            onClick={onSendTavilyKeyCheck}
            size="sm"
            type="button"
            variant="outline"
          >
            Test
          </Button>
          <Button
            disabled={saveState.status === "saving"}
            onClick={onRemoveTavilyApiKey}
            size="sm"
            type="button"
            variant="outline"
          >
            Remove
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Presents the Tavily service card: its state, the API key form, and the
 * status line with Test and Remove.
 *
 * @remarks The application store owns the saved key, the save, and the check;
 * the card owns only the person's edit and whether the key is shown, which
 * reset after a save that succeeded. After Remove succeeds, focus moves to the
 * field, because Remove leaves.
 * @param props - Saved key, save and check state, and the requests.
 * @returns The card.
 */
export default function TavilyKeyCard({
  savedApiKey,
  saveState,
  keyCheck,
  onSaveTavilyApiKey,
  onRemoveTavilyApiKey,
  onSendTavilyKeyCheck
}: TavilyKeyCardProps): ReactElement {
  const [draft, setDraft] = useState<TavilyKeyDraft>(UNEDITED_DRAFT)
  const [isKeyShown, setIsKeyShown] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const statusId = useId()

  /** Resets the edit and hides the key again, discarding the typed text. */
  function resetKeyEdit(): void {
    setDraft(UNEDITED_DRAFT)
    setIsKeyShown(false)
  }

  /**
   * Saves a new key and resets the edit once it is saved.
   *
   * @param apiKey - Valid key that differs from the saved one.
   */
  async function handleSaveKey(apiKey: TavilyApiKey): Promise<void> {
    if ((await onSaveTavilyApiKey(apiKey)) === "saved") resetKeyEdit()
  }

  /** Removes the saved key and moves focus to the field once it is gone. */
  async function handleRemoveKey(): Promise<void> {
    if ((await onRemoveTavilyApiKey()) !== "saved") return
    resetKeyEdit()
    fieldRef.current?.focus()
  }

  return (
    <article
      aria-labelledby={`${fieldId}-name`}
      className="settings-view__secret-card"
    >
      <TavilyKeyCardHeader
        badge={calculateTavilyKeyBadge(savedApiKey, keyCheck)}
        nameId={`${fieldId}-name`}
      />
      <TavilyKeyForm
        draft={draft}
        fieldId={fieldId}
        fieldRef={fieldRef}
        isKeyShown={isKeyShown}
        isSaving={saveState.status === "saving"}
        onDraftChange={setDraft}
        onIsKeyShownChange={setIsKeyShown}
        onSaveTavilyApiKey={(apiKey) => void handleSaveKey(apiKey)}
        savedApiKey={savedApiKey}
        statusId={statusId}
      />
      <TavilyKeyFooter
        draft={draft}
        keyCheck={keyCheck}
        onRemoveTavilyApiKey={() => void handleRemoveKey()}
        onSendTavilyKeyCheck={() => void onSendTavilyKeyCheck()}
        saveState={saveState}
        savedApiKey={savedApiKey}
        statusId={statusId}
      />
    </article>
  )
}
