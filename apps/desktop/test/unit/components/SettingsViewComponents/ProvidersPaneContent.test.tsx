import {
  LLM_PROVIDERS,
  llmProviderSettingsSchema,
  type LlmProvider
} from "@lys/share"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  updateProviderModelState,
  type LlmProviderStatus
} from "@/lib/store/model-runtime"
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

/**
 * Builds the route key of the backend's reconnection to one provider.
 *
 * @param provider - Provider reconnected.
 * @returns The route key.
 */
function buildConnectRoute(provider: LlmProvider): string {
  return `POST /api/v1/llm/${provider}/runtime/connect`
}

/**
 * Builds the backend's provider routes as the backend answers them: a
 * reconnection settles `connected` for a provider the settings turn on and
 * `off` for one they leave off, as the backend reads the saved group at each
 * attempt, and every provider lists no model.
 *
 * @param readEnabled - Reads the providers the settings turn on, at request
 * time.
 * @returns A connect and a list route for every provider.
 */
function buildProviderRoutes(
  readEnabled: () => readonly LlmProvider[]
): BackendRoutes {
  return Object.fromEntries(
    LLM_PROVIDERS.flatMap((provider) => [
      [
        buildConnectRoute(provider),
        () =>
          buildJsonResponse(200, {
            status: readEnabled().includes(provider) ? "connected" : "off"
          })
      ],
      [
        `GET /api/v1/llm/${provider}/list`,
        () => buildJsonResponse(200, { llms: [], modelLoading: "lys" })
      ]
    ])
  )
}

/** Stored settings with only Groq on and its key saved. */
const GROQ_ACTIVE_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  providers: llmProviderSettingsSchema.parse({
    ...STORED_PROVIDERS_SETTINGS,
    enabled: ["groq"]
  })
})

/**
 * Renders the settings view on the Providers pane, with the given settings
 * in the application store, every provider they turn on connected and every
 * other one off, and waits for the pane body.
 *
 * @param settings - Settings in the store; the stored ones, with only local
 * Ollama on, when omitted.
 * @returns The application store and the backend observation handle, whose
 * provider routes answer as {@link buildProviderRoutes} builds them.
 */
async function startProvidersPane(settings: LysSettings = STORED_SETTINGS) {
  let readEnabled = (): readonly LlmProvider[] => settings.providers.enabled
  const backend = startBackendFake({
    ...buildProviderRoutes(() => readEnabled()),
    [INVENTORY_ROUTE]: buildInventoryRoute()
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView("providers")
  readEnabled = () => useLysStore.getState().settings.providers.enabled
  let { providerModels } = useLysStore.getState()
  for (const provider of LLM_PROVIDERS) {
    providerModels = updateProviderModelState(providerModels, provider, {
      status: settings.providers.enabled.includes(provider)
        ? "connected"
        : "off"
    })
  }
  useLysStore.setState({ settings, providerModels })
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
 * Counts the reconnections to one provider the backend received.
 *
 * @param backend - Backend observation handle.
 * @param provider - Provider reconnected.
 * @returns How many connect requests for that provider arrived.
 */
function countReconnections(
  backend: BackendFake,
  provider: LlmProvider
): number {
  return backend.requests.filter(
    (request) => request.routeKey === buildConnectRoute(provider)
  ).length
}

/**
 * Starts a native host that loads the stored settings document and refuses
 * every write the way a failing Rust command does.
 *
 * @returns The host observation handle.
 */
function startFailingSettingsHost() {
  return startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => Promise.reject("disk full")
  })
}

/** Every provider's name, in provider order. */
const PROVIDER_NAMES = ["LM Studio", "Ollama", "Ollama Cloud", "Groq"]

/**
 * Lists each provider's switch, found by its accessible name, and whether it
 * is checked.
 *
 * @returns One name and checked state per provider, in provider order.
 */
function listProviderSwitches(): [string, boolean][] {
  return PROVIDER_NAMES.map((name) => [
    name,
    screen.getByRole("switch", { name }).getAttribute("aria-checked") === "true"
  ])
}

/**
 * Finds the badge of one provider's card.
 *
 * @param name - Provider's name, which names its card.
 * @returns The badge's text.
 */
function readProviderBadge(name: string): string | null {
  return (
    screen
      .getByRole("article", { name })
      .querySelector(".settings-view__secret-state")?.textContent ?? null
  )
}

/**
 * Finds the status line under a turned-on card's form, the card's one status
 * region without a name.
 *
 * @param name - Provider's name, which names its card.
 * @returns The status line.
 */
function getProviderStatusLine(name: string): HTMLElement {
  return within(screen.getByRole("article", { name })).getByRole("status", {
    name: ""
  })
}

/**
 * Finds a card's save line, the status region named after its provider.
 *
 * @param name - Provider's name, which names its card.
 * @returns The save line.
 */
function getProviderSaveLine(name: string): HTMLElement {
  return within(screen.getByRole("article", { name })).getByRole("status", {
    name: `${name} save`
  })
}

/** Stored settings with every provider off. */
const NO_PROVIDER_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  providers: llmProviderSettingsSchema.parse({
    ...STORED_PROVIDERS_SETTINGS,
    enabled: []
  })
})

