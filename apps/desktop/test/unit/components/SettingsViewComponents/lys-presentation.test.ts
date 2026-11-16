import { checkEmailAccountApiResponseSchema } from "@lys/protocol"
import { emailAccountSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  formatClockTime,
  formatLysIdentitySummary,
  formatLysMailboxCheckMessage,
  formatLysMailboxSummary,
  formatTimeZoneOffset,
  listTimeZones
} from "@/components/SettingsViewComponents/lys-presentation"
import type { EmailAccountCheckState } from "@/lib/store/email-settings"
import { LYS_EMAIL_ACCOUNT } from "../../support/settingsFixtures"

/** Lys's account on a server no preset describes. */
const SELF_HOSTED_ACCOUNT = emailAccountSchema.parse({
  ...LYS_EMAIL_ACCOUNT,
  address: "lys@mail.example.org",
  imap: { host: "imap.example.org", port: 1143, security: "starttls" }
})

/** A check both servers accepted. */
const ACCEPTED_CHECK: EmailAccountCheckState = {
  status: "checked",
  outcome: checkEmailAccountApiResponseSchema.parse({
    status: "checked",
    imap: { status: "accepted" },
    smtp: { status: "accepted" }
  })
}

/** A check the outgoing server refused. */
const REFUSED_CHECK: EmailAccountCheckState = {
  status: "checked",
  outcome: checkEmailAccountApiResponseSchema.parse({
    status: "checked",
    imap: { status: "accepted" },
    smtp: { status: "failed", reason: "wrong-password" }
  })
}

describe("formatClockTime", () => {
  it("writes the local hours and minutes on a 24-hour clock", () => {
    expect(formatClockTime(new Date(2026, 10, 14, 17, 5))).toBe("17:05")
    expect(formatClockTime(new Date(2026, 10, 14, 0, 9))).toBe("00:09")
  })
})

describe("formatTimeZoneOffset", () => {
  it("writes a zone's offset from UTC at the moment, after daylight saving time", () => {
    const winter = new Date("2026-01-15T12:00:00Z")
    const summer = new Date("2026-07-15T12:00:00Z")

    expect(formatTimeZoneOffset("Europe/Paris", winter)).toBe("UTC+01:00")
    expect(formatTimeZoneOffset("Europe/Paris", summer)).toBe("UTC+02:00")
    expect(formatTimeZoneOffset("America/New_York", winter)).toBe("UTC-05:00")
    expect(formatTimeZoneOffset("UTC", winter)).toBe("UTC+00:00")
  })
})

describe("listTimeZones", () => {
  it("lists the runtime's zones, and a chosen zone it does not know first", () => {
    const known = Intl.supportedValuesOf("timeZone")

    expect(listTimeZones("Europe/Paris")).toEqual(known)
    expect(listTimeZones("Mars/Olympus_Mons")).toEqual([
      "Mars/Olympus_Mons",
      ...known
    ])
  })
})

describe("formatLysIdentitySummary", () => {
  it("joins the parts that are not blank", () => {
    expect(
      formatLysIdentitySummary({
        name: "Lys",
        fullName: " ",
        timeZone: "Europe/Paris",
        writesIn: "English, French",
        signature: "Lys"
      })
    ).toBe("Lys · Europe/Paris · English, French")
  })
})

describe("formatLysMailboxSummary", () => {
  it("names the provider of a known address, the incoming server otherwise", () => {
    expect(formatLysMailboxSummary(null)).toBe("No mailbox yet")
    expect(formatLysMailboxSummary(LYS_EMAIL_ACCOUNT)).toBe(
      "lys-fixture@fastmail.com · Fastmail"
    )
    expect(formatLysMailboxSummary(SELF_HOSTED_ACCOUNT)).toBe(
      "lys@mail.example.org · imap.example.org:1143"
    )
  })
})

/** One state of a save and a check, and the message they make. */
type MailboxCheckMessageCase = {
  /** Names the case. */
  readonly label: string
  /** The state of the latest save. */
  readonly save: Parameters<typeof formatLysMailboxCheckMessage>[0]
  /** The state of the latest check. */
  readonly check: EmailAccountCheckState
  /** The expected message. */
  readonly text: string
  /** The expected tone. */
  readonly tone: string
}

describe("formatLysMailboxCheckMessage", () => {
  it.each<MailboxCheckMessageCase>([
    {
      label: "a running check before a save",
      save: { status: "saving" },
      check: { status: "checking" },
      text: "Signing in to IMAP and SMTP…",
      tone: "pending"
    },
    {
      label: "a running save",
      save: { status: "saving" },
      check: ACCEPTED_CHECK,
      text: "Saving…",
      tone: "pending"
    },
    {
      label: "a failed save",
      save: { status: "failed", error: "Lys couldn't write it." },
      check: ACCEPTED_CHECK,
      text: "Lys couldn't write it.",
      tone: "danger"
    },
    {
      label: "a check that could not be asked",
      save: { status: "idle" },
      check: { status: "failed", error: "The backend did not answer." },
      text: "The backend did not answer.",
      tone: "danger"
    },
    {
      label: "an accepted check",
      save: { status: "saved" },
      check: ACCEPTED_CHECK,
      text: "Both servers answered the latest check.",
      tone: "success"
    },
    {
      label: "a refused check",
      save: { status: "idle" },
      check: REFUSED_CHECK,
      text: "A server refused the latest check. Edit servers to see why.",
      tone: "danger"
    },
    {
      label: "no check since the mailbox was saved",
      save: { status: "idle" },
      check: { status: "idle" },
      text: "Lys signed in to both servers when this mailbox was saved.",
      tone: "neutral"
    }
  ])("says what $label found", ({ save, check, text, tone }) => {
    expect(formatLysMailboxCheckMessage(save, check)).toEqual({ text, tone })
  })
})
