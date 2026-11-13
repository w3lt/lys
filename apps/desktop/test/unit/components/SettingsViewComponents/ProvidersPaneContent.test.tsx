import {
  LLM_PROVIDERS,
  llmProviderSettingsSchema,
  type LlmProvider
} from "@lys/share"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { updateProviderModelState } from "@/lib/store/model-runtime"
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

/** Stored settings with only Ollama Cloud on, the local address still saved. */
const OLLAMA_CLOUD_ACTIVE_SETTINGS: LysSettings = Object.freeze({
  ...STORED_SETTINGS,
  providers: llmProviderSettingsSchema.parse({
    ...STORED_PROVIDERS_SETTINGS,
    enabled: ["ollamaCloud"]
  })
})

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

describe("ProvidersPaneContent", () => {
  it("lists every provider with the turned-on one checked and open on its connection", async () => {
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
    ).toHaveTextContent("off")
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

  it("shows each provider's logo on its card, hidden from assistive technology", async () => {
    startNativeHostFake({})
    await startProvidersPane()

    expect(
      ["LM Studio", "Ollama", "Groq"].map((name) => {
        const logo = screen
          .getByRole("article", { name })
          .querySelector("svg[aria-hidden='true']")
        return logo?.querySelector("title")?.textContent
      })
    ).toEqual(["LM Studio", "Ollama", "Groq"])
  })

  it("turns the picked provider on in place of the one that was on, and reconnects both", async () => {
    const host = startSettingsHost()
    const { useLysStore, backend } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("radio", { name: "Groq" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual(["groq"])
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: { ...STORED_PROVIDERS_SETTINGS, enabled: ["groq"] }
        }
      }
    ])
    expect(countReconnections(backend, "groq")).toBe(1)
    expect(countReconnections(backend, "ollama")).toBe(1)
    expect(useLysStore.getState().providerModels.ollama.status).toBe("off")
    expect(screen.getByRole("radio", { name: "Ollama" })).not.toBeChecked()
    const groq = screen.getByRole("article", { name: "Groq" })
    expect(within(groq).getByLabelText("Groq API key")).toHaveAttribute(
      "placeholder",
      "gsk_f••••••••0000"
    )
    expect(groq).toHaveTextContent("connected · requests go to Groq")
  })

  it("saves a new server address on Enter and refuses one that is not an address", async () => {
    const host = startSettingsHost()
    await startProvidersPane()
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

  it("turns Ollama Cloud on in place of the local server from Ollama's card, which asks for a key", async () => {
    const host = startSettingsHost()
    const { useLysStore } = await startProvidersPane()
    const user = userEvent.setup()
    const ollama = screen.getByRole("article", { name: "Ollama" })

    await user.click(within(ollama).getByRole("button", { name: "Cloud" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.providers.enabled).toEqual([
      "ollamaCloud"
    ])
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          providers: { ...STORED_PROVIDERS_SETTINGS, enabled: ["ollamaCloud"] }
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
    await startProvidersPane(OLLAMA_CLOUD_ACTIVE_SETTINGS)
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

  it("turns the local Ollama server on when Ollama's card is picked", async () => {
    const host = startSettingsHost()
    await startProvidersPane(GROQ_ACTIVE_SETTINGS)
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

  it("reconnects to the turned-on provider on Test", async () => {
    startNativeHostFake({})
    const { backend } = await startProvidersPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test" }))
    await waitForRenderedWork()

    expect(countReconnections(backend, "ollama")).toBe(1)
    expect(countReconnections(backend, "lmStudio")).toBe(0)
  })
})
