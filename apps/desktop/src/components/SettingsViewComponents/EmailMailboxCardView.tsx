import { ChevronLeft } from "lucide-react"
import type { ReactElement, Ref } from "react"

import { Button } from "@/components/ui/button"
import type { EmailMailbox } from "@/lib/models/email-mailbox"

import EmailAccountCard from "./EmailAccountCard"
import {
  useEmailAccountSaves,
  useEmailMailboxFacts
} from "./email-mailbox-state"

/** Properties accepted by {@link EmailMailboxCardView}. */
type EmailMailboxCardViewProps = {
  /** The mailbox whose account the card saves. */
  readonly mailbox: EmailMailbox
}

/** Properties accepted by {@link EmailMailboxBackButton}. */
type EmailMailboxBackButtonProps = {
  /** Requests the summary of the mailbox's saved account. */
  readonly onBack: () => void
  /** Attaches the button while it must take focus; undefined otherwise. */
  readonly attachBack: Ref<HTMLButtonElement> | undefined
}

/**
 * Presents Back to the mailbox, above the account card of a saved account.
 *
 * @param props - The request, and the ref that focuses the button.
 * @returns The button.
 */
export function EmailMailboxBackButton({
  onBack,
  attachBack
}: EmailMailboxBackButtonProps): ReactElement {
  return (
    <Button
      className="settings-view__mailbox-back"
      onClick={onBack}
      ref={attachBack}
      type="button"
      variant="back"
    >
      <ChevronLeft aria-hidden="true" />
      Back to the mailbox
    </Button>
  )
}

/**
 * Presents one mailbox's email account card and saves, checks, and removes
 * its account, and saves its switch.
 *
 * @remarks The stores own every fact and save, read through
 * {@link useEmailMailboxFacts} and {@link useEmailAccountSaves}; the view
 * owns no state.
 * @param props - The mailbox.
 * @returns The mailbox's account card.
 */
export default function EmailMailboxCardView({
  mailbox
}: EmailMailboxCardViewProps): ReactElement {
  const facts = useEmailMailboxFacts(mailbox)
  const saves = useEmailAccountSaves(mailbox)

  return (
    <EmailAccountCard
      checkState={facts.checkState}
      isBackendRunning={facts.isBackendRunning}
      isMailboxOn={facts.isMailboxOn}
      isMailboxSwitchSaving={facts.isMailboxSwitchSaving}
      mailbox={mailbox}
      onMailboxOnChange={saves.handleMailboxOnChange}
      onRemoveEmailAccount={saves.handleRemoveEmailAccount}
      onSaveEmailAccount={saves.handleSaveEmailAccount}
      otherAccount={facts.otherAccount}
      savedAccount={facts.savedAccount}
      savedPassword={facts.savedPassword}
      saveState={facts.saveState}
    />
  )
}
