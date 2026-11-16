import type { EmailAccount, EmailServerSettings } from "@lys/share"
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  Mail,
  Trash2
} from "lucide-react"
import {
  useId,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement
} from "react"

import { handleFocusTargetAttach } from "@/components/focus-target"
import { Button } from "@/components/ui/button"
import { NativeSelect } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { findEmailPreset } from "@/lib/models/email-presets"
import { useLysStore } from "@/lib/store"
import {
  isEmailAccountCheckRunning,
  isEmailAccountSaveRunning
} from "@/lib/store/email-settings"
import { useLocalProfileStore } from "@/lib/store/local-profile"

import {
  isRemovalQuestionShown,
  useEmailAccountRemoval,
  type EmailAccountRemoval
} from "./email-account-removal"
import { formatEmailMailboxConnection } from "./email-mailbox-connection"
import EmailMailboxCardView, {
  EmailMailboxBackButton
} from "./EmailMailboxCardView"
import {
  useEmailAccountSaves,
  useEmailMailboxFacts,
  useEmailServerStateRead,
  type EmailAccountSaves,
  type EmailMailboxFacts
} from "./email-mailbox-state"
import { useEmailMailboxView } from "./email-mailbox-view"
import { formatEmailSecurityLabel } from "./email-presentation"
import {
  formatClockTime,
  formatLysIdentitySummary,
  formatLysMailboxCheckMessage,
  formatLysMailboxSummary,
  formatTimeZoneOffset,
  listTimeZones
} from "./lys-presentation"
import SettingsPanelField from "./SettingsPanelField"
import SettingsPanelSection from "./SettingsPanelSection"

/** One option of the time zone field. */
type TimeZoneOption = {
  /** IANA time zone. */
  readonly zone: string
  /** The zone with its offset from UTC. */
  readonly label: string
}

/** Properties accepted by {@link LysTimeZoneField}. */
type LysTimeZoneFieldProps = {
  /** IANA time zone chosen now. */
  readonly timeZone: string
  /** Proposes another time zone. */
  readonly onTimeZoneChange: (timeZone: string) => void
}

/** Properties accepted by {@link LysMailboxAside}. */
type LysMailboxAsideProps = {
  /** What the stores hold about Lys's mailbox. */
  readonly facts: EmailMailboxFacts
  /** Whether the header shows the mailbox's switch. */
  readonly isSwitchShown: boolean
  /** Saves the mailbox's switch. */
  readonly onMailboxOnChange: (isOn: boolean) => void
}

/** Properties accepted by {@link LysMailboxServer}. */
type LysMailboxServerProps = {
  /** Which server the tile shows. */
  readonly side: "imap" | "smtp"
  /** The server. */
  readonly server: EmailServerSettings
  /** Provider named by the account's address, or undefined. */
  readonly provider: string | undefined
}

/** Properties accepted by {@link LysMailboxSummary}. */
type LysMailboxSummaryProps = {
  /** Lys's saved account. */
  readonly account: EmailAccount
  /** What the stores hold about Lys's mailbox. */
  readonly facts: EmailMailboxFacts
  /** The saves the mailbox proposes. */
  readonly saves: EmailAccountSaves
  /** Opens the account's fields. */
  readonly onEditAccount: () => void
  /** Attaches Edit servers while it must take focus; undefined otherwise. */
  readonly editRef: ((element: HTMLButtonElement | null) => void) | undefined
  /** Reports that the account was removed. */
  readonly onRemoveAccountComplete: () => void
}

/** Properties accepted by {@link LysMailboxFooter}. */
type LysMailboxFooterProps = {
  /** Lys's saved account. */
  readonly account: EmailAccount
  /** What the stores hold about Lys's mailbox. */
  readonly facts: EmailMailboxFacts
  /** The saves the mailbox proposes. */
  readonly saves: EmailAccountSaves
  /** Reports that the account was removed. */
  readonly onRemoveAccountComplete: () => void
}

/** Properties accepted by {@link LysMailboxRemovalQuestion}. */
type LysMailboxRemovalQuestionProps = {
  /** Address of Lys's saved account. */
  readonly address: string
  /** Whether a save of the mailbox runs, which disables both answers. */
  readonly isBusy: boolean
  /** The removal flow the answers drive. */
  readonly removal: Pick<
    EmailAccountRemoval,
    "closeRemovalQuestion" | "handleRemoveAccount"
  >
}

