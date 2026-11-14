import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import { createControlledPromise } from "../../support/settlement"
import {
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import { buildBackendToolDefinition } from "../../support/toolFixtures"

/** Route key of the backend's tool list. */
const TOOLS_ROUTE = "GET /api/v1/tools"

/** Route key of the key check. */
const KEY_CHECK_ROUTE = "POST /api/v1/tools/web_search/key-check"

/**
 * Renders the settings view on the Secrets pane, with the stored settings and
 * their saved key in the application store, and waits for the pane body.
 *
 * @param routes - Backend routes the case needs besides the inventory read.
 * @returns The application store and the backend observation handle.
 */
async function startSecretsPane(routes: BackendRoutes = {}) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView("secrets")
  const { useToolStore } = await import("@/lib/store/tools")
  useLysStore.setState({ settings: STORED_SETTINGS })
  render(<SettingsView onDone={vi.fn()} />)
  // The storage banner is part of the lazily loaded pane body.
  await screen.findByText("Kept on this machine, in plain text")
  await waitForRenderedWork()
  return { useLysStore, useToolStore, backend }
}

/**
 * Lists the requests the backend received for one route.
 *
 * @param backend - Backend observation handle.
 * @param routeKey - `"<METHOD> <path>"` of the route.
 * @returns The requests in arrival order.
 */
function listRouteRequests(backend: BackendFake, routeKey: string) {
  return backend.requests.filter((request) => request.routeKey === routeKey)
}

/** Backend tool list answered after a save: web_search can run. */
const TOOL_LIST_ROUTE: BackendRoutes = Object.freeze({
  [TOOLS_ROUTE]: () =>
    buildJsonResponse(200, {
      tools: [buildBackendToolDefinition("web_search")],
      unavailableTools: []
    })
})

describe("SecretsPaneContent", () => {
  it("presents the web search service and its key card in the Secrets pane", async () => {
    startNativeHostFake({})
    await startSecretsPane()

    expect(
      screen.getByRole("heading", { level: 1, name: "Secrets" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Keys for services Lys calls on your behalf that are not set up anywhere else, such as web search. Each goes only to its own service and is never sent to the model."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/^A server's token is kept with that server under/)
    ).toHaveTextContent(
      "A server's token is kept with that server under MCP. A mailbox's password is kept with its mailbox, in Lys for Lys's and under MCP for yours."
    )
    const section = screen.getByRole("region", { name: "Search service" })
    expect(section).toHaveTextContent(
      "The web_search tool sends queries to one service at a time."
    )
    expect(
      within(section).getByRole("article", { name: "Tavily" })
    ).toHaveTextContent("in use")
    expect(screen.getByLabelText("API key")).toHaveAttribute(
      "placeholder",
      "tvly-••••••••0000"
    )
  })

  it("shows the MCP and Lys panes from its opening line", async () => {
    startNativeHostFake({})
    const { useLysStore } = await startSecretsPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Lys" }))

    expect(useLysStore.getState().settingsPane).toBe("lys")
  })

  it("saves a new key, then reads the tool list again so web_search's availability follows it", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null,
      list_tools: () => []
    })
    const { useLysStore, backend } = await startSecretsPane(TOOL_LIST_ROUTE)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText("API key"), "tvly-new-key{Enter}")
    await waitForRenderedWork()

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: {
              ...STORED_SETTINGS_DOCUMENT.secrets,
              tavilyApiKey: "tvly-new-key"
            }
          }
        }
      },
      { command: "list_tools", args: {} }
    ])
    expect(useLysStore.getState().settings.secrets).toEqual({
      ...STORED_SETTINGS.secrets,
      tavilyApiKey: "tvly-new-key"
    })
    expect(listRouteRequests(backend, TOOLS_ROUTE)).toHaveLength(1)
    expect(screen.getByLabelText("API key")).toHaveValue("")
  })

  it("reads the tool list again after a read in flight when the save finishes, so the list reflects the saved key", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null,
      list_tools: () => []
    })
    const staleList = createControlledPromise<Response>()
    let toolListReads = 0
    const { useToolStore, backend } = await startSecretsPane({
      [TOOLS_ROUTE]: () => {
        toolListReads += 1
        return toolListReads === 1
          ? staleList.promise
          : buildJsonResponse(200, {
              tools: [buildBackendToolDefinition("web_search")],
              unavailableTools: []
            })
      }
    })
    const user = userEvent.setup()
    const readInFlight = useToolStore.getState().loadTools()

    await user.type(screen.getByLabelText("API key"), "tvly-new-key{Enter}")
    await waitForRenderedWork()
    const requestsWhileStale = listRouteRequests(backend, TOOLS_ROUTE).length
    staleList.resolve(
      buildJsonResponse(200, {
        tools: [],
        unavailableTools: [{ name: "web_search", reason: "api-key-missing" }]
      })
    )
    await readInFlight
    await waitForRenderedWork()

    expect(requestsWhileStale).toBe(1)
    expect(listRouteRequests(backend, TOOLS_ROUTE)).toHaveLength(2)
    expect(useToolStore.getState().list).toMatchObject({
      status: "loaded",
      unavailableTools: new Map()
    })
    expect(screen.getByLabelText("API key")).toHaveValue("")
  })

  it("removes the key, then reads the tool list again", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null,
      list_tools: () => []
    })
    const { useLysStore, backend } = await startSecretsPane(TOOL_LIST_ROUTE)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.secrets.tavilyApiKey).toBeNull()
    expect(listRouteRequests(backend, TOOLS_ROUTE)).toHaveLength(1)
    expect(screen.getByRole("article", { name: "Tavily" })).toHaveTextContent(
      "no key"
    )
    expect(screen.getByLabelText("API key")).toHaveFocus()
  })

  it("reads no tool list when the save fails, and says so", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })
    const { backend } = await startSecretsPane()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText("API key"), "tvly-new-key{Enter}")
    await waitForRenderedWork()

    expect(listRouteRequests(backend, TOOLS_ROUTE)).toHaveLength(0)
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings",
      "save_settings"
    ])
    expect(screen.getByLabelText("API key")).toHaveValue("tvly-new-key")
    await user.keyboard("{Escape}")
    expect(screen.getByLabelText("API key")).toHaveAccessibleDescription(
      "Lys couldn't write the key to its settings file."
    )
  })

  it("checks the saved key with the backend and shows the outcome", async () => {
    startNativeHostFake({})
    const { backend } = await startSecretsPane({
      [KEY_CHECK_ROUTE]: () =>
        buildJsonResponse(200, {
          status: "accepted",
          credits: { used: 3, limit: 1_000 }
        })
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test" }))
    await waitForRenderedWork()

    expect(listRouteRequests(backend, KEY_CHECK_ROUTE)).toHaveLength(1)
    expect(screen.getByRole("article", { name: "Tavily" })).toHaveTextContent(
      "verified"
    )
    expect(screen.getByLabelText("API key")).toHaveAccessibleDescription(
      "key accepted · 3 of 1,000 credits used"
    )
  })
})
