import { useState } from "react"

/**
 * Which view of a mailbox shows: `summary` while the saved account's
 * summary shows; `card` while the account card shows, for a mailbox being
 * set up, after it was set up, or once Back took focus; `editing` while the
 * card shows because the person chose Edit, until Back took focus;
 * `returning` once the person went back to the summary, until its Edit
 * button took focus.
 */
type EmailMailboxViewStep = "summary" | "card" | "editing" | "returning"

/** Callback ref of a button that takes focus when it attaches. */
type FocusAttach = ((element: HTMLButtonElement | null) => void) | undefined

/** Which view of a mailbox shows, and the requests that change it. */
export type EmailMailboxView = {
  /** Whether the account card shows rather than the summary. */
  readonly isCardShown: boolean
  /** Shows the card of the saved account; Back takes focus. */
  readonly openCard: () => void
  /** Shows the summary again; its Edit button takes focus. */
  readonly closeCard: () => void
  /** Attaches Back while it must take focus; undefined otherwise. */
  readonly attachBack: FocusAttach
  /** Attaches Edit while it must take focus; undefined otherwise. */
  readonly attachEdit: FocusAttach
}

/**
 * Owns which view of a mailbox shows: the account card or the summary of
 * its saved account.
 *
 * @remarks The step lives as long as the view's owner and starts on the
 * card while no account is saved, otherwise on the summary. A mailbox
 * without an account always shows the card, and keeps it once an account
 * is saved there, so the card's outcome stays in view. Opening the card
 * from Edit moves focus to Back, and Back returns focus to Edit, because
 * each replaces the control that was pressed; each takes focus once, so a
 * section closed and opened again does not move focus. The requests and the
 * refs are rebuilt on every render.
 * @param hasAccount - Whether the mailbox has a saved account.
 * @returns The view and the requests that change it.
 */
export function useEmailMailboxView(hasAccount: boolean): EmailMailboxView {
  const [step, setStep] = useState<EmailMailboxViewStep>(
    hasAccount ? "summary" : "card"
  )
  if (!hasAccount && step !== "card") setStep("card")

  /**
   * Focuses an attached button, and records that the move happened.
   *
   * @param element - Attached button, or null when React detaches it,
   * which is ignored.
   * @param nextStep - The step once the button has focus.
   */
  function focusOnce(
    element: HTMLButtonElement | null,
    nextStep: EmailMailboxViewStep
  ): void {
    if (element === null) return
    element.focus()
    setStep(nextStep)
  }

  return {
    isCardShown: step === "card" || step === "editing",
    openCard: () => setStep("editing"),
    closeCard: () => setStep("returning"),
    attachBack:
      step === "editing" ? (element) => focusOnce(element, "card") : undefined,
    attachEdit:
      step === "returning"
        ? (element) => focusOnce(element, "summary")
        : undefined
  }
}
