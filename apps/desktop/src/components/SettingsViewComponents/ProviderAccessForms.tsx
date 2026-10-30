import { Eye } from "lucide-react"
import type { FormEvent, KeyboardEvent, ReactElement, RefObject } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DEFAULT_PROVIDER_ADDRESSES,
  LLM_PROVIDER_NAMES,
  type AddressedLlmProvider,
  type KeyedLlmProvider
} from "@/lib/models/llm-provider-target"
import type { ProviderApiKeyChange } from "@/lib/store/provider-settings"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"
import type { ProviderAddress } from "@lys/share"

import {
  calculateProviderKeyFieldValue,
  findSavedProviderAddress,
  findSavedProviderApiKey,
  formatProviderAddressPlaceholder,
  formatProviderKeyPlaceholder,
  parseProviderAddressDraft,
  parseProviderKeyDraft,
  PROVIDER_KEY_PAGE_URLS,
  UNEDITED_PROVIDER_DRAFT,
  type ProviderFieldDraft
} from "./provider-presentation"

/** Properties both forms share. */
type ProviderFormProps = {
  /** Identifier of the input, which the form's label names. */
  readonly fieldId: string
  /** Identifier of the status line that describes the input. */
  readonly statusId: string
  /** The person's edit, owned by the card. */
  readonly draft: ProviderFieldDraft
  /** Whether a provider save runs, which blocks another. */
  readonly isSaving: boolean
  /** Proposes a replacement for the card's edit: typed text, or unedited on Escape. */
  readonly onDraftChange: (draft: ProviderFieldDraft) => void
}

/** Properties accepted by {@link ProviderAddressForm}. */
type ProviderAddressFormProps = ProviderFormProps & {
  /** Provider whose address the form edits. */
  readonly provider: AddressedLlmProvider
  /** Saved provider choice and addresses. */
  readonly providers: ProvidersSettings
  /** Whether the backend is connecting, which blocks Test. */
  readonly isConnecting: boolean
  /**
   * Requests that the card save a new address, or null for the default;
   * called once per accepted submit.
   */
  readonly onSaveAddress: (address: ProviderAddress | null) => void
  /** Requests that the card connect to the saved address again. */
  readonly onTest: () => void
}

/** Properties accepted by {@link ProviderKeyForm}. */
type ProviderKeyFormProps = ProviderFormProps & {
  /** Provider whose key the form edits. */
  readonly provider: KeyedLlmProvider
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /**
   * Parent-owned ref attached to the input, used to move focus into the
   * field after a removal.
   */
  readonly fieldRef: RefObject<HTMLInputElement | null>
  /** Whether the key shows as text instead of bullets. */
  readonly isKeyShown: boolean
  /** Proposes showing or hiding the key. */
  readonly onIsKeyShownChange: (isKeyShown: boolean) => void
  /** Requests that the card save a valid new key; called once per accepted submit. */
  readonly onSaveKey: (change: ProviderApiKeyChange) => void
}

/**
 * Builds the Escape handler that proposes discarding an edit.
 *
 * @param draft - The person's edit.
 * @param onDraftChange - Receives the unedited draft.
 * @returns The input's key handler.
 */
function buildDiscardOnEscape(
  draft: ProviderFieldDraft,
  onDraftChange: (draft: ProviderFieldDraft) => void
): (event: KeyboardEvent<HTMLInputElement>) => void {
  return (event) => {
    if (event.key !== "Escape" || draft.status === "unedited") return
    event.preventDefault()
    onDraftChange(UNEDITED_PROVIDER_DRAFT)
  }
}

/**
 * Presents the form that sets a provider's server address: its label, the
 * default address, the `http://` prefix and the field, and one button that
 * saves an edited address or tests the saved one.
 *
 * @remarks The card owns the edit; the form owns no state or effects. The
 * field starts empty, with the saved or default address as its placeholder;
 * emptying it and saving returns to the default. Enter submits. The button
 * reads Save while the field holds a new valid address, and Test otherwise,
 * which connects to the saved address again.
 * @param props - Identifiers, provider, saved settings, edit, and requests.
 * @returns The form.
 */
