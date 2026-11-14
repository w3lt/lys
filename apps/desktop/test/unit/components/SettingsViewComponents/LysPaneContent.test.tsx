import { checkEmailAccountApiResponseSchema } from "@lys/protocol"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LysSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import {
  buildBuiltInMcpServerStatus,
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  OFF_MCP_STATE
} from "../../support/mcpFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import {
  LYS_EMAIL_ACCOUNT,
  LYS_EMAIL_PASSWORD,
  LYS_MAILBOX_ON_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"

/** Route key of the email account check. */
const ACCOUNT_CHECK_ROUTE = "POST /api/v1/mcp/email/account-check"

/** Route key of the sync that applies the MCP group. */
const SYNC_ROUTE = "POST /api/v1/mcp/servers/sync"

/** A check both of Lys's servers accepted. */
const ACCEPTED_CHECK = checkEmailAccountApiResponseSchema.parse({
  status: "checked",
  imap: { status: "accepted" },
  smtp: { status: "accepted" }
})

/** Route key of the read of the MCP servers' states. */
const LIST_ROUTE = "GET /api/v1/mcp/servers"

/** The email server connected, as the backend lists it. */
const CONNECTED_EMAIL_LIST = buildMcpServerList([
  buildBuiltInMcpServerStatus("email", buildConnectedMcpState(4))
])

/** Routes that accept a check and apply the group. */
const SAVE_ROUTES: BackendRoutes = Object.freeze({
  [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK),
  [SYNC_ROUTE]: () =>
    buildJsonResponse(
      200,
      buildMcpServerList([buildBuiltInMcpServerStatus("email", OFF_MCP_STATE)])
    )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Renders the settings view on the Lys pane with some settings in the
 * application store, a host whose writes succeed, and waits for the body.
 *
 * @param settings - Settings the store holds.
 * @param routes - Backend routes the case needs besides the inventory read
 * and the servers' states, which list the email server connected.
 * @returns The stores and the observation handles.
 */
async function startLysPane(
  settings: LysSettings = STORED_SETTINGS,
  routes: BackendRoutes = {}
) {
  const host = startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => null,
    list_tools: () => []
  })
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(),
    [LIST_ROUTE]: () => buildJsonResponse(200, CONNECTED_EMAIL_LIST),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView("lys")
  const { useLocalProfileStore } = await import("@/lib/store/local-profile")
  useLysStore.setState({ settings })
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("heading", {
    level: 2,
    name: /How Lys introduces itself/
  })
  await waitForRenderedWork()
  return { useLysStore, useLocalProfileStore, host, backend }
}

/**
 * Gets the disclosure button of one of the pane's sections.
 *
 * @param title - Matches the section's title.
 * @returns The button in the section's level-two heading.
 */
function getSectionButton(title: RegExp): HTMLElement {
  return within(
    screen.getByRole("heading", { level: 2, name: title })
  ).getByRole("button")
}

