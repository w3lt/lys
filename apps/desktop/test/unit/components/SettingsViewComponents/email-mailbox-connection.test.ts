import { describe, expect, it } from "vitest"
import {
  findEmailMailboxConnection,
  formatEmailMailboxConnection,
  type EmailMailboxConnectionFacts
} from "@/components/SettingsViewComponents/email-mailbox-connection"
import {
  buildBuiltInMcpServerStatus,
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  buildMcpServerStatus,
  CONNECTING_MCP_STATE,
  OFF_MCP_STATE
} from "../../support/mcpFixtures"
import { LYS_EMAIL_ACCOUNT } from "../../support/settingsFixtures"

/** Lys's mailbox, switched on, while the running backend serves it. */
const SERVED: EmailMailboxConnectionFacts = {
  account: LYS_EMAIL_ACCOUNT,
  isMailboxOn: true,
  isBackendRunning: true,
  serverList: {
    status: "loaded",
    ...buildMcpServerList([
      buildMcpServerStatus("notes", "http", buildFailedMcpState("closed")),
      buildBuiltInMcpServerStatus("email", buildConnectedMcpState(4))
    ])
  }
}

/**
 * Builds the facts of a switched-on mailbox whose email server is in one
 * state.
 *
 * @param state - The built-in email server's state.
 * @returns The facts.
 */
function buildServedFacts(
  state: Parameters<typeof buildBuiltInMcpServerStatus>[1]
): EmailMailboxConnectionFacts {
  return {
    ...SERVED,
    serverList: {
      status: "loaded",
      ...buildMcpServerList([buildBuiltInMcpServerStatus("email", state)])
    }
  }
}

describe("findEmailMailboxConnection", () => {
  it("follows the built-in email server's state", () => {
    expect(findEmailMailboxConnection(SERVED)).toBe("connected")
    expect(
      findEmailMailboxConnection(buildServedFacts(CONNECTING_MCP_STATE))
    ).toBe("connecting")
    expect(
      findEmailMailboxConnection(
        buildServedFacts(buildFailedMcpState("account-invalid"))
      )
    ).toBe("needs-attention")
    expect(findEmailMailboxConnection(buildServedFacts(OFF_MCP_STATE))).toBe(
      "not-connected"
    )
  })

  it("says the mailbox is not set up, switched off, or not connected before the server's state", () => {
    expect(findEmailMailboxConnection({ ...SERVED, account: null })).toBe(
      "not-set-up"
    )
    expect(findEmailMailboxConnection({ ...SERVED, isMailboxOn: false })).toBe(
      "switched-off"
    )
    expect(
      findEmailMailboxConnection({ ...SERVED, isBackendRunning: false })
    ).toBe("not-connected")
    expect(
      findEmailMailboxConnection({
        ...SERVED,
        serverList: { status: "loading" }
      })
    ).toBe("not-connected")
  })
})

describe("formatEmailMailboxConnection", () => {
  it("names each connection with the color of its dot", () => {
    expect(formatEmailMailboxConnection("connected")).toEqual({
      label: "Connected",
      tone: "success"
    })
    expect(formatEmailMailboxConnection("needs-attention")).toEqual({
      label: "Needs attention",
      tone: "danger"
    })
    expect(formatEmailMailboxConnection("connecting")).toEqual({
      label: "Connecting",
      tone: "pending"
    })
    expect(formatEmailMailboxConnection("not-connected")).toEqual({
      label: "Not connected",
      tone: "neutral"
    })
  })
})