/** Titles of each server tile. */
const SERVER_TITLES = Object.freeze({
  imap: "Incoming · IMAP",
  smtp: "Outgoing · SMTP"
} satisfies Readonly<Record<LysMailboxServerProps["side"], string>>)

/**
 * Presents Lys's portrait and the control that replaces it.
 *
 * @remarks The local profile store owns the portrait; the component owns no
 * state. Without a picked image the portrait shows the first letter of
 * Lys's name. The file input is inside its label, so the label's text
 * names it and activating the label opens the picker.
 * @returns The portrait column.
 */
function LysPortrait(): ReactElement {
  const name = useLocalProfileStore((state) => state.lysIdentity.name)
  const portraitUrl = useLocalProfileStore((state) => state.lysPortraitUrl)
  const replaceLysPortrait = useLocalProfileStore(
    (state) => state.replaceLysPortrait
  )

  /**
   * Replaces the portrait with the picked image, when one was picked.
   *
   * @param event - Change of the file input.
   */
  function handlePortraitPick(event: ChangeEvent<HTMLInputElement>): void {
    const portrait = event.target.files?.[0]
    if (portrait !== undefined) replaceLysPortrait(portrait)
  }

  return (
    <div className="settings-view__portrait-column">
      <div aria-hidden="true" className="settings-view__portrait">
        {portraitUrl === null ? (
          <span className="settings-view__portrait-initial">
            {name.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          <img alt="" src={portraitUrl} />
        )}
      </div>
      <label className="settings-view__portrait-change">
        <span>Change portrait</span>
        <input
          accept="image/*"
          className="sr-only"
          onChange={handlePortraitPick}
          type="file"
        />
      </label>
    </div>
  )
}

/**
 * Builds the options of the time zone field.
 *
 * @param currentTimeZone - The zone chosen now.
 * @returns Each zone with its offset from UTC now.
 */
function buildTimeZoneOptions(
  currentTimeZone: string
): readonly TimeZoneOption[] {
  const now = new Date()
  return listTimeZones(currentTimeZone).map((zone) => ({
    zone,
    label: `${zone} · ${formatTimeZoneOffset(zone, now)}`
  }))
}

/**
 * Presents the choice of Lys's time zone.
 *
 * @remarks The parent owns the zone; the field owns only its list. Each
 * zone is listed with its offset from UTC when the field mounted; the list
 * is built once, with the zone chosen then, and every other zone it shows
 * comes from it.
 * @param props - The zone and the change proposal.
 * @returns The field.
 */
function LysTimeZoneField({
  timeZone,
  onTimeZoneChange
}: LysTimeZoneFieldProps): ReactElement {
  const fieldId = useId()
  const [options] = useState(() => buildTimeZoneOptions(timeZone))

  return (
    <div className="settings-view__panel-field">
      <label htmlFor={fieldId}>Time zone</label>
      <NativeSelect
        aria-describedby={`${fieldId}-help`}
        id={fieldId}
        onChange={(event) => onTimeZoneChange(event.target.value)}
        value={timeZone}
      >
        {options.map((option) => (
          <option key={option.zone} value={option.zone}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      <p className="settings-view__panel-help" id={`${fieldId}-help`}>
        Dates and times in Lys&apos;s messages use this zone.
      </p>
    </div>
  )
}

/**
 * Presents the fields of how Lys introduces itself: name, full name, time
 * zone, languages, and signature.
 *
 * @remarks The local profile store owns the values; the fields own no
 * state. Each change is kept at once.
 * @returns The fields.
 */
function AboutLysFields(): ReactElement {
  const identity = useLocalProfileStore((state) => state.lysIdentity)
  const update = useLocalProfileStore((state) => state.updateLysIdentity)

  return (
    <div className="settings-view__panel-fields">
      <SettingsPanelField
        help="Used in the From line and when Lys introduces itself."
        isOptional={false}
        label="Name"
        onValueChange={(name) => update({ name })}
        rows={null}
        value={identity.name}
      />
      <SettingsPanelField
        help="Given when someone asks Lys for its full name."
        isOptional
        label="Full name"
        onValueChange={(fullName) => update({ fullName })}
        rows={null}
        value={identity.fullName}
      />
      <LysTimeZoneField
        onTimeZoneChange={(timeZone) => update({ timeZone })}
        timeZone={identity.timeZone}
      />
      <SettingsPanelField
        help="The first is used unless a message is in another."
        isOptional={false}
        label="Writes in"
        onValueChange={(writesIn) => update({ writesIn })}
        rows={null}
        value={identity.writesIn}
      />
      <SettingsPanelField
        help="Added under every email Lys sends from its own address."
        isOptional={false}
        label="Signature"
        onValueChange={(signature) => update({ signature })}
        rows={3}
        value={identity.signature}
      />
    </div>
  )
}

/**
 * Presents the About Lys section: how Lys introduces itself.
 *
 * @remarks The local profile store owns the values and when they last
 * changed; the section owns no state. Each change is kept at once; the
 * header says when the latest one was made.
 * @returns The section.
 */
function AboutLysSection(): ReactElement {
  const identity = useLocalProfileStore((state) => state.lysIdentity)
  const editedAt = useLocalProfileStore((state) => state.lysIdentityEditedAt)

  return (
    <SettingsPanelSection
      aside={
        editedAt === null ? null : (
          <span className="settings-view__saved-at">
            <Check aria-hidden="true" />
            Saved at {formatClockTime(editedAt)}
          </span>
        )
      }
      description={null}
      eyebrow="About Lys"
      leading={null}
      section="about-lys"
      summary={formatLysIdentitySummary(identity)}
      title="How Lys introduces itself"
    >
      <div className="settings-view__about-lys">
        <LysPortrait />
        <AboutLysFields />
      </div>
    </SettingsPanelSection>
  )
}

/**
 * Presents the Email section's header aside: the mailbox's status and,
 * while the summary shows, its switch.
 *
 * @remarks The stores own the status and the switch; the aside owns no
 * state. The status names its state in words beside its dot. The switch is
 * disabled while a save of the MCP servers runs.
 * @param props - The mailbox's facts, whether the switch shows, and its
 * save.
 * @returns The aside.
 */
function LysMailboxAside({
  facts,
  isSwitchShown,
  onMailboxOnChange
}: LysMailboxAsideProps): ReactElement {
  const switchLabelId = useId()
  const status = formatEmailMailboxConnection(facts.connection)

  return (
    <div className="settings-view__panel-aside">
      <span className="settings-view__mailbox-status">
        <span
          aria-hidden="true"
          className="settings-view__status-dot"
          data-tone={status.tone}
        />
        {status.label}
      </span>
      {isSwitchShown ? (
        <>
          <span aria-hidden="true" className="settings-view__aside-divider" />
          <span id={switchLabelId}>Use this mailbox</span>
          <Switch
            aria-labelledby={switchLabelId}
            checked={facts.isMailboxOn}
            disabled={facts.isMailboxSwitchSaving}
            onCheckedChange={(checked) => onMailboxOnChange(checked)}
          />
        </>
      ) : null}
    </div>
  )
}

/**
 * Presents one server of Lys's mailbox: its address, security, and the
 * provider the account's address names.
 *
 * @param props - Side, server, and provider.
 * @returns The tile.
 */
function LysMailboxServer({
  side,
  server,
  provider
}: LysMailboxServerProps): ReactElement {
  const Icon = side === "imap" ? ArrowDownToLine : ArrowUpFromLine

  return (
    <div className="settings-view__mailbox-server">
      <span className="settings-view__eyebrow">
        <Icon aria-hidden="true" />
        {SERVER_TITLES[side]}
      </span>
      <span className="settings-view__mailbox-server-address">
        {server.host}:{server.port}
      </span>
      <div className="settings-view__chips">
        <span className="settings-view__chip" data-mono="">
          {formatEmailSecurityLabel(server.security)}
        </span>
        {provider === undefined ? null : (
          <span className="settings-view__chip">{provider}</span>
        )}
      </div>
    </div>
  )
}

/**
 * Presents the question whether to remove Lys's mailbox.
 *
 * @remarks The footer owns the removal flow; the question owns no state.
 * The question names the group; its choices are named `Keep Lys's mailbox`
 * and `Remove Lys's mailbox`. Keep, the least destructive choice, takes
 * focus when the question opens, and Escape on either choice keeps the
 * mailbox. While a save runs, both choices are disabled.
 * @param props - The address, whether a save runs, and the removal flow.
 * @returns The confirmation group.
 */
function LysMailboxRemovalQuestion({
  address,
  isBusy,
  removal
}: LysMailboxRemovalQuestionProps): ReactElement {
  const questionId = useId()

  /**
   * Keeps the mailbox when Escape is pressed on either choice.
   *
   * @param event - Key press on a confirmation button.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    removal.closeRemovalQuestion()
  }

  return (
    <fieldset
      aria-labelledby={questionId}
      className="settings-view__mailbox-removal"
      disabled={isBusy}
    >
      <p id={questionId}>
        Remove Lys&apos;s mailbox and its password? The email server stops
        reading and sending as {address}. Your own mailbox stays.
      </p>
      <div className="settings-view__mailbox-removal-actions">
        <Button
          aria-label="Keep Lys's mailbox"
          onClick={removal.closeRemovalQuestion}
          onKeyDown={handleConfirmationKeyDown}
          ref={handleFocusTargetAttach}
          size="sm"
          type="button"
          variant="outline"
        >
          Keep
        </Button>
        <Button
          aria-label="Remove Lys's mailbox"
          onClick={() => void removal.handleRemoveAccount()}
          onKeyDown={handleConfirmationKeyDown}
          size="sm"
          type="button"
          variant="destructive"
        >
          Remove
        </Button>
      </div>
    </fieldset>
  )
}

/**
 * Presents the line under Lys's mailbox and Remove mailbox, with the
 * question whether to remove it.
 *
 * @remarks The stores own the account and its removal; the footer owns,
 * through the card's removal flow, whether the question shows and whether
 * Remove mailbox takes focus back. Keep takes focus when the question
 * opens. The line is a polite live region.
 * @param props - The account, the mailbox's facts and saves, and the
 * removal report.
 * @returns The footer.
 */
function LysMailboxFooter({
  account,
  facts,
  saves,
  onRemoveAccountComplete
}: LysMailboxFooterProps): ReactElement {
  const { removeAccountRef, ...removal } = useEmailAccountRemoval(
    saves.handleRemoveEmailAccount,
    onRemoveAccountComplete
  )
  const message = formatLysMailboxCheckMessage(
    facts.saveState,
    facts.checkState
  )
  const isBusy = isEmailAccountSaveRunning(facts.saveState)

  if (isRemovalQuestionShown(removal.removalStep)) {
    return (
      <LysMailboxRemovalQuestion
        address={account.address}
        isBusy={isBusy}
        removal={removal}
      />
    )
  }
  return (
    <div className="settings-view__mailbox-footer">
      <p
        aria-live="polite"
        className="settings-view__mailbox-message"
        data-tone={message.tone}
        role="status"
      >
        {message.text}
      </p>
      <Button
        disabled={isBusy}
        onClick={removal.openRemovalQuestion}
        ref={removeAccountRef}
        size="sm"
        type="button"
        variant="destructive"
      >
        <Trash2 aria-hidden="true" />
        Remove mailbox
      </Button>
    </div>
  )
}

/**
 * Presents the identity of Lys's saved mailbox and its Edit servers
 * action.
 *
 * @param props - The account, and the edit request with its focus target.
 * @returns The identity row.
 */
function LysMailboxIdentity({
  account,
  onEditAccount,
  editRef
}: Pick<
  LysMailboxSummaryProps,
  "account" | "onEditAccount" | "editRef"
>): ReactElement {
  return (
    <div className="settings-view__mailbox-identity">
      <span aria-hidden="true" className="settings-view__mailbox-icon">
        <Mail />
      </span>
      <div className="settings-view__mailbox-lines">
        <span className="settings-view__mailbox-address">
          {account.address}
        </span>
        <span>
          Sends as{" "}
          <span className="settings-view__mono">
            {account.displayName} &lt;{account.address}&gt;
          </span>{" "}
          · signs in as {account.userName}
        </span>
      </div>
      <div className="settings-view__mailbox-actions">
        <Button
          onClick={onEditAccount}
          ref={editRef}
          type="button"
          variant="outline"
        >
          Edit servers
        </Button>
      </div>
    </div>
  )
}

/**
 * Presents the row that names the server using Lys's mailbox, and opens the
 * MCP pane.
 *
 * @returns The row.
 */
function LysMailboxUsedByRow(): ReactElement {
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  return (
    <div className="settings-view__panel-row">
      <div className="settings-view__row-lines">
        <span className="settings-view__row-title">Used by</span>
        <span>
          The <code>email</code> server reads and sends with this mailbox.
        </span>
      </div>
      <Button
        onClick={() => setSettingsPane("mcp")}
        size="sm"
        type="button"
        variant="ghost"
      >
        Open in MCP
        <ArrowUpRight aria-hidden="true" />
      </Button>
    </div>
  )
}

/**
 * Presents the rows of Lys's saved mailbox: its password, whether the
 * server keeps sent mail, and what uses it.
 *
 * @remarks The stores own the account, its password, and its saves; the
 * rows own no state. Changing whether the server keeps a copy of sent mail
 * saves the account again with its saved password, which signs in first;
 * the switch is disabled while the backend does not run, while a check,
 * save, or removal runs, or while no password is saved. Change opens the
 * account's fields; Open in MCP shows the MCP pane.
 * @param props - The account, the mailbox's facts and saves, and the edit
 * request.
 * @returns The rows.
 */
function LysMailboxRows({
  account,
  facts,
  saves,
  onEditAccount
}: Omit<
  LysMailboxSummaryProps,
  "onRemoveAccountComplete" | "editRef"
>): ReactElement {
  const sentCopyLabelId = useId()
  const password = facts.savedPassword
  const isSentCopyDisabled =
    password === null ||
    !facts.isBackendRunning ||
    isEmailAccountCheckRunning(facts.checkState) ||
    isEmailAccountSaveRunning(facts.saveState)

  /**
   * Saves the account again with the new choice and its saved password.
   *
   * @param serverKeepsSentCopy - Whether the server files sent mail itself.
   */
  function handleSentCopyChange(serverKeepsSentCopy: boolean): void {
    if (password === null) return
    void saves.handleSaveEmailAccount(
      { ...account, serverKeepsSentCopy },
      password
    )
  }

  return (
    <div className="settings-view__panel-rows">
      <div className="settings-view__panel-row">
        <div className="settings-view__row-lines">
          <span className="settings-view__row-title">Password</span>
          <span>Kept with this mailbox and sent only to its servers.</span>
        </div>
        <span aria-hidden="true" className="settings-view__mono">
          ••••••••••••
        </span>
        <Button
          aria-label="Change password"
          onClick={onEditAccount}
          size="sm"
          type="button"
          variant="ghost"
        >
          Change
        </Button>
      </div>
      <div className="settings-view__panel-row">
        <div className="settings-view__row-lines">
          <span className="settings-view__row-title" id={sentCopyLabelId}>
            Server keeps a copy of sent mail
          </span>
          <span>
            On when the server files sent mail itself, as Gmail does. Off makes
            Lys file the copy in Sent.
          </span>
        </div>
        <Switch
          aria-labelledby={sentCopyLabelId}
          checked={account.serverKeepsSentCopy}
          disabled={isSentCopyDisabled}
          onCheckedChange={(checked) => handleSentCopyChange(checked)}
        />
      </div>
      <LysMailboxUsedByRow />
    </div>
  )
}

/**
 * Presents Lys's saved mailbox: who it sends as, its servers, its rows,
 * and its removal.
 *
 * @remarks The stores own the account and its saves; the summary owns no
 * state. Edit servers opens the account's fields.
 * @param props - The account, the mailbox's facts and saves, and the
 * requests.
 * @returns The summary.
 */
function LysMailboxSummary({
  account,
  facts,
  saves,
  onEditAccount,
  editRef,
  onRemoveAccountComplete
}: LysMailboxSummaryProps): ReactElement {
  const provider = findEmailPreset(account.address)?.name

  return (
    <div className="settings-view__mailbox">
      <LysMailboxIdentity
        account={account}
        editRef={editRef}
        onEditAccount={onEditAccount}
      />
      <div className="settings-view__mailbox-servers">
        <LysMailboxServer
          provider={provider}
          server={account.imap}
          side="imap"
        />
        <LysMailboxServer
          provider={provider}
          server={account.smtp}
          side="smtp"
        />
      </div>
      <LysMailboxRows
        account={account}
        facts={facts}
        onEditAccount={onEditAccount}
        saves={saves}
      />
      <LysMailboxFooter
        account={account}
        facts={facts}
        onRemoveAccountComplete={onRemoveAccountComplete}
        saves={saves}
      />
    </div>
  )
}

/**
 * Whether the notice that Lys's mailbox was removed shows: `none` until a
 * removal; `announcing` until the notice took focus; `announced` after.
 */
type RemovalNotice = "none" | "announcing" | "announced"

/** The removal notice, and the request that shows it. */
type RemovalNoticeView = {
  /** Whether a removal was saved since the section appeared. */
  readonly isNoticeShown: boolean
  /** Attaches the notice while it must take focus; undefined otherwise. */
  readonly attachNotice:
    ((element: HTMLOutputElement | null) => void) | undefined
  /** Shows the notice, which takes focus once. */
  readonly announceRemoval: () => void
}

/**
 * Owns the notice that Lys's mailbox was removed.
 *
 * @remarks The notice replaces the summary, whose Remove mailbox was
 * pressed, so it takes focus; once, so a section closed and opened again
 * does not move focus. It lives as long as the section.
 * @returns The notice's state and the request that shows it.
 */
function useRemovalNotice(): RemovalNoticeView {
  const [notice, setNotice] = useState<RemovalNotice>("none")

  /**
   * Focuses the attached notice, and records that it took focus.
   *
   * @param element - Attached notice, or null when React detaches it,
   * which is ignored.
   */
  function handleNoticeAttach(element: HTMLOutputElement | null): void {
    if (element === null) return
    element.focus()
    setNotice("announced")
  }

  return {
    isNoticeShown: notice !== "none",
    attachNotice: notice === "announcing" ? handleNoticeAttach : undefined,
    announceRemoval: () => setNotice("announcing")
  }
}

/**
 * Presents the status line saying that Lys's mailbox was removed.
 *
 * @remarks The section owns whether the line shows and whether it takes
 * focus; the line owns no state. It is an `output`, whose status role
 * announces it.
 * @param props - Attaches the line while it must take focus.
 * @returns The line.
 */
function LysMailboxRemovedNotice({
  attachNotice
}: Pick<RemovalNoticeView, "attachNotice">): ReactElement {
  return (
    <output
      className="settings-view__mailbox-notice"
      ref={attachNotice}
      tabIndex={-1}
    >
      Lys&apos;s mailbox was removed.
    </output>
  )
}

/**
 * Presents the Email section: Lys's saved mailbox, or the fields that set
 * it up or edit it.
 *
 * @remarks The stores own the account, its password, its saves, and the
 * mailbox's switch; the section reads the MCP servers' states through
 * {@link useEmailServerStateRead}, so the header names the email server's
 * connection. It owns, through {@link useEmailMailboxView},
 * whether the card of a saved account shows and which control takes focus,
 * and whether a removal was just saved. Without a saved account the section
 * shows the account card that sets one up, and keeps it once one is saved;
 * with one, it shows the summary until the person opens the fields, and
 * Back to the mailbox returns. The header shows the mailbox's switch beside
 * the summary only: the card has its own. After a removal, the card
 * replaces the summary and a status line, which takes focus, says the
 * mailbox was removed.
 * @returns The section.
 */
function LysEmailSection(): ReactElement {
  const facts = useEmailMailboxFacts("lys")
  const saves = useEmailAccountSaves("lys")
  useEmailServerStateRead(facts)
  const { isNoticeShown, attachNotice, announceRemoval } = useRemovalNotice()
  const account = facts.savedAccount
  const { isCardShown, openCard, closeCard, attachBack, attachEdit } =
    useEmailMailboxView(account !== null)

  return (
    <SettingsPanelSection
      aside={
        <LysMailboxAside
          facts={facts}
          isSwitchShown={account !== null && !isCardShown}
          onMailboxOnChange={saves.handleMailboxOnChange}
        />
      }
      description={null}
      eyebrow="Email"
      leading={null}
      section="lys-email"
      summary={formatLysMailboxSummary(account)}
      title={account === null ? "Set up Lys's mailbox" : "Lys's mailbox"}
    >
      {account === null || isCardShown ? (
        <div className="settings-view__mailbox-setup">
          {isNoticeShown && account === null ? (
            <LysMailboxRemovedNotice attachNotice={attachNotice} />
          ) : null}
          {account === null ? null : (
            <EmailMailboxBackButton
              attachBack={attachBack}
              onBack={closeCard}
            />
          )}
          <EmailMailboxCardView mailbox="lys" />
        </div>
      ) : (
        <LysMailboxSummary
          account={account}
          facts={facts}
          editRef={attachEdit}
          onEditAccount={openCard}
          onRemoveAccountComplete={announceRemoval}
          saves={saves}
        />
      )}
    </SettingsPanelSection>
  )
}

/**
 * Presents the Lys pane: About Lys and Lys's mailbox.
 *
 * @remarks The pane accepts no props and is loaded lazily by the settings
 * view, which owns which sections are open.
 * @returns The Lys pane body.
 */
export default function LysPane(): ReactElement {
  return (
    <div className="settings-view__panels">
      <AboutLysSection />
      <LysEmailSection />
    </div>
  )
}
