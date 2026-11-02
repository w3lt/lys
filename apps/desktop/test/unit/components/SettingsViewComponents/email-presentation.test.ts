import {
  checkEmailAccountApiResponseSchema,
  type EmailServerCheckFailure
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  EMAIL_SECURITIES,
  findEmailSecurity,
  formatEmailAccountMessage,
  formatEmailPresetNote,
  formatEmailSecurityLabel,
  formatEmailServerSideLabel,
  type EmailAccountMessage
} from "@/components/SettingsViewComponents/email-presentation"
import {
  buildEmailAccountDraft,
  updateEmailAccountAddress,
  type EmailAccountDraftParse
} from "@/lib/models/email-account-draft"
import {
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD
} from "../../support/settingsFixtures"

/** Facts the status line describes. */
type EmailAccountStatusInput = Parameters<typeof formatEmailAccountMessage>[0]

/** The fields of an empty card. */
const EMPTY_DRAFT = buildEmailAccountDraft(null)

/** A valid edit of the stored account. */
const CHANGED_PARSE: EmailAccountDraftParse = Object.freeze({
  status: "changed",
  account: STORED_EMAIL_ACCOUNT,
  password: STORED_EMAIL_PASSWORD
})

/** Fields that break a rule. */
const INVALID_PARSE: EmailAccountDraftParse = Object.freeze({
  status: "invalid",
  problems: Object.freeze({ address: "Enter an address." })
})

/** The stored account shown, nothing edited, nothing tried, backend running. */
const RESTING_INPUT: EmailAccountStatusInput = Object.freeze({
  savedAccount: STORED_EMAIL_ACCOUNT,
  draftParse: Object.freeze({ status: "unchanged" }),
  hasSubmitted: false,
  isEditedSinceSubmit: false,
  saveState: Object.freeze({ status: "idle" }),
  checkState: Object.freeze({ status: "idle" }),
  isBackendRunning: true
})

/** A save tried with the fields as they are. */
const SUBMITTED_INPUT: EmailAccountStatusInput = Object.freeze({
  ...RESTING_INPUT,
  draftParse: CHANGED_PARSE,
  hasSubmitted: true
})

/** Answer of a check both servers accepted. */
const ACCEPTED_CHECK = checkEmailAccountApiResponseSchema.parse({
  status: "checked",
  imap: { status: "accepted" },
  smtp: { status: "accepted" }
})

/** Line of the stored account while nothing happens. */
const SAVED_LINE: EmailAccountMessage = {
  text: "Saved · ada@fastmail.com",
  tone: "muted"
}

/** Line of an edit while the backend runs. */
const UNSAVED_LINE: EmailAccountMessage = {
  text: "Unsaved · Save signs in to both servers first.",
  tone: "attention"
}

/**
 * Builds the check state of an answer the backend gave.
 *
 * @param outcome - What the backend answered, as JSON.
 * @returns The checked state.
 */
function buildChecked(outcome: unknown): EmailAccountStatusInput["checkState"] {
  return {
    status: "checked",
    outcome: checkEmailAccountApiResponseSchema.parse(outcome)
  }
}

describe("formatEmailSecurityLabel", () => {
  it.each([
    ["tls", "TLS"],
    ["starttls", "STARTTLS"],
    ["plain", "None"]
  ] as const)("labels %s as %s", (security, label) => {
    expect(formatEmailSecurityLabel(security)).toBe(label)
  })
})

describe("EMAIL_SECURITIES", () => {
  it("offers TLS first, then STARTTLS, then none", () => {
    expect(EMAIL_SECURITIES).toEqual(["tls", "starttls", "plain"])
  })
})

describe("formatEmailServerSideLabel", () => {
  it.each([
    ["imap", "IMAP server"],
    ["smtp", "SMTP server"]
  ] as const)("labels %s as %s", (side, label) => {
    expect(formatEmailServerSideLabel(side)).toBe(label)
  })
})

