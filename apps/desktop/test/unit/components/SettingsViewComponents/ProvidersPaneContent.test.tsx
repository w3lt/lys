import { llmProviderSettingsSchema } from "@lys/share"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { LysSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import {
  STORED_PROVIDERS_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"

/** Route key of the backend's reconnection. */
const CONNECT_ROUTE = "POST /api/v1/llm/runtime/connect"

/** Backend reconnection that settles connected. */
const CONNECTED_ROUTE: BackendRoutes = Object.freeze({
  [CONNECT_ROUTE]: () => buildJsonResponse(200, { status: "connected" })
})

/** Stored settings with Ollama Cloud active, the local address still saved. */
const OLLAMA_CLOUD_ACTIVE_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  providers: llmProviderSettingsSchema.parse({
    ...STORED_PROVIDERS_SETTINGS,
    active: "ollamaCloud"
  })
})

/** Stored settings with Groq active and its key saved. */
const GROQ_ACTIVE_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  providers: llmProviderSettingsSchema.parse({
    ...STORED_PROVIDERS_SETTINGS,
    active: "groq"
  })
})

/**
 * Renders the settings view on the Providers pane, with the given settings
 * in the application store and the backend connected, and waits for the
 * pane body.
 *
 * @param settings - Settings in the store; the stored ones, with local
 * Ollama active, when omitted.
 * @param routes - Backend routes the case needs besides the inventory read.
 * @returns The application store and the backend observation handle.
 */
async function startProvidersPane(
  settings: LysSettings = STORED_SETTINGS,
  routes: BackendRoutes = {}
) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView("providers")
  useLysStore.setState({ settings })
  render(<SettingsView onDone={vi.fn()} />)
  // The closing note is withheld until the lazily loaded pane body is shown.
  await screen.findByText(/^Saved in settings\.json in Lys's home folder/)
  await waitForRenderedWork()
  return { useLysStore, backend }
}

/**
 * Starts a native host that loads the stored settings document and accepts
 * every write.
 *
 * @returns The host observation handle.
 */
function startSettingsHost() {
  return startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => null
  })
}

/**
 * Lists the documents of every settings write, in order.
 *
 * @param commands - Native commands the host observed.
 * @returns The arguments each `save_settings` call carried.
 */
function listSettingsWrites(
  commands: readonly { command: string; args: unknown }[]
): unknown[] {
  return commands
    .filter((invoked) => invoked.command === "save_settings")
    .map((invoked) => invoked.args)
}

/**
 * Counts the reconnections the backend received.
 *
 * @param backend - Backend observation handle.
 * @returns How many connect requests arrived.
 */
function countReconnections(backend: BackendFake): number {
  return backend.requests.filter(
    (request) => request.routeKey === CONNECT_ROUTE
  ).length
}