describe("ProvidersPaneContent", () => {
  it("lists every provider in provider order with a switch that is on for the turned-on one", async () => {
    startNativeHostFake({})
    await startProvidersPane()

    expect(
      screen.getByRole("heading", { level: 1, name: "Providers" })
    ).toBeInTheDocument()
    const section = screen.getByRole("region", { name: "providers" })
    expect(section).toHaveTextContent("1 on")
    expect(
      within(section)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(PROVIDER_NAMES)
    expect(listProviderSwitches()).toEqual([
      ["LM Studio", false],
      ["Ollama", true],
      ["Ollama Cloud", false],
      ["Groq", false]
    ])
    expect(
      screen.getByRole("switch", { name: "Ollama" })
    ).toHaveAccessibleDescription(
      /Runs open models on this machine or your network/
    )
    expect(readProviderBadge("LM Studio")).toBe("off")
    const ollama = screen.getByRole("article", { name: "Ollama" })
    expect(readProviderBadge("Ollama")).toBe("connected")
    expect(within(ollama).getByLabelText("Server address")).toHaveAttribute(
      "placeholder",
      "192.168.1.20:11434"
    )
    expect(getProviderStatusLine("Ollama")).toHaveTextContent(
      "connected · 192.168.1.20:11434"
    )
    for (const name of ["LM Studio", "Ollama Cloud", "Groq"]) {
      const card = screen.getByRole("article", { name })
      expect(within(card).queryByRole("textbox")).toBeNull()
      expect(within(card).queryByRole("status", { name: "" })).toBeNull()
    }
    for (const name of PROVIDER_NAMES)
      expect(getProviderSaveLine(name)).toBeEmptyDOMElement()
  })

  it("shows each provider's logo on its card, hidden from assistive technology", async () => {
    startNativeHostFake({})
    await startProvidersPane()

    expect(
      PROVIDER_NAMES.map((name) => {
        const logo = screen
          .getByRole("article", { name })
          .querySelector("svg[aria-hidden='true']")
        return logo?.querySelector("title")?.textContent
      })
    ).toEqual(["LM Studio", "Ollama", "Ollama", "Groq"])
  })

  it("turns a provider on beside the one that is on, saves the list in provider order, and connects only it", async () => {
    const host = startSettingsHost()
    const { useLysStore, backend } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "LM Studio" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual([
      "lmStudio",
      "ollama"
    ])
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: {
            ...STORED_PROVIDERS_SETTINGS,
            enabled: ["lmStudio", "ollama"]
          }
        }
      }
    ])
    expect(countReconnections(backend, "lmStudio")).toBe(1)
    expect(countReconnections(backend, "ollama")).toBe(0)
    expect(listProviderSwitches()).toEqual([
      ["LM Studio", true],
      ["Ollama", true],
      ["Ollama Cloud", false],
      ["Groq", false]
    ])
    expect(screen.getByRole("region", { name: "providers" })).toHaveTextContent(
      "2 on"
    )
    const lmStudio = screen.getByRole("article", { name: "LM Studio" })
    expect(readProviderBadge("LM Studio")).toBe("connected")
    expect(within(lmStudio).getByLabelText("Server address")).toHaveAttribute(
      "placeholder",
      "127.0.0.1:1234"
    )
  })

  it("turns the last provider off, which leaves none on, hides its form, and lets the backend drop it", async () => {
    const host = startSettingsHost()
    const { useLysStore, backend } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Ollama" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual([])
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: { ...STORED_PROVIDERS_SETTINGS, enabled: [] }
        }
      }
    ])
    expect(countReconnections(backend, "ollama")).toBe(1)
    expect(useLysStore.getState().providerModels.ollama.status).toBe("off")
    expect(screen.getByRole("switch", { name: "Ollama" })).not.toBeChecked()
    expect(readProviderBadge("Ollama")).toBe("off")
    expect(screen.queryByLabelText("Server address")).toBeNull()
    expect(screen.getByRole("region", { name: "providers" })).toHaveTextContent(
      "0 on"
    )
  })

  it("asks for a key when a keyed provider is turned on without one", async () => {
    const host = startSettingsHost()
    const { useLysStore } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Ollama Cloud" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual([
      "ollama",
      "ollamaCloud"
    ])
    expect(listSettingsWrites(host.commands)).toHaveLength(1)
    const cloud = screen.getByRole("article", { name: "Ollama Cloud" })
    expect(readProviderBadge("Ollama Cloud")).toBe("needs key")
    expect(getProviderStatusLine("Ollama Cloud")).toHaveTextContent(
      "No key yet. Lys can't reach Ollama Cloud until there is one."
    )
    expect(
      within(cloud).getByLabelText("Ollama Cloud API key")
    ).toBeInTheDocument()
    expect(
      within(cloud).getByRole("link", { name: /get a key/ })
    ).toHaveAttribute("href", "https://ollama.com/settings/keys")
  })

  it.each<[LlmProviderStatus, string]>([
    ["connecting", "connecting"],
    ["connected", "connected"],
    ["unreachable", "not reachable"],
    ["off", "off"]
  ])(
    "marks a turned-on provider whose connection is %s as %s",
    async (status, badge) => {
      startNativeHostFake({})
      const { useLysStore } = await startProvidersPane(GROQ_ACTIVE_SETTINGS)

      act(() => {
        useLysStore.setState((state) => ({
          providerModels: updateProviderModelState(
            state.providerModels,
            "groq",
            { status }
          )
        }))
      })

      expect(readProviderBadge("Groq")).toBe(badge)
    }
  )

  it("disables every switch while a provider save runs, and says so on that provider's card only", async () => {
    startNativeHostFake({})
    const { useLysStore } = await startProvidersPane()

    act(() => {
      useLysStore.setState({
        providerSettingsSave: { status: "saving", provider: "groq" }
      })
    })

    for (const control of screen.getAllByRole("switch"))
      expect(control).toHaveAttribute("aria-disabled", "true")
    expect(getProviderSaveLine("Groq")).toHaveTextContent("saving…")
    for (const name of ["LM Studio", "Ollama", "Ollama Cloud"])
      expect(getProviderSaveLine(name)).toBeEmptyDOMElement()
  })

  it("keeps the providers as they were when the switch's save fails, and says why", async () => {
    startFailingSettingsHost()
    const { useLysStore, backend } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Groq" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual([
      "ollama"
    ])
    expect(countReconnections(backend, "groq")).toBe(0)
    expect(screen.getByRole("switch", { name: "Groq" })).not.toBeChecked()
    expect(getProviderSaveLine("Groq")).toHaveTextContent(
      "Lys couldn't write the provider to its settings file."
    )
    expect(getProviderSaveLine("Ollama")).toBeEmptyDOMElement()
    expect(getProviderStatusLine("Ollama")).toHaveTextContent(
      "connected · 192.168.1.20:11434"
    )
  })

  it("says why a switch's save failed on that card while no provider is on", async () => {
    startFailingSettingsHost()
    const { useLysStore, backend } =
      await startProvidersPane(NO_PROVIDER_SETTINGS)
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "LM Studio" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual([])
    expect(countReconnections(backend, "lmStudio")).toBe(0)
    expect(screen.getByRole("switch", { name: "LM Studio" })).not.toBeChecked()
    expect(getProviderSaveLine("LM Studio")).toHaveTextContent(
      "Lys couldn't write the provider to its settings file."
    )
    for (const name of ["Ollama", "Ollama Cloud", "Groq"])
      expect(getProviderSaveLine(name)).toBeEmptyDOMElement()
  })

  it("says why an address save failed on the card of that address", async () => {
    startFailingSettingsHost()
    const { useLysStore } = await startProvidersPane()
    const user = userEvent.setup()

    await user.type(
      screen.getByLabelText("Server address"),
      "localhost:11500{Enter}"
    )
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.ollama.address).toBe(
      STORED_PROVIDERS_SETTINGS.ollama.address
    )
    expect(screen.getByLabelText("Server address")).toHaveValue(
      "localhost:11500"
    )
    expect(getProviderSaveLine("Ollama")).toHaveTextContent(
      "Lys couldn't write the provider to its settings file."
    )
  })

  it("saves a new server address on Enter and refuses one that is not an address", async () => {
    const host = startSettingsHost()
    await startProvidersPane()
    const user = userEvent.setup()
    const field = screen.getByLabelText("Server address")

    await user.type(field, "localhost")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(getProviderStatusLine("Ollama")).toHaveTextContent(
      "not an address: use host:port"
    )
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

  it("saves a new key of a turned-on provider and reconnects it, then removes it", async () => {
    const host = startSettingsHost()
    const { useLysStore, backend } =
      await startProvidersPane(GROQ_ACTIVE_SETTINGS)
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
    expect(countReconnections(backend, "groq")).toBe(1)

    await user.click(screen.getByRole("button", { name: "Remove" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.secrets.groqApiKey).toBeNull()
    expect(screen.getByRole("article", { name: "Groq" })).toHaveTextContent(
      "needs key"
    )
    expect(screen.getByLabelText("Groq API key")).toHaveFocus()
  })

  it("reconnects to the card's own provider on Test", async () => {
    startNativeHostFake({})
    const { backend } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test" }))
    await waitForRenderedWork()

    expect(countReconnections(backend, "ollama")).toBe(1)
    expect(countReconnections(backend, "lmStudio")).toBe(0)
  })
})