describe("findEmailSecurity", () => {
  it("finds the pressed way to secure a connection", () => {
    expect(findEmailSecurity(["starttls"])).toBe("starttls")
  })

  it.each([
    ["nothing is pressed", []],
    ["the pressed value is not a way to secure a connection", ["ssl"]]
  ])("finds nothing when %s", (_label, groupValue) => {
    expect(findEmailSecurity(groupValue)).toBeUndefined()
  })
})

describe("formatEmailPresetNote", () => {
  it.each([
    ["an empty address", ""],
    ["an address still being typed", "ada@"],
    ["an address with spaces inside", "ada smith@gmail.com"]
  ])("says nothing for %s", (_label, address) => {
    expect(formatEmailPresetNote({ ...EMPTY_DRAFT, address })).toBe("")
  })

  it("asks for the servers of a provider without a preset", () => {
    expect(
      formatEmailPresetNote({ ...EMPTY_DRAFT, address: "ada@example.test" })
    ).toBe("No preset for this address. Enter the servers.")
  })

  it("names the preset while the servers are its own, ignoring spaces around the address", () => {
    const draft = updateEmailAccountAddress(EMPTY_DRAFT, "ada@gmail.com")

    expect(
      formatEmailPresetNote({ ...draft, address: " ada@gmail.com " })
    ).toBe("Preset: Gmail")
  })

  it("says the servers were changed once they differ from the preset's", () => {
    const draft = updateEmailAccountAddress(EMPTY_DRAFT, "ada@gmail.com")

    expect(
      formatEmailPresetNote({
        ...draft,
        smtp: { ...draft.smtp, security: "starttls" }
      })
    ).toBe("Preset: Gmail · servers changed")
  })
})