describe("LysPaneContent", () => {
  it("shows how Lys introduces itself, and keeps each change at once with when", async () => {
    const { useLocalProfileStore } = await startLysPane()
    const user = userEvent.setup()

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Lys")
    expect(screen.getByRole("textbox", { name: /^Full name/ })).toHaveValue("")
    expect(screen.getByRole("textbox", { name: "Writes in" })).toHaveValue(
      "English"
    )
    expect(screen.getByRole("textbox", { name: "Signature" })).toHaveValue(
      "Lys"
    )
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveValue(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    )
    expect(screen.queryByText(/^Saved at/)).toBeNull()

    await user.clear(screen.getByRole("textbox", { name: "Name" }))
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Iris")
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Time zone" }),
      "Asia/Tokyo"
    )

    expect(useLocalProfileStore.getState().lysIdentity).toMatchObject({
      name: "Iris",
      timeZone: "Asia/Tokyo"
    })
    expect(screen.getByText(/^Saved at \d{2}:\d{2}$/)).toBeInTheDocument()
    await user.click(getSectionButton(/How Lys introduces itself/))
    expect(getSectionButton(/How Lys introduces itself/)).toHaveTextContent(
      "Iris · Asia/Tokyo · English"
    )
  })

  it("replaces Lys's portrait with a picked image", async () => {
    vi.stubGlobal(
      "URL",
      Object.assign(globalThis.URL, {
        createObjectURL: vi.fn(() => "blob:portrait"),
        revokeObjectURL: vi.fn()
      })
    )
    const { useLocalProfileStore } = await startLysPane()
    const user = userEvent.setup()
    const portrait = new File(["portrait"], "lys.png", { type: "image/png" })

    await user.upload(screen.getByLabelText("Change portrait"), portrait)

    expect(useLocalProfileStore.getState().lysPortraitUrl).toBe("blob:portrait")
    expect(screen.getByText(/^Saved at/)).toBeInTheDocument()
  })

  it("sets up Lys's mailbox on its card, keeps the card with its outcome, then returns to the summary", async () => {
    const { useLysStore } = await startLysPane(STORED_SETTINGS, SAVE_ROUTES)
    const user = userEvent.setup()
    const card = screen.getByRole("form", { name: "Lys's email account" })

    expect(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: /^Email/
      })
    ).toHaveTextContent("EmailNot set up")
    await user.type(
      within(card).getByRole("textbox", { name: "Address" }),
      LYS_EMAIL_ACCOUNT.address
    )
    await user.type(
      within(card).getByRole("textbox", { name: "User name" }),
      LYS_EMAIL_ACCOUNT.userName
    )
    await user.type(within(card).getByLabelText("Password"), LYS_EMAIL_PASSWORD)
    await user.click(within(card).getByRole("button", { name: "Save" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.email.lysAccount).toEqual(
      LYS_EMAIL_ACCOUNT
    )
    expect(within(card).getByRole("status")).toHaveTextContent("Account saved.")
    await user.click(
      screen.getByRole("button", { name: "Back to the mailbox" })
    )

    expect(screen.queryByRole("form")).toBeNull()
    expect(screen.getByRole("button", { name: "Edit servers" })).toHaveFocus()
    expect(screen.getByText(LYS_EMAIL_ACCOUNT.address)).toBeInTheDocument()
  })

  it("summarizes a saved mailbox: who it sends as, its servers, its state, and its switch", async () => {
    await startLysPane(LYS_MAILBOX_ON_SETTINGS)

    expect(screen.getByText(/^Sends as/)).toHaveTextContent(
      `Sends as ${LYS_EMAIL_ACCOUNT.displayName} <${LYS_EMAIL_ACCOUNT.address}> · signs in as ${LYS_EMAIL_ACCOUNT.userName}`
    )
    expect(screen.getByText("imap.fastmail.com:993")).toBeInTheDocument()
    expect(screen.getByText("smtp.fastmail.com:465")).toBeInTheDocument()
    expect(screen.getAllByText("Fastmail")).toHaveLength(2)
    expect(screen.getByText("Connected")).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Use this mailbox" })
    ).toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Server keeps a copy of sent mail" })
    ).toBeChecked()
    expect(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: /^Email/
      })
    ).toHaveAccessibleName(/^Email\s*, connected$/)
  })

  it("says the mailbox needs attention while the email server failed, here and in the rail", async () => {
    await startLysPane(LYS_MAILBOX_ON_SETTINGS, {
      [LIST_ROUTE]: () =>
        buildJsonResponse(
          200,
          buildMcpServerList([
            buildBuiltInMcpServerStatus(
              "email",
              buildFailedMcpState("account-invalid")
            )
          ])
        )
    })

    expect(screen.getByText("Needs attention")).toBeInTheDocument()
    expect(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: /^Email/
      })
    ).toHaveAccessibleName(/^Email\s*, needs attention$/)
  })

  it("switches Lys's mailbox off from its header, which the store saves", async () => {
    const { useLysStore } = await startLysPane(
      LYS_MAILBOX_ON_SETTINGS,
      SAVE_ROUTES
    )
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Use this mailbox" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.mcp.builtIn.email).toEqual({
      enabled: false,
      lysEnabled: false
    })
    expect(screen.getByText("Switched off")).toBeInTheDocument()
  })

  it("saves the account again when the server stops keeping sent mail, signing in first", async () => {
    const { useLysStore, backend } = await startLysPane(
      LYS_MAILBOX_ON_SETTINGS,
      SAVE_ROUTES
    )
    const user = userEvent.setup()

    await user.click(
      screen.getByRole("switch", { name: "Server keeps a copy of sent mail" })
    )
    await waitForRenderedWork()

    const edited = { ...LYS_EMAIL_ACCOUNT, serverKeepsSentCopy: false }
    expect(
      backend.requests.find(
        (request) => request.routeKey === ACCOUNT_CHECK_ROUTE
      )?.body
    ).toEqual({ account: edited, password: LYS_EMAIL_PASSWORD })
    expect(useLysStore.getState().settings.email.lysAccount).toEqual(edited)
  })

  it("opens the card from Edit servers or Change password, moving focus to Back and back to Edit servers", async () => {
    await startLysPane(LYS_MAILBOX_ON_SETTINGS)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Edit servers" }))

    expect(
      screen.getByRole("form", { name: "Lys's email account" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Back to the mailbox" })
    ).toHaveFocus()
    expect(screen.getAllByRole("switch", { name: "Use this mailbox" })).toEqual(
      [
        within(screen.getByRole("form")).getByRole("switch", {
          name: "Use this mailbox"
        })
      ]
    )
    await user.click(
      screen.getByRole("button", { name: "Back to the mailbox" })
    )
    expect(screen.getByRole("button", { name: "Edit servers" })).toHaveFocus()

    await user.click(screen.getByRole("button", { name: "Change password" }))
    expect(
      screen.getByRole("form", { name: "Lys's email account" })
    ).toBeInTheDocument()
  })

  it("moves focus to Back only once, not when the section opens again", async () => {
    await startLysPane(LYS_MAILBOX_ON_SETTINGS)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Edit servers" }))

    await user.click(screen.getByRole("button", { name: "Collapse all" }))
    await user.click(screen.getByRole("button", { name: "Expand all" }))

    expect(screen.getByRole("button", { name: "Collapse all" })).toHaveFocus()
    expect(
      screen.getByRole("button", { name: "Back to the mailbox" })
    ).not.toHaveFocus()
  })

  it("asks before removing the mailbox, and Keep returns focus to Remove mailbox", async () => {
    const { useLysStore } = await startLysPane(LYS_MAILBOX_ON_SETTINGS)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove mailbox" }))

    expect(
      screen.getByRole("group", {
        name: `Remove Lys's mailbox and its password? The email server stops reading and sending as ${LYS_EMAIL_ACCOUNT.address}. Your own mailbox stays.`
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Keep Lys's mailbox" })
    ).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "Keep Lys's mailbox" }))

    expect(
      screen.queryByRole("button", { name: "Remove Lys's mailbox" })
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Remove mailbox" })).toHaveFocus()
    expect(useLysStore.getState().settings.email.lysAccount).toEqual(
      LYS_EMAIL_ACCOUNT
    )
  })

  it("keeps the mailbox on Escape from either choice of the question", async () => {
    const { useLysStore } = await startLysPane(LYS_MAILBOX_ON_SETTINGS)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Remove mailbox" }))
    screen.getByRole("button", { name: "Remove Lys's mailbox" }).focus()

    await user.keyboard("{Escape}")

    expect(
      screen.queryByRole("button", { name: "Remove Lys's mailbox" })
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Remove mailbox" })).toHaveFocus()
    expect(useLysStore.getState().settings.email.lysAccount).toEqual(
      LYS_EMAIL_ACCOUNT
    )
  })

  it("removes the mailbox once confirmed, switching it off first, and says so", async () => {
    const { useLysStore } = await startLysPane(
      LYS_MAILBOX_ON_SETTINGS,
      SAVE_ROUTES
    )
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove mailbox" }))
    await user.click(
      screen.getByRole("button", { name: "Remove Lys's mailbox" })
    )
    await waitForRenderedWork()

    const settings = useLysStore.getState().settings
    expect(settings.email.lysAccount).toBeNull()
    expect(settings.secrets.lysEmailPassword).toBeNull()
    expect(settings.mcp.builtIn.email.lysEnabled).toBe(false)
    const notice = screen.getByText("Lys's mailbox was removed.")
    expect(notice).toHaveFocus()
    expect(notice).toHaveRole("status")
    expect(
      screen.getByRole("form", { name: "Lys's email account" })
    ).toBeInTheDocument()
  })

  it("shows the MCP pane from Open in MCP", async () => {
    const { useLysStore } = await startLysPane(LYS_MAILBOX_ON_SETTINGS)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Open in MCP" }))

    expect(useLysStore.getState().settingsPane).toBe("mcp")
  })
})
