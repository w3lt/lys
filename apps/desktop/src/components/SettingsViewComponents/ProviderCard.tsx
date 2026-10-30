import type { LlmProvider, ProviderAddress } from "@lys/share"
import { useId, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type {
  ProviderApiKeyChange,
  ProviderSettingsSaveOutcome,
  ProviderSettingsSaveState
} from "@/lib/store/provider-settings"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"

import { ProviderAddressForm, ProviderKeyForm } from "./ProviderAccessForms"
import {
  buildProvidersWithAddress,
  calculateProviderBadge,
  findProviderAccessKind,
  findSavedProviderApiKey,
  formatProviderMessage,
  formatProviderModeTag,
  OLLAMA_PROVIDER_LABELS,
  OLLAMA_PROVIDER_NOTES,
  OLLAMA_PROVIDERS,
  PROVIDER_CARD_PROVIDERS,
  PROVIDER_CARDS,
  PROVIDER_DESCRIPTIONS,
  UNEDITED_PROVIDER_DRAFT,
  type OllamaLlmProvider,
  type ProviderAccessKind,
  type ProviderCardKind,
  type ProviderFieldDraft
} from "./provider-presentation"

/** Requests a provider card sends to the pane. */
export type ProviderCardRequests = {
  /** Requests that the pane save a new provider choice; never rejects. */
  readonly onSaveProviders: (
    providers: ProvidersSettings
  ) => Promise<ProviderSettingsSaveOutcome>
  /** Requests that the pane save or remove a provider key; never rejects. */
  readonly onSaveApiKey: (
    change: ProviderApiKeyChange
  ) => Promise<ProviderSettingsSaveOutcome>
  /** Requests that the pane connect to the active provider again. */
  readonly onTest: () => void
}

/** Properties accepted by {@link ProviderCard}. */
type ProviderCardProps = ProviderCardRequests & {
  /** Card to present. */
  readonly card: ProviderCardKind
  /** Name shared by the pane's radio buttons. */
  readonly radioName: string
  /** Saved provider choice and addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /** Latest published connection status of the backend's provider. */
  readonly status: LmStudioStatus
  /** Latest provider save, owned by the application store. */
  readonly saveState: ProviderSettingsSaveState
}

/** Properties accepted by {@link ProviderCardBody}. */
type ProviderCardBodyProps = ProviderCardRequests & {
  /** Active provider the body configures. */
  readonly provider: LlmProvider
  /** Saved provider choice and addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /** Latest published connection status. */
  readonly status: LmStudioStatus
  /** Latest provider save. */
  readonly saveState: ProviderSettingsSaveState
}

/** Properties accepted by {@link OllamaProviderRow}. */
type OllamaProviderRowProps = {
  /** Active Ollama provider: a local server or Ollama Cloud. */
  readonly provider: OllamaLlmProvider
  /** Whether a provider save runs, which blocks another. */
  readonly isSaving: boolean
  /** Requests that the card make the other Ollama provider active. */
  readonly onProviderChange: (provider: OllamaLlmProvider) => void
}

/** Properties accepted by {@link ProviderCardFooter}. */
type ProviderCardFooterProps = {
  /** Identifier of the status line, which describes the form's field. */
  readonly statusId: string
  /** How the provider is reached. */
  readonly access: ProviderAccessKind
  /** Saved provider choice and addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /** Latest published connection status. */
  readonly status: LmStudioStatus
  /** Latest provider save. */
  readonly saveState: ProviderSettingsSaveState
  /** The person's edit of the form's field. */
  readonly draft: ProviderFieldDraft
  /** Requests that the card connect again. */
  readonly onTest: () => void
  /** Requests that the card remove the saved key. */
  readonly onRemoveKey: () => void
}

/**
 * Presents the Ollama card's Local and Cloud row: a note on what the active
 * Ollama provider means, and a button per Ollama provider.
 *
 * @remarks A pure projection of its props; the pressed button is the active
 * provider, and the buttons are disabled while a save runs.
 * @param props - Active Ollama provider, whether a save runs, and the request.
 * @returns The row.
 */
function OllamaProviderRow({
  provider,
  isSaving,
  onProviderChange
}: OllamaProviderRowProps): ReactElement {
  const labelId = useId()
  return (
    <div className="settings-view__provider-mode-row">
      <div className="settings-view__identity-lines">
        <h3 id={labelId}>Configure</h3>
        <p>{OLLAMA_PROVIDER_NOTES[provider]}</p>
      </div>
      <fieldset
        aria-labelledby={labelId}
        className="settings-view__provider-modes"
      >
        {OLLAMA_PROVIDERS.map((candidate) => (
          <Button
            aria-pressed={candidate === provider}
            disabled={isSaving}
            key={candidate}
            onClick={() => {
              if (candidate !== provider) onProviderChange(candidate)
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {OLLAMA_PROVIDER_LABELS[candidate]}
          </Button>
        ))}
      </fieldset>
    </div>
  )
}

/**
 * Presents the active card's status line and, while its key is saved and
 * unedited, Test and Remove.
 *
 * @remarks A pure projection of its props. The status line is a polite live
 * region. Test is disabled while the backend connects or a save runs, and
 * Remove while a save runs.
 * @param props - Status identifier, the facts the line describes, and the
 * requests.
 * @returns The footer.
 */
function ProviderCardFooter({
  statusId,
  access,
  providers,
  secrets,
  status,
  saveState,
  draft,
  onTest,
  onRemoveKey
}: ProviderCardFooterProps): ReactElement {
  const message = formatProviderMessage({
    access,
    providers,
    secrets,
    status,
    saveState,
    draft
  })
  const isKeySaved =
    access.kind === "key" &&
    findSavedProviderApiKey(access.provider, secrets) !== null

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
      {isKeySaved && draft.status === "unedited" ? (
        <div className="settings-view__secret-actions">
          <Button
            disabled={status === "connecting" || saveState.status === "saving"}
            onClick={onTest}
            size="sm"
            type="button"
            variant="outline"
          >
            Test
          </Button>
          <Button
            disabled={saveState.status === "saving"}
            onClick={onRemoveKey}
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
 * Presents the active provider's settings: for an Ollama provider, the row
 * that switches between a local server and Ollama Cloud; the address or key
 * form; and the status line.
 *
 * @remarks The application store owns the saved settings, the save, and the
 * connection; the body owns only the person's edit and whether a key is
 * shown, which reset after a save that succeeded and whenever the form
 * changes between address and key. After Remove succeeds, focus moves to the
 * key field, because Remove leaves.
 * @param props - Provider, saved settings, connection, save, and requests.
 * @returns The body.
 */
function ProviderCardBody({
  provider,
  providers,
  secrets,
  status,
  saveState,
  onSaveProviders,
  onSaveApiKey,
  onTest
}: ProviderCardBodyProps): ReactElement {
  const access = findProviderAccessKind(provider)
  const [draft, setDraft] = useState<ProviderFieldDraft>(
    UNEDITED_PROVIDER_DRAFT
  )
  const [isKeyShown, setIsKeyShown] = useState(false)
  const [editedAccessKind, setEditedAccessKind] = useState(access.kind)
  const fieldRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const statusId = useId()
  const isSaving = saveState.status === "saving"

  if (editedAccessKind !== access.kind) {
    setEditedAccessKind(access.kind)
    setDraft(UNEDITED_PROVIDER_DRAFT)
    setIsKeyShown(false)
  }

  /** Resets the edit and hides the key again, discarding the typed text. */
  function resetEdit(): void {
    setDraft(UNEDITED_PROVIDER_DRAFT)
    setIsKeyShown(false)
  }

  /**
   * Saves an address and resets the edit once it is saved.
   *
   * @param address - New address, or null for the default.
   */
  async function handleSaveAddress(
    address: ProviderAddress | null
  ): Promise<void> {
    if (access.kind !== "address") return
    const next = buildProvidersWithAddress(providers, access.provider, address)
    if ((await onSaveProviders(next)) === "saved") resetEdit()
  }

  /**
   * Saves a key and resets the edit once it is saved.
   *
   * @param change - Provider and key.
   */
  async function handleSaveKey(change: ProviderApiKeyChange): Promise<void> {
    if ((await onSaveApiKey(change)) === "saved") resetEdit()
  }

  /** Removes the saved key and moves focus to the field once it is gone. */
  async function handleRemoveKey(): Promise<void> {
    if (access.kind !== "key") return
    if (
      (await onSaveApiKey({ provider: access.provider, apiKey: null })) !==
      "saved"
    )
      return
    resetEdit()
    fieldRef.current?.focus()
  }

  return (
    <div className="settings-view__provider-body">
      {provider === "ollama" || provider === "ollamaCloud" ? (
        <OllamaProviderRow
          isSaving={isSaving}
          onProviderChange={(active) =>
            void onSaveProviders({ ...providers, active })
          }
          provider={provider}
        />
      ) : null}
      {access.kind === "address" ? (
        <ProviderAddressForm
          draft={draft}
          fieldId={fieldId}
          isConnecting={status === "connecting"}
          isSaving={isSaving}
          onDraftChange={setDraft}
          onSaveAddress={(address) => void handleSaveAddress(address)}
          onTest={onTest}
          provider={access.provider}
          providers={providers}
          statusId={statusId}
        />
      ) : (
        <ProviderKeyForm
          draft={draft}
          fieldId={fieldId}
          fieldRef={fieldRef}
          isKeyShown={isKeyShown}
          isSaving={isSaving}
          onDraftChange={setDraft}
          onIsKeyShownChange={setIsKeyShown}
          onSaveKey={(change) => void handleSaveKey(change)}
          provider={access.provider}
          secrets={secrets}
          statusId={statusId}
        />
      )}
      <ProviderCardFooter
        access={access}
        draft={draft}
        onRemoveKey={() => void handleRemoveKey()}
        onTest={onTest}
        providers={providers}
        saveState={saveState}
        secrets={secrets}
        status={status}
        statusId={statusId}
      />
    </div>
  )
}

/**
 * Presents one card: a radio button that makes its provider the active one,
 * its logo, name, mode, and line, its badge, and, while it presents the
 * active provider, that provider's settings.
 *
 * @remarks Picking a card saves the choice of
 * {@link PROVIDER_CARD_PROVIDERS}' provider, which makes the backend connect
 * to it; Ollama's card then makes the local server active. The radio button
 * is disabled while a save runs. Only the card of the active provider shows
 * its settings. The logo is a bundled file of the app, decorative next to
 * the name.
 * @param props - Card, radio name, saved settings, connection, save, and
 * requests.
 * @returns The card.
 */
export default function ProviderCard({
  card,
  radioName,
  providers,
  secrets,
  status,
  saveState,
  onSaveProviders,
  onSaveApiKey,
  onTest
}: ProviderCardProps): ReactElement {
  const nameId = useId()
  const lineId = useId()
  const description = PROVIDER_DESCRIPTIONS[card]
  const isActive = PROVIDER_CARDS[providers.active] === card
  const badge = calculateProviderBadge(card, providers, secrets, status)

  return (
    <article
      aria-labelledby={nameId}
      className="settings-view__provider-card"
      data-active={isActive}
    >
      <label className="settings-view__provider-header">
        <input
          aria-describedby={lineId}
          aria-labelledby={nameId}
          checked={isActive}
          className="settings-view__provider-radio"
          disabled={saveState.status === "saving"}
          name={radioName}
          onChange={() =>
            void onSaveProviders({
              ...providers,
              active: PROVIDER_CARD_PROVIDERS[card]
            })
          }
          type="radio"
          value={card}
        />
        <img
          alt=""
          className="settings-view__provider-logo"
          height={36}
          src={description.logoUrl}
          width={36}
        />
        <span className="settings-view__provider-identity">
          <span className="settings-view__provider-name-line">
            <span className="settings-view__provider-name" id={nameId}>
              {description.name}
            </span>
            <span className="settings-view__provider-tag">
              {formatProviderModeTag(card, providers)}
            </span>
          </span>
          <span className="settings-view__provider-line" id={lineId}>
            {description.blurb}
          </span>
        </span>
        <span className="settings-view__secret-state" data-tone={badge.tone}>
          {badge.label}
        </span>
      </label>
      {isActive ? (
        <ProviderCardBody
          onSaveApiKey={onSaveApiKey}
          onSaveProviders={onSaveProviders}
          onTest={onTest}
          provider={providers.active}
          providers={providers}
          saveState={saveState}
          secrets={secrets}
          status={status}
        />
      ) : null}
    </article>
  )
}
