import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import { initialSettingsState, type LysSettings } from "@/lib/store/settings"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildUserMessage,
  FIXTURE_CONVERSATION_ID
} from "./support/conversationFixtures"
import { buildJsonResponse, startBackendFake } from "./support/backendFake"
import { startNativeHostFake } from "./support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "./support/settlement"

/** Saved settings that leave the backend and vmo stopped when Lys opens. */
const MANUAL_START_SETTINGS: LysSettings = {
  ...initialSettingsState,
  runtime: {
    ...initialSettingsState.runtime,
    autoStartBackend: false,
    autoStartVmo: false
  }
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

  it("reads the tool list again when vmo starts running while mounted, and stops after unmount", async () => {
    const host = startNativeHostFake({
      load_settings: () => MANUAL_START_SETTINGS,
      get_backend_status: () => ({ running: false }),
      get_vmo_status: () => ({ status: "stopped" }),
      list_tools: () => []
    })
    const backend = startBackendFake({
      "GET /api/v1/tools": () =>
        buildJsonResponse(200, { tools: [], unavailableTools: [] })
    })
    const { useLysStore, App } = await loadFreshApp()
    // Settings shows no view that reads the backend on its own.
    useLysStore.setState({ activeView: "settings" })
    const { unmount } = render(<App />)
    await screen.findByRole("main", { name: "Settings" })
    useLysStore.setState({ backendServerInfo: { status: "running" } })

    act(() => {
      useLysStore.setState({
        vmoServerInfo: { status: "running", problem: null }
      })
    })
    await vi.waitFor(() => {
      expect(backend.requests).toHaveLength(1)
    })
    unmount()
    useLysStore.setState({
      vmoServerInfo: { status: "stopped", problem: null }
    })
    await waitForMicrotasks()

    expect(backend.requests).toHaveLength(1)
    expect(
      host.commands.filter((invoked) => invoked.command === "list_tools")
    ).toHaveLength(1)
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
