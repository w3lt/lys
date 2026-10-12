import type { TavilyApiKey } from "@lys/share"
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
import type {
  SecretsSaveOutcome,
  SecretsSaveState,
  TavilyKeyCheckState
} from "@/lib/store/secrets-settings"

import {
  calculateTavilyKeyBadge,
  formatTavilyKeyMessage,
  maskTavilyApiKey,
  parseTavilyKeyDraft,
  TAVILY_KEY_PAGE_URL,
  TAVILY_KEY_PLACEHOLDER,
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
  readonly onCheckTavilyApiKey: () => Promise<void>
}

/** Field state while the person has not edited it. */
const UNEDITED_DRAFT: TavilyKeyDraft = Object.freeze({ status: "unedited" })

/**
 * Presents the Tavily service card: its state, the API key field with show
 * and hide, Save, and, once a key is saved, Test and Remove.
 *
 * @remarks The application store owns the saved key, the save, and the check;
 * the card owns only the person's edit and whether the key is shown, which
 * reset after a save that succeeded. The field starts empty, with the masked
 * saved key as its placeholder; Show puts the saved key in the field. Enter
 * submits the field's form and saves a changed, valid key; Escape discards the
 * edit. Save is disabled while nothing valid and new is entered or a save
 * runs; Remove is disabled while a save runs; Test while a check runs. After
 * Remove succeeds, focus moves to the field, because Remove leaves. The status
 * line is a polite live region that describes the field.
 * @param props - Saved key, save and check state, and the requests.
 * @returns The card.
 */
export default function TavilyKeyCard({
  savedApiKey,
  saveState,
  keyCheck,
  onSaveTavilyApiKey,
  onRemoveTavilyApiKey,
  onCheckTavilyApiKey
}: TavilyKeyCardProps): ReactElement {
  const [draft, setDraft] = useState<TavilyKeyDraft>(UNEDITED_DRAFT)
  const [isKeyShown, setIsKeyShown] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const statusId = useId()
  const badge = calculateTavilyKeyBadge(savedApiKey, keyCheck)
  const message = formatTavilyKeyMessage({
    savedApiKey,
    draft,
    saveState,
    keyCheck
  })
  const parsedDraft = parseTavilyKeyDraft(draft, savedApiKey)
  const isSaving = saveState.status === "saving"
  const fieldValue =
    draft.status === "edited"
      ? draft.text
      : isKeyShown && savedApiKey !== null
        ? savedApiKey
        : ""

  /**
   * Saves the edited key when it is valid and new.
   *
   * @param event - Submit event of the field's form.
   */
  async function handleSubmitKey(
    event: FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault()
    if (parsedDraft.status !== "changed" || isSaving) return
    const outcome = await onSaveTavilyApiKey(parsedDraft.apiKey)
    if (outcome !== "saved") return
    setDraft(UNEDITED_DRAFT)
    setIsKeyShown(false)
  }

  /** Removes the saved key and moves focus to the field once it is gone. */
  async function handleRemoveKey(): Promise<void> {
    const outcome = await onRemoveTavilyApiKey()
    if (outcome !== "saved") return
    setDraft(UNEDITED_DRAFT)
    setIsKeyShown(false)
    fieldRef.current?.focus()
  }

  /**
   * Discards the edit on Escape.
   *
   * @param event - Key pressed in the field.
   */
  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape" || draft.status === "unedited") return
    event.preventDefault()
    setDraft(UNEDITED_DRAFT)
  }

  return (
    <article
      aria-labelledby={`${fieldId}-name`}
      className="settings-view__secret-card"
    >
      <div className="settings-view__secret-card-header">
        <div className="settings-view__identity-lines">
          <h3 id={`${fieldId}-name`}>Tavily</h3>
          <p>
            Search built for agents. Lys asks it for titles, links, and short
            snippets.
          </p>
        </div>
        <span className="settings-view__secret-state" data-tone={badge.tone}>
          {badge.label}
        </span>
      </div>

      <form
        className="settings-view__secret-form"
        onSubmit={(event) => void handleSubmitKey(event)}
      >
        <div className="settings-view__secret-label-line">
          <label htmlFor={fieldId}>API key</label>
          <a href={TAVILY_KEY_PAGE_URL} rel="noreferrer" target="_blank">
            get a key <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="settings-view__secret-entry">
          <div className="settings-view__secret-field">
            <Input
              aria-describedby={statusId}
              aria-invalid={parsedDraft.status === "invalid" ? true : undefined}
              autoComplete="off"
              id={fieldId}
              onChange={(event) =>
                setDraft({ status: "edited", text: event.target.value })
              }
              onKeyDown={handleFieldKeyDown}
              placeholder={
                savedApiKey === null
                  ? TAVILY_KEY_PLACEHOLDER
                  : maskTavilyApiKey(savedApiKey)
              }
              ref={fieldRef}
              spellCheck={false}
              type={isKeyShown ? "text" : "password"}
              value={fieldValue}
            />
            <Button
              aria-label="Show Tavily API key"
              aria-pressed={isKeyShown}
              onClick={() => setIsKeyShown((isShown) => !isShown)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Eye aria-hidden="true" />
            </Button>
          </div>
          <Button
            disabled={parsedDraft.status !== "changed" || isSaving}
            size="sm"
            type="submit"
          >
            Save
          </Button>
        </div>
      </form>

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
              disabled={keyCheck.status === "checking"}
              onClick={() => void onCheckTavilyApiKey()}
              size="sm"
              type="button"
              variant="outline"
            >
              Test
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => void handleRemoveKey()}
              size="sm"
              type="button"
              variant="outline"
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  )
}
