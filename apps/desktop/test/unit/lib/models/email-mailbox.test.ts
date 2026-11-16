import { describe, expect, it } from "vitest"
import {
  buildEmailMailboxAccountSettings,
  buildEmailMailboxSwitches,
  findOtherEmailMailbox,
  isEmailMailboxOn,
  readEmailMailboxAccount,
  readEmailMailboxPassword
} from "@/lib/models/email-mailbox"
import {
  LYS_EMAIL_ACCOUNT,
  LYS_EMAIL_PASSWORD,
  LYS_MAILBOX_ON_SETTINGS,
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD,
  STORED_SETTINGS
} from "../../support/settingsFixtures"

describe("email mailboxes", () => {
  it("reads each mailbox's account, password, and switch from fields of its own", () => {
    const settings = LYS_MAILBOX_ON_SETTINGS
    const switches = settings.mcp.builtIn.email

    expect([
      readEmailMailboxAccount(settings, "person"),
      readEmailMailboxPassword(settings, "person"),
      isEmailMailboxOn(switches, "person")
    ]).toEqual([STORED_EMAIL_ACCOUNT, STORED_EMAIL_PASSWORD, false])
    expect([
      readEmailMailboxAccount(settings, "lys"),
      readEmailMailboxPassword(settings, "lys"),
      isEmailMailboxOn(switches, "lys")
    ]).toEqual([LYS_EMAIL_ACCOUNT, LYS_EMAIL_PASSWORD, true])
    expect(findOtherEmailMailbox("person")).toBe("lys")
    expect(findOtherEmailMailbox("lys")).toBe("person")
  })

  it("replaces one mailbox's account and password, keeping the other's and every other group", () => {
    const saved = buildEmailMailboxAccountSettings(STORED_SETTINGS, "lys", {
      account: LYS_EMAIL_ACCOUNT,
      password: LYS_EMAIL_PASSWORD
    })
    const removed = buildEmailMailboxAccountSettings(saved, "person", {
      account: null,
      password: null
    })

    expect(saved).toEqual({
      ...STORED_SETTINGS,
      secrets: LYS_MAILBOX_ON_SETTINGS.secrets,
      email: LYS_MAILBOX_ON_SETTINGS.email
    })
    expect(removed.email).toEqual({
      account: null,
      lysAccount: LYS_EMAIL_ACCOUNT
    })
    expect(removed.secrets).toEqual({
      ...STORED_SETTINGS.secrets,
      emailPassword: null,
      lysEmailPassword: LYS_EMAIL_PASSWORD
    })
    expect(Object.isFrozen(removed.email)).toBe(true)
    expect(Object.isFrozen(removed.secrets)).toBe(true)
  })

  it("sets one mailbox's switch, keeping the other's", () => {
    const switches = buildEmailMailboxSwitches(
      LYS_MAILBOX_ON_SETTINGS.mcp.builtIn.email,
      "person",
      true
    )

    expect(switches).toEqual({ enabled: true, lysEnabled: true })
    expect(buildEmailMailboxSwitches(switches, "lys", false)).toEqual({
      enabled: true,
      lysEnabled: false
    })
    expect(Object.isFrozen(switches)).toBe(true)
  })
})