describe("ProvidersPaneContent", () => {
  it("lists every provider with the active one open on its connection", async () => {
    startNativeHostFake({})
    await startProvidersPane()

    expect(
      screen.getByRole("heading", { level: 1, name: "Providers" })
    ).toBeInTheDocument()
    const section = screen.getByRole("region", { name: "provider" })
    expect(section).toHaveTextContent("3 providers")
    const group = within(section).getByRole("radiogroup", { name: "provider" })
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => [
          radio.getAttribute("value"),
          radio.matches(":checked")
        ])
    ).toEqual([
      ["lmStudio", false],
      ["ollama", true],
      ["groq", false]
    ])
    expect(
      screen.getByRole("article", { name: "LM Studio" })
    ).toHaveTextContent("standby")
    const ollama = screen.getByRole("article", { name: "Ollama" })
    expect(ollama).toHaveTextContent("connected")
    const modes = within(ollama).getByRole("group", { name: "Configure" })
    expect(
      within(modes).getByRole("button", { name: "Local" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(within(ollama).getByLabelText("Server address")).toHaveAttribute(
      "placeholder",
      "192.168.1.20:11434"
    )
    expect(within(ollama).getByRole("status")).toHaveTextContent(
      "connected · 192.168.1.20:11434"
    )
    expect(
      within(screen.getByRole("article", { name: "Groq" })).queryByRole(
        "status"
      )
    ).toBeNull()
  })

  it("saves a picked provider and reconnects to it", async () => {
    const host = startSettingsHost()
    const { useLysStore, backend } = await startProvidersPane(
      STORED_SETTINGS,
      CONNECTED_ROUTE
    )
    const user = userEvent.setup()

    await user.click(screen.getByRole("radio", { name: "Groq" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.active).toBe("groq")
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: { ...STORED_PROVIDERS_SETTINGS, active: "groq" }
        }
      }
    ])
    expect(countReconnections(backend)).toBe(1)
    const groq = screen.getByRole("article", { name: "Groq" })
    expect(within(groq).getByLabelText("Groq API key")).toHaveAttribute(
      "placeholder",
      "gsk_f••••••••0000"
    )
    expect(groq).toHaveTextContent("connected · requests go to Groq")
  })

  it("saves a new server address on Enter and refuses one that is not an address", async () => {
    const host = startSettingsHost()
    await startProvidersPane(STORED_SETTINGS, CONNECTED_ROUTE)
    const user = userEvent.setup()
    const field = screen.getByLabelText("Server address")

    await user.type(field, "localhost")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(
      within(screen.getByRole("article", { name: "Ollama" })).getByRole(
        "status"
      )
    ).toHaveTextContent("not an address: use host:port")
    await user.type(field, ":11500{Enter}")
    await waitForRenderedWork()

    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: {
            ...STORED_PROVIDERS_SETTINGS,
            ollama: { address: "localhost:11500" }
          }
        }
      }
    ])
    expect(field).toHaveValue("")
    expect(field).toHaveAttribute("placeholder", "localhost:11500")
  })

  it("makes Ollama Cloud the active provider from Ollama's card, which asks for a key", async () => {
    const host = startSettingsHost()
    const { useLysStore } = await startProvidersPane(
      STORED_SETTINGS,
      CONNECTED_ROUTE
    )
    const user = userEvent.setup()
    const ollama = screen.getByRole("article", { name: "Ollama" })

    await user.click(within(ollama).getByRole("button", { name: "Cloud" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.active).toBe("ollamaCloud")
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: { ...STORED_PROVIDERS_SETTINGS, active: "ollamaCloud" }
        }
      }
    ])
    expect(screen.getByRole("radio", { name: "Ollama" })).toBeChecked()
    expect(ollama).toHaveTextContent("needs key")
    expect(within(ollama).getByRole("status")).toHaveTextContent(
      "No key yet. Lys can't reach Ollama Cloud until there is one."
    )
    expect(
      within(ollama).getByLabelText("Ollama Cloud API key")
    ).toBeInTheDocument()
    expect(
      within(ollama).getByRole("link", { name: /get a key/ })
    ).toHaveAttribute("href", "https://ollama.com/settings/keys")
  })

  it("shows Ollama Cloud on Ollama's card and switches back to the local server", async () => {
    const host = startSettingsHost()
    await startProvidersPane(OLLAMA_CLOUD_ACTIVE_SETTINGS, CONNECTED_ROUTE)
    const user = userEvent.setup()
    const ollama = screen.getByRole("article", { name: "Ollama" })

    expect(screen.getByRole("radio", { name: "Ollama" })).toBeChecked()
    expect(ollama).toHaveTextContent("cloud")
    expect(
      within(ollama).getByRole("button", { name: "Cloud" })
    ).toHaveAttribute("aria-pressed", "true")

    await user.click(within(ollama).getByRole("button", { name: "Local" }))
    await waitForRenderedWork()

    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: STORED_PROVIDERS_SETTINGS
        }
      }
    ])
    expect(within(ollama).getByLabelText("Server address")).toHaveAttribute(
      "placeholder",
      "192.168.1.20:11434"
    )
  })

  it("makes the local Ollama server active when Ollama's card is picked", async () => {
    const host = startSettingsHost()
    await startProvidersPane(GROQ_ACTIVE_SETTINGS, CONNECTED_ROUTE)
    const user = userEvent.setup()

    await user.click(screen.getByRole("radio", { name: "Ollama" }))
    await waitForRenderedWork()

    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: STORED_PROVIDERS_SETTINGS
        }
      }
    ])
    expect(
      within(screen.getByRole("article", { name: "Ollama" })).getByRole(
        "button",
        { name: "Local" }
      )
    ).toHaveAttribute("aria-pressed", "true")
  })

  it("saves a new key of the active provider and reconnects, then removes it", async () => {
    const host = startSettingsHost()
    const { useLysStore, backend } = await startProvidersPane(
      GROQ_ACTIVE_SETTINGS,
      CONNECTED_ROUTE
    )
    const user = userEvent.setup()

    await user.type(
      screen.getByLabelText("Groq API key"),
      "gsk_fixture_2222222222222222{Enter}"
    )
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.secrets.groqApiKey).toBe(
      "gsk_fixture_2222222222222222"
    )
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          secrets: {
            ...STORED_SETTINGS_DOCUMENT.secrets,
            groqApiKey: "gsk_fixture_2222222222222222"
          }
        }
      }
    ])
    expect(countReconnections(backend)).toBe(1)

    await user.click(screen.getByRole("button", { name: "Remove" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.secrets.groqApiKey).toBeNull()
    expect(screen.getByRole("article", { name: "Groq" })).toHaveTextContent(
      "needs key"
    )
    expect(screen.getByLabelText("Groq API key")).toHaveFocus()
  })

  it("reconnects to the active provider on Test", async () => {
    startNativeHostFake({})
    const { backend } = await startProvidersPane(
      STORED_SETTINGS,
      CONNECTED_ROUTE
    )
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test" }))
    await waitForRenderedWork()

    expect(countReconnections(backend)).toBe(1)
  })
})