export function ProviderAddressForm({
  fieldId,
  statusId,
  draft,
  isSaving,
  isConnecting,
  provider,
  providers,
  onDraftChange,
  onSaveAddress,
  onTest
}: ProviderAddressFormProps): ReactElement {
  const parsedDraft = parseProviderAddressDraft(
    draft,
    findSavedProviderAddress(provider, providers)
  )
  const isEdited = parsedDraft.status !== "unchanged"

  /**
   * Asks the card to save the edited address when it is valid and new.
   *
   * @param event - Submit event of the form.
   */
  function handleSubmitAddress(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (parsedDraft.status !== "changed" || isSaving) return
    onSaveAddress(parsedDraft.address)
  }

  return (
    <form className="settings-view__secret-form" onSubmit={handleSubmitAddress}>
      <div className="settings-view__secret-label-line">
        <label htmlFor={fieldId}>Server address</label>
        <span className="settings-view__provider-hint">
          default {DEFAULT_PROVIDER_ADDRESSES[provider]}
        </span>
      </div>
      <div className="settings-view__secret-entry">
        <div className="settings-view__secret-field settings-view__provider-address">
          <span aria-hidden="true">http://</span>
          <Input
            aria-describedby={statusId}
            aria-invalid={parsedDraft.status === "invalid" ? true : undefined}
            autoComplete="off"
            id={fieldId}
            onChange={(event) =>
              onDraftChange({ status: "edited", text: event.target.value })
            }
            onKeyDown={buildDiscardOnEscape(draft, onDraftChange)}
            placeholder={formatProviderAddressPlaceholder(provider, providers)}
            spellCheck={false}
            type="text"
            value={draft.status === "edited" ? draft.text : ""}
          />
        </div>
        {isEdited ? (
          <Button
            disabled={parsedDraft.status !== "changed" || isSaving}
            size="sm"
            type="submit"
          >
            Save
          </Button>
        ) : (
          <Button
            disabled={isSaving || isConnecting}
            onClick={onTest}
            size="sm"
            type="button"
            variant="outline"
          >
            Test
          </Button>
        )}
      </div>
    </form>
  )
}

/**
 * Presents the form that saves a provider's API key: its label, a link to
 * the provider's key page, the key field with its show and hide button, and
 * Save.
 *
 * @remarks The card owns the edit and whether the key is shown; the form
 * owns no state or effects. The field starts empty, with the masked saved
 * key as its placeholder; showing the key puts the saved key in it. Enter
 * submits, and Save is enabled only for a valid key that differs from the
 * saved one while no save runs.
 * @param props - Identifiers, ref, provider, saved keys, edit, and requests.
 * @returns The form.
 */
export function ProviderKeyForm({
  fieldId,
  statusId,
  fieldRef,
  draft,
  isSaving,
  isKeyShown,
  provider,
  secrets,
  onDraftChange,
  onIsKeyShownChange,
  onSaveKey
}: ProviderKeyFormProps): ReactElement {
  const name = LLM_PROVIDER_NAMES[provider]
  const parsedDraft = parseProviderKeyDraft(provider, draft, secrets)

  /**
   * Asks the card to save the edited key when it is valid and new.
   *
   * @param event - Submit event of the form.
   */
  function handleSubmitKey(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (parsedDraft.status !== "changed" || isSaving) return
    onSaveKey(parsedDraft.change)
  }

  return (
    <form className="settings-view__secret-form" onSubmit={handleSubmitKey}>
      <div className="settings-view__secret-label-line">
        <label htmlFor={fieldId}>{name} API key</label>
        <a
          href={PROVIDER_KEY_PAGE_URLS[provider]}
          rel="noreferrer"
          target="_blank"
        >
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
              onDraftChange({ status: "edited", text: event.target.value })
            }
            onKeyDown={buildDiscardOnEscape(draft, onDraftChange)}
            placeholder={formatProviderKeyPlaceholder(provider, secrets)}
            ref={fieldRef}
            spellCheck={false}
            type={isKeyShown ? "text" : "password"}
            value={calculateProviderKeyFieldValue(
              draft,
              isKeyShown,
              findSavedProviderApiKey(provider, secrets)
            )}
          />
          <Button
            aria-label={`Show ${name} API key`}
            aria-pressed={isKeyShown}
            onClick={() => onIsKeyShownChange(!isKeyShown)}
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
  )
}
