import type { LlmProvider, ProviderAddress } from "@lys/share"
import { useId, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { findSavedProviderApiKey } from "@/lib/models/llm-provider-target"
import type { BackendServerStatus } from "@/lib/store"
import type { LlmProviderStatus } from "@/lib/store/model-runtime"
import type {
  ProviderApiKeyChange,
  ProviderSettingsSaveOutcome,
  ProviderSettingsSaveState
} from "@/lib/store/provider-settings"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"

import { ProviderAddressForm, ProviderKeyForm } from "./ProviderAccessForms"
import {
  buildProvidersWithAddress,
  buildProvidersWithProviderOn,
  calculateProviderBadge,
  findProviderAccessKind,
  formatProviderMessage,
  formatProviderSaveMessage,
  isProviderOn,
  PROVIDER_DESCRIPTIONS,
  UNEDITED_PROVIDER_DRAFT,
  type ProviderBadge,
  type ProviderStatusInput
} from "./provider-presentation"

/** Requests a provider card sends to the pane. */
export type ProviderCardRequests = {
  /**
   * Requests that the pane save new provider settings for the card's
   * provider, which the save's state names; never rejects.
   */
  readonly onSaveProviders: (
    provider: LlmProvider,
    providers: ProvidersSettings
  ) => Promise<ProviderSettingsSaveOutcome>
  /** Requests that the pane save or remove a provider key; never rejects. */
  readonly onSaveApiKey: (
    change: ProviderApiKeyChange
  ) => Promise<ProviderSettingsSaveOutcome>
  /** Requests that the pane connect to the card's provider again. */
  readonly onTest: () => void
}

/** Properties accepted by {@link ProviderCard}. */
type ProviderCardProps = ProviderCardRequests & {
  /** Provider the card presents. */
  readonly provider: LlmProvider
  /** Saved providers and addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /** Latest published connection status of the card's provider. */
  readonly status: LlmProviderStatus
  /** Backend lifecycle state, which explains an `unknown` status. */
  readonly backendStatus: BackendServerStatus
  /** Latest provider save, owned by the application store. */
  readonly saveState: ProviderSettingsSaveState
}

/** Properties accepted by {@link ProviderCardBody}. */
type ProviderCardBodyProps = ProviderCardRequests & {
  /** Turned-on provider the body configures. */
  readonly provider: LlmProvider
  /** Saved providers and addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /** Latest published connection status of that provider. */
  readonly status: LlmProviderStatus
  /** Backend lifecycle state, which explains an `unknown` status. */
  readonly backendStatus: BackendServerStatus
  /** Latest provider save. */
  readonly saveState: ProviderSettingsSaveState
}

/** Properties accepted by {@link ProviderCardHeader}. */
type ProviderCardHeaderProps = {
  /** Provider the header names. */
  readonly provider: LlmProvider
  /**
   * Identifier given to the provider's name, which names the card and the
   * switch.
   */
  readonly nameId: string
  /** State the badge shows. */
  readonly badge: ProviderBadge
  /** Whether the saved settings turn the provider on. */
  readonly isOn: boolean
  /** Whether a provider save runs, which disables the switch. */
  readonly isSaving: boolean
  /**
   * Proposes turning the provider on or off; called once per flip of the
   * switch.
   *
   * @param isOn - Whether the provider is to be on.
   */
  readonly onIsOnChange: (isOn: boolean) => void
}

/** Properties accepted by {@link ProviderCardFooter}. */
type ProviderCardFooterProps = {
  /** Identifier of the status line, which describes the form's field. */
  readonly statusId: string
  /**
   * Facts the status line describes: how the provider is reached, the saved
   * providers and keys, its connection, the backend's state, and the
   * person's edit of the form's field. They also tell whether Test and
   * Remove show, for a saved and unedited key, and whether Test is disabled,
   * while the provider connects.
   */
  readonly lineFacts: ProviderStatusInput
  /** Latest provider save, which disables Test and Remove while it runs. */
  readonly saveState: ProviderSettingsSaveState
  /** Requests that the card connect again. */
  readonly onTest: () => void
  /** Requests that the card remove the saved key. */
  readonly onRemoveKey: () => void
}

/**
 * Presents a provider card's header: the provider's logo, name, tag, and
 * line, its badge, and the switch that turns it on or off.
 *
 * @remarks A pure projection of its props. The switch is named after the
 * provider, described by its line, checked while the provider is on, and
 * disabled while a save runs. The logo is the provider's monochrome mark
 * from `@lobehub/icons`, drawn in the text color and hidden from assistive
 * technology, because the name beside it says the same.
 * @param props - Provider, the name's identifier, the badge, whether the
 * provider is on and a save runs, and the request to turn it on or off.
 * @returns The header.
 */
function ProviderCardHeader({
  provider,
  nameId,
  badge,
  isOn,
  isSaving,
  onIsOnChange
}: ProviderCardHeaderProps): ReactElement {
  const lineId = useId()
  const description = PROVIDER_DESCRIPTIONS[provider]

  return (
    <div className="settings-view__provider-header">
      <description.logo
        aria-hidden="true"
        className="settings-view__provider-logo"
        size={36}
      />
      <div className="settings-view__provider-identity">
        <div className="settings-view__provider-name-line">
          <h3 className="settings-view__provider-name" id={nameId}>
            {description.name}
          </h3>
          <span className="settings-view__provider-tag">{description.tag}</span>
        </div>
        <p className="settings-view__provider-line" id={lineId}>
          {description.blurb}
        </p>
      </div>
      <span className="settings-view__secret-state" data-tone={badge.tone}>
        {badge.label}
      </span>
      <Switch
        aria-describedby={lineId}
        aria-labelledby={nameId}
        checked={isOn}
        disabled={isSaving}
        onCheckedChange={onIsOnChange}
        size="lg"
      />
    </div>
  )
}

/**
 * Presents a turned-on card's status line and, while its key is saved and
 * unedited, Test and Remove.
 *
 * @remarks A pure projection of its props. The status line is a polite live
 * region. Test is disabled while the provider connects or a save runs, and
 * Remove while a save runs.
 * @param props - Status identifier, the facts the line describes, the save,
 * and the requests.
 * @returns The footer.
 */
function ProviderCardFooter({
  statusId,
  lineFacts,
  saveState,
  onTest,
  onRemoveKey
}: ProviderCardFooterProps): ReactElement {
  const { access, secrets, status, draft } = lineFacts
  const message = formatProviderMessage(lineFacts)
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
 * Presents a turned-on provider's settings: the address or key form, and the
 * status line.
 *
 * @remarks The application store owns the saved settings, the save, and the
 * connection; the body owns only the person's edit and whether a key is
 * shown, which reset after a save that succeeded and when the provider is
 * turned off, which unmounts the body. After Remove succeeds, focus moves to
 * the key field, because Remove leaves.
 * @param props - Provider, saved settings, connection, save, and requests.
 * @returns The body.
 */
function ProviderCardBody({
  provider,
  providers,
  secrets,
  status,
  backendStatus,
  saveState,
  onSaveProviders,
  onSaveApiKey,
  onTest
}: ProviderCardBodyProps): ReactElement {
  const access = findProviderAccessKind(provider)
  const [draft, setDraft] = useState(UNEDITED_PROVIDER_DRAFT)
  const [isKeyShown, setIsKeyShown] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const statusId = useId()
  const isSaving = saveState.status === "saving"

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
    if ((await onSaveProviders(access.provider, next)) === "saved") resetEdit()
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
        lineFacts={{ access, providers, secrets, status, backendStatus, draft }}
        onRemoveKey={() => void handleRemoveKey()}
        onTest={onTest}
        saveState={saveState}
        statusId={statusId}
      />
    </div>
  )
}

/**
 * Presents one provider's card: its logo, name, tag, and line, its badge, a
 * switch that turns it on or off, while it is on its settings, and its save
 * line.
 *
 * @remarks Flipping the switch saves the enabled list with the provider
 * added or removed, in provider order, which makes the backend connect to it
 * or let it go; the other turned-on providers stay on. The switch is named
 * after the provider, described by its line, checked while the saved
 * settings turn the provider on, and disabled while a save runs. Only a card
 * whose provider is on shows its settings. The save line is a polite status
 * region named after the provider that stays in the card whether the
 * provider is on or off, so a save of this provider, of its switch, address,
 * or key, is said and announced once, on this card only, even while no
 * provider is on; it is empty otherwise. The logo is the provider's
 * monochrome mark from `@lobehub/icons`, drawn in the text color and hidden
 * from assistive technology, because the name beside it says the same.
 * @param props - Provider, saved settings, connection, save, and requests.
 * @returns The card.
 */
export default function ProviderCard({
  provider,
  providers,
  secrets,
  status,
  backendStatus,
  saveState,
  onSaveProviders,
  onSaveApiKey,
  onTest
}: ProviderCardProps): ReactElement {
  const nameId = useId()
  const { name } = PROVIDER_DESCRIPTIONS[provider]
  const isOn = isProviderOn(provider, providers)
  const saveMessage = formatProviderSaveMessage(provider, saveState)

  return (
    <article
      aria-labelledby={nameId}
      className="settings-view__provider-card"
      data-active={isOn}
    >
      <ProviderCardHeader
        badge={calculateProviderBadge({ provider, providers, secrets, status })}
        isOn={isOn}
        isSaving={saveState.status === "saving"}
        nameId={nameId}
        onIsOnChange={(proposedIsOn) =>
          void onSaveProviders(
            provider,
            buildProvidersWithProviderOn(providers, provider, proposedIsOn)
          )
        }
        provider={provider}
      />
      {isOn ? (
        <ProviderCardBody
          backendStatus={backendStatus}
          onSaveApiKey={onSaveApiKey}
          onSaveProviders={onSaveProviders}
          onTest={onTest}
          provider={provider}
          providers={providers}
          saveState={saveState}
          secrets={secrets}
          status={status}
        />
      ) : null}
      <p
        aria-label={`${name} save`}
        aria-live="polite"
        className="settings-view__secret-status settings-view__provider-save"
        data-tone={saveMessage.tone}
        role="status"
      >
        {saveMessage.text}
      </p>
    </article>
  )
}