describe("formatEmailAccountMessage", () => {
  it("shows the saved address while nothing happens", () => {
    expect(formatEmailAccountMessage(RESTING_INPUT)).toEqual(SAVED_LINE)
  })

  it("says no account is saved while none is", () => {
    expect(
      formatEmailAccountMessage({ ...RESTING_INPUT, savedAccount: null })
    ).toEqual({
      text: "No account yet. The email server stays off until you save one.",
      tone: "muted"
    })
  })

  it("says Lys signs in before anything else", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        draftParse: INVALID_PARSE,
        checkState: { status: "checking" },
        saveState: { status: "failed", error: "Lys couldn't write." }
      })
    ).toEqual({ text: "Signing in…", tone: "pending" })
  })

  it("says Lys saves while the write runs", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        saveState: { status: "saving" },
        checkState: buildChecked(ACCEPTED_CHECK)
      })
    ).toEqual({ text: "Saving…", tone: "pending" })
  })

  it.each([
    ["the fields were not edited since", false],
    ["the fields were edited since", true]
  ])(
    "asks to fix the marked fields after a tried save while a field breaks a rule, when %s",
    (_label, isEditedSinceSubmit) => {
      expect(
        formatEmailAccountMessage({
          ...SUBMITTED_INPUT,
          draftParse: INVALID_PARSE,
          isEditedSinceSubmit,
          saveState: { status: "failed", error: "Lys couldn't write." }
        })
      ).toEqual({ text: "Fix the marked fields to save.", tone: "danger" })
    }
  )

  it("says nothing about a rule a field breaks before a save was tried", () => {
    expect(
      formatEmailAccountMessage({ ...RESTING_INPUT, draftParse: INVALID_PARSE })
    ).toEqual(SAVED_LINE)
  })

  it("says an edit is unsaved and how it is saved", () => {
    expect(
      formatEmailAccountMessage({ ...RESTING_INPUT, draftParse: CHANGED_PARSE })
    ).toEqual(UNSAVED_LINE)
  })

  it("says the backend must run to sign in and save an edit", () => {
    expect(
      formatEmailAccountMessage({
        ...RESTING_INPUT,
        draftParse: CHANGED_PARSE,
        isBackendRunning: false
      })
    ).toEqual({
      text: "Unsaved · start the backend in Settings → Runtime to sign in and save.",
      tone: "attention"
    })
  })

  it("reports a failed save while the fields are still those it was tried with", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        saveState: { status: "failed", error: "Lys couldn't write." },
        checkState: buildChecked(ACCEPTED_CHECK)
      })
    ).toEqual({ text: "Lys couldn't write.", tone: "danger" })
  })

  it("reports a failed removal while nothing is edited", () => {
    expect(
      formatEmailAccountMessage({
        ...RESTING_INPUT,
        saveState: { status: "failed", error: "Lys couldn't write." }
      })
    ).toEqual({ text: "Lys couldn't write.", tone: "danger" })
  })

  it("shows the edit as unsaved again once the fields change after a failed save", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        isEditedSinceSubmit: true,
        saveState: { status: "failed", error: "Lys couldn't write." }
      })
    ).toEqual(UNSAVED_LINE)
  })

  it("reports that the check could not be asked", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        checkState: { status: "failed", error: "Lys couldn't reach." }
      })
    ).toEqual({ text: "Lys couldn't reach.", tone: "danger" })
  })

  it("says which server refused the sign-in", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        checkState: buildChecked({
          status: "checked",
          imap: { status: "accepted" },
          smtp: { status: "failed", reason: "wrong-password" }
        })
      })
    ).toEqual({
      text: "IMAP: accepted · SMTP: the user name or password was refused",
      tone: "danger"
    })
  })

  it.each<[EmailServerCheckFailure, string]>([
    ["wrong-password", "the user name or password was refused"],
    ["unreachable", "the host could not be reached"],
    ["certificate-refused", "its certificate was refused"],
    ["encryption-not-offered", "it does not offer STARTTLS"],
    ["timed-out", "it did not answer in time"],
    ["protocol-error", "it answered something Lys could not read"]
  ])("words the %s failure of a server", (reason, clause) => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        checkState: buildChecked({
          status: "checked",
          imap: { status: "failed", reason },
          smtp: { status: "failed", reason }
        })
      })
    ).toEqual({ text: `IMAP: ${clause} · SMTP: ${clause}`, tone: "danger" })
  })

  it.each([
    [
      "server-missing",
      "Lys couldn't start its email server to check the account. Run build.sh to install it."
    ],
    ["server-failed", "Lys's email server failed while checking the account."],
    ["busy", "Another account check is still running. Try again in a minute."]
  ])(
    "says why no sign-in was tried when the email server is %s",
    (reason, text) => {
      expect(
        formatEmailAccountMessage({
          ...SUBMITTED_INPUT,
          checkState: buildChecked({ status: "unavailable", reason })
        })
      ).toEqual({ text, tone: "danger" })
    }
  )

  it("shows the edit as unsaved again once the fields change after a refusal", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        isEditedSinceSubmit: true,
        checkState: buildChecked({
          status: "unavailable",
          reason: "server-failed"
        })
      })
    ).toEqual(UNSAVED_LINE)
  })

  it("does not repeat an earlier refusal once the card starts afresh", () => {
    expect(
      formatEmailAccountMessage({
        ...RESTING_INPUT,
        checkState: buildChecked({
          status: "unavailable",
          reason: "server-failed"
        })
      })
    ).toEqual(SAVED_LINE)
  })

  it("says the account was saved after a save that followed an accepted check", () => {
    expect(
      formatEmailAccountMessage({
        ...RESTING_INPUT,
        saveState: { status: "saved" },
        checkState: buildChecked(ACCEPTED_CHECK)
      })
    ).toEqual({ text: "Account saved.", tone: "success" })
  })

  it("says no account is saved after a removal", () => {
    expect(
      formatEmailAccountMessage({
        ...RESTING_INPUT,
        savedAccount: null,
        saveState: { status: "saved" }
      })
    ).toEqual({
      text: "No account yet. The email server stays off until you save one.",
      tone: "muted"
    })
  })

  it("shows an accepted check that did not end in a save as an unsaved edit", () => {
    expect(
      formatEmailAccountMessage({
        ...SUBMITTED_INPUT,
        checkState: buildChecked(ACCEPTED_CHECK)
      })
    ).toEqual(UNSAVED_LINE)
  })
})
