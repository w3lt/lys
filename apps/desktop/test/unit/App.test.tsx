import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { BackendServerInfo } from "@/lib/store"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  initialSettingsState,
  type LysSettings,
  type RuntimeSettings
} from "@/lib/store/settings"
import type { VmoServerInfo } from "@/lib/store/vmo-runtime"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildUserMessage,
  FIXTURE_CONVERSATION_ID
} from "./support/conversationFixtures"
import {
  buildJsonResponse,
  startBackendFake,
  type ObservedBackendRequest
} from "./support/backendFake"
import { startNativeHostFake } from "./support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "./support/settlement"

/** Runtime group with both startup switches off. */
const MANUAL_START_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  ...initialSettingsState.runtime,
  autoStartBackend: false,
  autoStartVmo: false
})

/** Saved settings that leave the backend and vmo stopped when Lys opens. */
const MANUAL_START_SETTINGS: LysSettings = Object.freeze({
  ...initialSettingsState,
  runtime: MANUAL_START_RUNTIME_SETTINGS
})

/** Route key of the backend's tool list. */
const TOOL_LIST_ROUTE = "GET /api/v1/tools"

/** Route key of the request that asks the backend to apply the MCP servers. */
const MCP_SERVER_SYNC_ROUTE = "POST /api/v1/mcp/servers/sync"

/**
 * Lists the requests a backend double received for one route.
 *
 * @param requests - Every request the double received, in arrival order.
 * @param routeKey - Route whose requests are kept.
 * @returns The route's requests, in arrival order.
 */
function filterRouteRequests(
  requests: readonly ObservedBackendRequest[],
  routeKey: string
): readonly ObservedBackendRequest[] {
  return requests.filter((request) => request.routeKey === routeKey)
}

/**
 * Starts a native host whose backend process and vmo are stopped and stay
 * stopped.
 *
 * @param loadSettings - Result of the settings read.
 * @returns The host observation handle.
 */
function startStoppedDesktopHost(
  loadSettings: () => unknown = () => MANUAL_START_SETTINGS
) {
  return startNativeHostFake({
    load_settings: loadSettings,
    get_backend_status: () => ({ running: false }),
    get_vmo_status: () => ({ status: "stopped" })
  })
}

/**
 * Loads fresh stores and the application shell.
 *
 * @returns The stores the shell reads and the shell component.
 */
async function loadFreshApp() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { default: App } = await import("@/App")
  return { useLysStore, useChatViewStore, App }
}

