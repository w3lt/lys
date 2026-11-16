import { useState } from "react"

import type { EmailAccountRemovalOutcome } from "@/lib/store/email-settings"

/**
 * Where the removal of the saved account stands: `idle` while the actions
 * show; `confirming` while the question whether to remove shows in their
 * place, also while the removal runs; `returning` once the question closed
 * without a removal, until Remove account is attached again and takes
 * focus.
 */
export type EmailAccountRemovalStep = "idle" | "confirming" | "returning"

/** The footer's removal of the saved account and the requests that move it. */
export type EmailAccountRemoval = {
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

/**
 * Answers whether the question whether to remove the account shows in
 * place of the actions.
 *
 * @param removalStep - Where the removal stands.
 * @returns True from the moment the question opens until it closes, also
 * while the removal runs.
 */
export function isRemovalQuestionShown(
  removalStep: EmailAccountRemovalStep
): boolean {
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
export function useEmailAccountRemoval(
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