describe("App", () => {
  it("stays blank until settings load, then shows the title bar and the chat view", async () => {
    const settings = createControlledPromise<unknown>()
    const host = startStoppedDesktopHost(() => settings.promise)
    const { App } = await loadFreshApp()
    const { container } = render(<App />)
    // Let the lazily loaded chat view resolve, so only the pending settings
    // can keep the shell blank.
    await act(async () => {
      await import("@/views/ChatView/ChatView")
      await waitForMicrotasks()
    })

    expect(container).toBeEmptyDOMElement()

    await act(async () => {
      settings.resolve(MANUAL_START_SETTINGS)
      await settings.promise
    })

    expect(await screen.findByRole("main")).toContainElement(
      screen.getByRole("region", { name: "Conversation" })
    )
    expect(screen.getByRole("banner")).toHaveTextContent("Lys")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings",
      "get_backend_status",
      "get_vmo_status"
    ])
  })

  it("reads a tool list already read again when vmo starts running while mounted, and stops after unmount", async () => {
    const host = startNativeHostFake({
      load_settings: () => MANUAL_START_SETTINGS,
      get_backend_status: () => ({ running: false }),
      get_vmo_status: () => ({ status: "stopped" }),
      list_tools: () => []
    })
    const backend = startBackendFake({
      [TOOL_LIST_ROUTE]: () =>
        buildJsonResponse(200, { tools: [], unavailableTools: [] }),
      // The shell asks the backend to apply the MCP servers once it runs.
      [MCP_SERVER_SYNC_ROUTE]: () =>
        buildJsonResponse(200, { settings: "applied", servers: [] })
    })
    const { useLysStore, App } = await loadFreshApp()
    const { useToolStore } = await import("@/lib/store/tools")
    // Settings shows no view that reads the backend on its own.
    useLysStore.setState({ activeView: "settings" })
    const { unmount } = render(<App />)
    await screen.findByRole("main", { name: "Settings" })
    const runningBackend: BackendServerInfo = { status: "running" }
    useLysStore.setState({ backendServerInfo: runningBackend })
    await useToolStore.getState().loadTools()

    const runningVmo: VmoServerInfo = { status: "running", problem: null }
    act(() => {
      useLysStore.setState({ vmoServerInfo: runningVmo })
    })
    await vi.waitFor(() => {
      expect(
        filterRouteRequests(backend.requests, TOOL_LIST_ROUTE)
      ).toHaveLength(2)
    })
    unmount()
    const stoppedVmo: VmoServerInfo = { status: "stopped", problem: null }
    useLysStore.setState({ vmoServerInfo: stoppedVmo })
    await waitForMicrotasks()

    expect(filterRouteRequests(backend.requests, TOOL_LIST_ROUTE)).toHaveLength(
      2
    )
    expect(
      host.commands.filter((invoked) => invoked.command === "list_tools")
    ).toHaveLength(2)
  })

  it("asks the backend to apply the MCP servers when it starts running while mounted, and stops after unmount", async () => {
    startStoppedDesktopHost()
    const backend = startBackendFake({
      [MCP_SERVER_SYNC_ROUTE]: () =>
        buildJsonResponse(200, { settings: "applied", servers: [] })
    })
    const { useLysStore, App } = await loadFreshApp()
    const { useMcpServerStore } = await import("@/lib/store/mcp-servers")
    // Settings shows no view that reads the backend on its own.
    useLysStore.setState({ activeView: "settings" })
    const { unmount } = render(<App />)
    await screen.findByRole("main", { name: "Settings" })
    const runningBackend: BackendServerInfo = { status: "running" }
    const stoppedBackend: BackendServerInfo = { status: "stopped" }

    act(() => {
      useLysStore.setState({ backendServerInfo: runningBackend })
    })
    await vi.waitFor(() => {
      expect(useMcpServerStore.getState().list.status).toBe("loaded")
    })
    unmount()
    useLysStore.setState({ backendServerInfo: stoppedBackend })
    useLysStore.setState({ backendServerInfo: runningBackend })
    await waitForMicrotasks()

    expect(
      filterRouteRequests(backend.requests, MCP_SERVER_SYNC_ROUTE)
    ).toHaveLength(1)
    expect(useMcpServerStore.getState().list.status).toBe("loaded")
  })

  it("switches to Settings and back to the chat on Done", async () => {
    startStoppedDesktopHost()
    const { App } = await loadFreshApp()
    render(<App />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole("button", { name: "Settings" }))

    expect(
      await screen.findByRole("main", { name: "Settings" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull()

    await user.click(await screen.findByRole("button", { name: "Done" }))

    expect(
      await screen.findByRole("region", { name: "Conversation" })
    ).toBeInTheDocument()
  })

  it("keeps the transcript pinned until the reader scrolls away, and pins it again on Jump to latest", async () => {
    startStoppedDesktopHost()
    const { useChatViewStore, App } = await loadFreshApp()
    useChatViewStore.setState({
      conversation: createStoredChatViewConversation(
        buildConversation(FIXTURE_CONVERSATION_ID, "Trip", [
          buildUserMessage(2, "Plan a trip"),
          buildCompletedAssistantMessage(3, "Start with the route.")
        ])
      )
    })
    render(<App />)
    const user = userEvent.setup()
    const host = await screen.findByTestId("transcript")
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()

    Object.defineProperty(host, "scrollHeight", { value: 1000 })
    Object.defineProperty(host, "clientHeight", { value: 400 })
    Object.defineProperty(host, "scrollTop", { value: 100 })
    fireEvent.scroll(host)

    await user.click(screen.getByRole("button", { name: "Jump to latest" }))

    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()
  })
})
