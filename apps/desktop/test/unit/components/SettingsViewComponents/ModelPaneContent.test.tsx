import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ollamaApiKeySchema, type LlmProvider } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  updateProviderModelState,
  type ModelInventoryState,
  type ProviderModelState
} from "@/lib/store/model-runtime"
import type { LysSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
  createControlledRoute,
  listRouteKeys,
  startBackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  buildUnreachableRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import {
  openMenuWithKeyboard,
  waitForRenderedWork
} from "../../support/rendering"
import { STORED_GROQ_API_KEY } from "../../support/settingsFixtures"

/** LM Studio with one loaded default model and one model on disk. */
const TWO_MODELS: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    modelLoading: "lys",
    models: [
      buildLlmInfo("qwen3-8b", {
        loaded: true,
        loadedContextLength: 8192,
        maxContextLength: 32_768
      }),
      buildLlmInfo("google/gemma-3:4b", { maxContextLength: 32_768 })
    ]
  }
}

/** Groq's inventory: one hosted model. */
const GROQ_MODELS: Partial<ProviderModelState> = {
  status: "connected",
  inventory: {
    status: "ready",
    modelLoading: "provider",
    models: [
      {
        ...buildLlmInfo("llama-3.3-70b", {
          loaded: true,
          maxContextLength: 131_072
        }),
        sizeBytes: undefined
      }
    ]
  }
}

/** Ollama's inventory: one loaded model and one on disk. */
const OLLAMA_MODELS: Partial<ProviderModelState> = {
  status: "connected",
  inventory: {
    status: "ready",
    modelLoading: "provider",
    models: [
      buildLlmInfo("llama3.2:3b", { loaded: true, loadedContextLength: 4096 }),
      buildLlmInfo("mistral")
    ]
  }
}

/** Ollama Cloud's inventory: one hosted model. */
const OLLAMA_CLOUD_MODELS: Partial<ProviderModelState> = {
  status: "connected",
  inventory: {
    status: "ready",
    modelLoading: "provider",
    models: [
      {
        ...buildLlmInfo("kimi-k2", { loaded: true, maxContextLength: 65_536 }),
        sizeBytes: undefined
      }
    ]
  }
}

/**
 * Ollama Cloud API key saved on disk: a made-up value, never a key Ollama
 * issued.
 */
const STORED_OLLAMA_API_KEY = ollamaApiKeySchema.parse("ollama-fixture-000000")

/** Route keys of LM Studio's load and unload endpoints. */
const LOAD_ROUTE = "POST /api/v1/llm/lmStudio/load"
const UNLOAD_ROUTE = "PATCH /api/v1/llm/lmStudio/unload"

/** Another provider the pane shows beside LM Studio, with its routes. */
type ExtraProvider = {
  /** The provider, turned on in the settings. */
  readonly provider: Exclude<LlmProvider, "lmStudio">
  /** Its status and models. */
  readonly state: Partial<ProviderModelState>
}

/** What a Models pane case arranges besides the runtime. */
type ModelPaneArrangement = {
  /** Backend routes the case needs besides the inventory reads. */
  readonly routes?: BackendRoutes
  /** Another provider turned on beside LM Studio, with its state. */
  readonly extra?: ExtraProvider
  /** Changes the case makes to the arranged settings. */
  readonly change?: (settings: LysSettings) => LysSettings
}

/** An inventory read that lists no model, and the notice the pane shows. */
type InventoryNoticeCase = {
  /** LM Studio's inventory observation. */
  readonly modelInventory: ModelInventoryState
  /** The notice's title. */
  readonly title: string
  /** What the notice says to do. */
  readonly body: string
}

/**
 * Builds the inventory route of a provider other than LM Studio.
 *
 * @param extra - The provider and its models.
 * @returns The route answering its inventory read.
 */
function buildExtraInventoryRoutes(extra: ExtraProvider): BackendRoutes {
  const { inventory } = extra.state
  if (inventory?.status !== "ready") return {}
  return {
    [`GET /api/v1/llm/${extra.provider}/list`]: () =>
      buildJsonResponse(200, {
        llms: inventory.models,
        modelLoading: inventory.modelLoading
      })
  }
}

/**
 * Renders the settings view on the Models pane with LM Studio, and another
 * provider when given, and waits for the pane's body to settle.
 *
 * @param runtime - Backend, LM Studio, and default model facts.
 * @param options - Extra routes, another provider, and settings changes.
 * @returns The application store and the backend observation handle.
 */
async function startModelPane(
  runtime: RuntimeArrangement = TWO_MODELS,
  options: ModelPaneArrangement = {}
) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    ...(options.extra ? buildExtraInventoryRoutes(options.extra) : {}),
    ...options.routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "model",
    runtime
  )
  const { settings, providerModels } = useLysStore.getState()
  const { extra } = options
  const enabled: LlmProvider[] = extra
    ? ["lmStudio", extra.provider]
    : ["lmStudio"]
  const arranged = {
    ...settings,
    providers: { ...settings.providers, enabled },
    secrets: { ...settings.secrets, groqApiKey: STORED_GROQ_API_KEY }
  }
  useLysStore.setState({
    settings: options.change ? options.change(arranged) : arranged,
    providerModels: extra
      ? updateProviderModelState(providerModels, extra.provider, extra.state)
      : providerModels
  })
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByText("Default for this session")
  await waitForRenderedWork()
  return { useLysStore, backend, user: userEvent.setup() }
}

/**
 * Lists the visible text of every row of one group of the model list.
 *
 * @param name - Name of the group's list.
 * @returns Each row button's text.
 */
function listRowTexts(name: string): string[] {
  return within(screen.getByRole("list", { name }))
    .getAllByRole("button")
    .map((row) => row.textContent ?? "")
}

/**
 * Builds a settings change that makes one model the session's default.
 *
 * @param provider - Provider of the model.
 * @param modelKey - Key of the model.
 * @returns The change.
 */
function buildDefaultModelChange(
  provider: LlmProvider,
  modelKey: string
): (settings: LysSettings) => LysSettings {
  return (settings) => ({
    ...settings,
    runtime: { ...settings.runtime, defaultModel: { provider, modelKey } }
  })
}

/**
 * Renders the Models pane on Groq, whose one model is the default.
 *
 * @param routes - Routes the case adds.
 * @returns The store, the backend handle, and the user-event session.
 */
async function startGroqPane(routes: BackendRoutes = {}) {
  return await startModelPane(TWO_MODELS, {
    extra: { provider: "groq", state: GROQ_MODELS },
    change: buildDefaultModelChange("groq", "llama-3.3-70b"),
    routes
  })
}

/**
 * Renders the Models pane on Ollama Cloud, with a saved key and its one
 * model as the default.
 *
 * @param routes - Routes the case adds.
 * @returns The store, the backend handle, and the user-event session.
 */
async function startOllamaCloudPane(routes: BackendRoutes = {}) {
  const makeDefault = buildDefaultModelChange("ollamaCloud", "kimi-k2")
  return await startModelPane(TWO_MODELS, {
    extra: { provider: "ollamaCloud", state: OLLAMA_CLOUD_MODELS },
    change: (settings) =>
      makeDefault({
        ...settings,
        secrets: { ...settings.secrets, ollamaApiKey: STORED_OLLAMA_API_KEY }
      }),
    routes
  })
}

/**
 * Fixes the clock the pane reads its times from.
 *
 * @param time - Time the clock reads for the rest of the case.
 */
function fixClock(time: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(time)
}

/**
 * Builds an LM Studio inventory route that reports `google/gemma-3:4b`
 * loaded once the case says it is.
 *
 * @param isGemmaLoaded - Reads whether the model is loaded now.
 * @returns The route.
 */
function buildGemmaInventoryRoute(isGemmaLoaded: () => boolean) {
  return () =>
    buildJsonResponse(200, {
      llms: [
        buildLlmInfo("qwen3-8b", { loaded: true }),
        buildLlmInfo("google/gemma-3:4b", { loaded: isGemmaLoaded() })
      ],
      modelLoading: "lys"
    })
}

describe("ModelPaneContent", () => {
  it("shows the default, LM Studio's status, its models grouped by whether they are loaded, and the default's details", async () => {
    await startModelPane()

    expect(screen.getByText("Default for this session")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "qwen3-8b" })).toHaveAttribute(
      "title",
      "Show its details"
    )
    expect(screen.getByText("LM Studio · 8k context")).toBeInTheDocument()
    expect(screen.getByText("Running · 1 of 2 loaded")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { level: 3, name: "All models · 2" })
    ).toBeInTheDocument()
    expect(listRowTexts("Loaded · 1")).toEqual(["qwen3-8bDefault4.0 GB"])
    expect(listRowTexts("On disk · 1")).toEqual(["google/gemma-3:4b4.0 GB"])
    expect(
      screen.getByRole("heading", { level: 3, name: "qwen3-8b" })
    ).toBeInTheDocument()
    expect(screen.getByText("Loaded")).toBeInTheDocument()
    expect(
      screen.getByText(
        "It’s the default for this session. Choose another default before unloading it."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()
    expect(
      screen.getByText("Default for new conversations")
    ).toBeInTheDocument()
  })

  it("lists the facts of an LM Studio model", async () => {
    await startModelPane()

    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(
      ["Size", "Format", "Runs on"]
    )
    expect(
      screen.getAllByRole("definition").map((value) => value.textContent)
    ).toEqual(["4.0 GB", "GGUF", "This machine"])
  })

  it("shows a pressed row's model, offering Load and Load and set as default for a model on disk", async () => {
    const { useLysStore, user } = await startModelPane()

    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))

    expect(useLysStore.getState().modelPaneSelection).toEqual({
      provider: "lmStudio",
      modelKey: "google/gemma-3:4b"
    })
    expect(
      screen.getByRole("button", { name: /^google\/gemma-3/ })
    ).toHaveAttribute("aria-current", "true")
    expect(screen.getByText("Not loaded")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Load and set as default" })
    ).toBeEnabled()
    expect(
      screen.getByText(
        "Only loaded models can answer. Load it to make it the default."
      )
    ).toBeInTheDocument()
  })

  it("loads a model and makes it the default once it is listed as loaded", async () => {
    let isGemmaLoaded = false
    const { useLysStore, backend, user } = await startModelPane(TWO_MODELS, {
      routes: {
        [LOAD_ROUTE]: () => {
          isGemmaLoaded = true
          return buildJsonResponse(
            200,
            buildLlmInfo("google/gemma-3:4b", { loaded: true })
          )
        },
        [INVENTORY_ROUTE]: buildGemmaInventoryRoute(() => isGemmaLoaded)
      }
    })
    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))

    await user.click(
      screen.getByRole("button", { name: "Load and set as default" })
    )
    await waitForRenderedWork()

    expect(listRouteKeys(backend)).toContain(LOAD_ROUTE)
    expect(useLysStore.getState().settings.runtime.defaultModel).toEqual({
      provider: "lmStudio",
      modelKey: "google/gemma-3:4b"
    })
    expect(
      screen.getByText("Default for new conversations")
    ).toBeInTheDocument()
  })

  it("makes a loaded model the default for this session, and moves focus to the mark that replaces the button", async () => {
    const { useLysStore, user } = await startModelPane({
      ...TWO_MODELS,
      defaultModel: null
    })
    await user.click(screen.getByRole("button", { name: /^qwen3-8b/ }))

    await user.click(screen.getByRole("button", { name: "Set as default" }))

    expect(useLysStore.getState().settings.runtime.defaultModel).toEqual({
      provider: "lmStudio",
      modelKey: "qwen3-8b"
    })
    expect(screen.getByText("Default for new conversations")).toHaveFocus()
  })

  it("asks to choose a model while none is selected and there is no default", async () => {
    await startModelPane({ ...TWO_MODELS, defaultModel: null })

    expect(screen.getByText("None chosen yet.")).toBeInTheDocument()
    expect(
      screen.getByText("Choose a model to see its status and load settings.")
    ).toBeInTheDocument()
  })

  it("selects the default model when its key is pressed", async () => {
    const { useLysStore, user } = await startModelPane()
    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))

    await user.click(screen.getByRole("button", { name: "qwen3-8b" }))

    expect(useLysStore.getState().modelPaneSelection).toEqual({
      provider: "lmStudio",
      modelKey: "qwen3-8b"
    })
  })

  it("filters the list by name, and clears a filter that matches nothing", async () => {
    const { user } = await startModelPane()
    const filter = screen.getByRole("searchbox", { name: "Filter models" })

    await user.type(filter, "gemma")

    expect(
      screen.getByRole("heading", { level: 3, name: "Showing 1 of 2" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Loaded · 1" })).toBeNull()

    await user.type(filter, "zzz")

    expect(
      screen.getByText("No model matches “gemmazzz”.", {
        selector: "p:not([role])"
      })
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear filter" }))

    expect(filter).toHaveValue("")
    expect(
      screen.getByRole("heading", { level: 3, name: "All models · 2" })
    ).toBeInTheDocument()
  })

  it("announces each filter result through one status region that exists before the first change", async () => {
    const { user } = await startModelPane()
    const results = screen.getByRole("status", { name: "Filter results" })
    const before = results.textContent

    await user.type(
      screen.getByRole("searchbox", { name: "Filter models" }),
      "gemma"
    )
    const afterMatch = results.textContent
    await user.type(
      screen.getByRole("searchbox", { name: "Filter models" }),
      "zzz"
    )

    expect([before, afterMatch, results.textContent]).toEqual([
      "All models · 2",
      "Showing 1 of 2",
      "No model matches “gemmazzz”."
    ])
    expect(screen.getByRole("status", { name: "Filter results" })).toBe(results)
  })

  it("saves a load setting change, says a reload applies it, and undoes it", async () => {
    const { useLysStore, user } = await startModelPane()
    const flash = screen.getByRole("switch", { name: "Flash attention" })

    await user.click(flash)

    expect(
      useLysStore.getState().settings.loadConfiguration.models.get("qwen3-8b")
    ).toMatchObject({ flashAttention: false })
    const changes = screen.getByRole("status", {
      name: "Load settings changes"
    })
    expect(changes).toHaveTextContent("Saved. Reload qwen3-8b to apply it.")
    expect(
      within(changes).getByRole("button", { name: "Reload" })
    ).toBeEnabled()

    await user.click(within(changes).getByRole("button", { name: "Undo" }))

    expect(flash).toBeChecked()
    expect(changes).toBeEmptyDOMElement()
    expect(changes).toHaveFocus()
  })

  it("moves focus to the changes region when Reload is pressed, and hides the note while the model reloads", async () => {
    const unload = createControlledRoute()
    const { user } = await startModelPane(TWO_MODELS, {
      routes: { [UNLOAD_ROUTE]: unload.route }
    })
    await user.click(screen.getByRole("switch", { name: "Flash attention" }))
    const changes = screen.getByRole("status", {
      name: "Load settings changes"
    })

    await user.click(within(changes).getByRole("button", { name: "Reload" }))

    expect(changes).toHaveFocus()
    expect(changes).toBeEmptyDOMElement()
    expect(screen.getByText("Unloading…")).toBeInTheDocument()
  })

  it("keeps a typed batch size outside 1 to 8,192 out of the settings, saving each accepted one", async () => {
    const { useLysStore, user } = await startModelPane()
    const batch = screen.getByRole("spinbutton", {
      name: "Evaluation batch size"
    })

    await user.clear(batch)
    await user.type(batch, "9000")

    expect(batch).toHaveAttribute("aria-invalid", "true")
    expect(batch).toHaveAccessibleDescription(
      "Enter a whole number from 1 to 8,192."
    )
    expect(
      useLysStore.getState().settings.loadConfiguration.models.get("qwen3-8b")
        ?.evalBatchSize
    ).toBe(900)

    await user.clear(batch)
    await user.type(batch, "1024")

    expect(batch).toHaveAttribute("aria-invalid", "false")
    expect(
      useLysStore.getState().settings.loadConfiguration.models.get("qwen3-8b")
        ?.evalBatchSize
    ).toBe(1024)
  })

  it("shows a Groq model as available, with its context, and checks it without generating a reply", async () => {
    fixClock(new Date(2026, 10, 13, 9, 5))
    const { backend, user } = await startGroqPane({
      "GET /api/v1/llm/groq/llama-3.3-70b/health": () =>
        buildJsonResponse(200, {
          status: "ready",
          modelId: "llama-3.3-70b",
          latencyMs: 40
        })
    })

    expect(screen.getByText("Connected · 1 model")).toBeInTheDocument()
    expect(screen.getByText("Available")).toBeInTheDocument()
    expect(screen.getByText("Hosted by Groq")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { level: 4, name: "Context" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("131,072 tokens", { selector: "dd" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Check status" }))
    await waitForRenderedWork()

    expect(listRouteKeys(backend)).toContain(
      "GET /api/v1/llm/groq/llama-3.3-70b/health"
    )
    expect(
      screen.getByText("Checked at 09:05. Groq still offers it to your key.")
    ).toBeInTheDocument()
  })

  it("says the model is being checked while Groq is asked", async () => {
    const health = createControlledRoute()
    const { user } = await startGroqPane({
      "GET /api/v1/llm/groq/llama-3.3-70b/health": health.route
    })

    await user.click(screen.getByRole("button", { name: "Check status" }))

    expect(screen.getByText("Checking…")).toBeInTheDocument()
    expect(screen.getByText("Asking Groq…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled()
  })

  it("says a failed check could not ask Groq, and offers to try again", async () => {
    const { user } = await startGroqPane({
      "GET /api/v1/llm/groq/llama-3.3-70b/health": () =>
        new Response(null, { status: 500 }),
      "GET /api/v1/llm/groq/runtime": () =>
        buildJsonResponse(200, { status: "connected" })
    })

    await user.click(screen.getByRole("button", { name: "Check status" }))
    await waitForRenderedWork()

    expect(screen.getByText("Couldn’t check")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Groq didn’t answer. The last known state was available."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
  })

  it("shows Ollama's load and unload, and its load settings, disabled with why", async () => {
    await startModelPane(TWO_MODELS, {
      extra: { provider: "ollama", state: OLLAMA_MODELS },
      change: (settings) => ({
        ...settings,
        runtime: {
          ...settings.runtime,
          defaultModel: { provider: "ollama", modelKey: "llama3.2:3b" }
        }
      })
    })

    expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Unload" })
    ).toHaveAccessibleDescription(
      "Ollama unloads it when it sits idle. Lys can’t unload Ollama models yet."
    )
    expect(
      screen.getByRole("slider", { hidden: true, name: "Context length" })
    ).toBeDisabled()
    expect(
      screen.getByRole("combobox", { name: "Unload when idle" })
    ).toBeDisabled()
    expect(
      screen.getByText(
        "Ollama applies its own load settings. Lys can’t change them yet."
      )
    ).toBeInTheDocument()
  })

  it("shows the provider the picker chose, with no model selected", async () => {
    const { useLysStore, user } = await startModelPane(TWO_MODELS, {
      extra: { provider: "groq", state: GROQ_MODELS }
    })

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: /^LM Studio/ })
    )
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Groq/ })
    )
    await waitForRenderedWork()

    expect(useLysStore.getState().modelPaneProvider).toBe("groq")
    expect(screen.getByRole("button", { name: /^Groq/ })).toBeInTheDocument()
    expect(listRowTexts("Models")).toEqual(["llama-3.3-70b128k"])
    expect(
      screen.getByText("Choose a model to see its status and load settings.")
    ).toBeInTheDocument()
  })

  it("says LM Studio isn't running and asks the backend to connect again on Refresh", async () => {
    const { backend, user } = await startModelPane(
      buildUnreachableRuntime("running", "unreachable"),
      {
        routes: {
          "POST /api/v1/llm/lmStudio/runtime/connect": () =>
            buildJsonResponse(200, { status: "unreachable" })
        }
      }
    )

    expect(
      screen.getByText("LM Studio isn’t running on this machine.")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Start its local server, then refresh. Its models show here once it answers at 127.0.0.1:1234."
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await waitForRenderedWork()

    expect(listRouteKeys(backend)).toEqual([
      "POST /api/v1/llm/lmStudio/runtime/connect"
    ])
  })

  it("opens the Runtime pane from the notice while the backend is not running", async () => {
    const { useLysStore, user } = await startModelPane(
      buildUnreachableRuntime("stopped")
    )

    expect(screen.getByText("The backend isn’t running.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()

    await user.click(screen.getByRole("button", { name: "Open Runtime" }))

    expect(useLysStore.getState().settingsPane).toBe("runtime")
  })

  it("asks for a key in Providers while Groq has none", async () => {
    const { useLysStore, user } = await startModelPane(TWO_MODELS, {
      extra: {
        provider: "groq",
        state: { status: "unreachable" }
      },
      change: (settings) => ({
        ...settings,
        secrets: { ...settings.secrets, groqApiKey: null },
        runtime: {
          ...settings.runtime,
          defaultModel: { provider: "groq", modelKey: "llama-3.3-70b" }
        }
      })
    })

    expect(screen.getByText("Groq needs a key.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open Providers" }))

    expect(useLysStore.getState().settingsPane).toBe("providers")
  })

  it("reports when LM Studio was last read, beside Refresh", async () => {
    fixClock(new Date(2026, 10, 13, 14, 7))
    await startModelPane()

    expect(screen.getByText("Refreshed at 14:07")).toBeInTheDocument()
  })

  it("shows an Ollama Cloud model as available, its context as Ollama Cloud's own, and nothing to load", async () => {
    await startOllamaCloudPane()

    expect(
      screen.getByText(
        "Ollama Cloud runs its models and decides which stay in memory. A model answers when a message names it, so there is nothing to load."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("Available")).toBeInTheDocument()
    expect(
      screen.getByText("Ollama Cloud runs it when a message names it")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("slider", { hidden: true, name: "Context length" })
    ).toBeDisabled()
    expect(
      screen.getByText(
        "Ollama Cloud applies its own load settings. Lys can’t change them yet."
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull()
    expect(
      screen.queryByRole("combobox", { name: "Unload when idle" })
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled()
  })

  it("says Ollama Cloud no longer offers a model when its check finds it not offered", async () => {
    fixClock(new Date(2026, 10, 13, 9, 5))
    const { user } = await startOllamaCloudPane({
      "GET /api/v1/llm/ollamaCloud/kimi-k2/health": () =>
        buildJsonResponse(200, {
          status: "not-ready",
          modelId: "kimi-k2",
          reason: "model-not-loaded",
          latencyMs: 40
        }),
      "GET /api/v1/llm/ollamaCloud/runtime": () =>
        buildJsonResponse(200, { status: "connected" })
    })

    await user.click(screen.getByRole("button", { name: "Check status" }))
    await waitForRenderedWork()

    expect(screen.getByText("Not available")).toBeInTheDocument()
    expect(
      screen.getByText("Not offered to your key on Ollama Cloud")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Checked at 09:05. Ollama Cloud doesn’t offer it to your key now."
      )
    ).toBeInTheDocument()
  })

  it("says it is reading LM Studio's models, and asking it, while the list request runs", async () => {
    const inventory = createControlledRoute()
    await startModelPane(
      { ...TWO_MODELS, modelInventory: { status: "unavailable" } },
      { routes: { [INVENTORY_ROUTE]: inventory.route } }
    )

    expect(
      screen.getByText("Reading models from LM Studio…")
    ).toBeInTheDocument()
    expect(screen.getByText("Asking LM Studio…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled()

    inventory.responses[0]?.resolve(
      buildJsonResponse(200, {
        llms: [buildLlmInfo("google/gemma-3:4b")],
        modelLoading: "lys"
      })
    )
    await waitForRenderedWork()

    expect(listRowTexts("On disk · 1")).toEqual(["google/gemma-3:4b4.0 GB"])
    expect(
      screen.getByText("Refreshed at", { exact: false })
    ).toBeInTheDocument()
  })

  it.each<[string, InventoryNoticeCase]>([
    [
      "failed",
      {
        modelInventory: { status: "failed" },
        title: "Couldn’t list LM Studio’s models.",
        body: "Refresh to try again."
      }
    ],
    [
      "empty",
      {
        modelInventory: { status: "ready", modelLoading: "lys", models: [] },
        title: "LM Studio lists no models.",
        body: "Download a model in LM Studio, then refresh."
      }
    ]
  ])(
    "says why no model is listed when the inventory read is %s",
    async (_label, { modelInventory, title, body }) => {
      await startModelPane(
        { ...TWO_MODELS, modelInventory },
        {
          routes: {
            "GET /api/v1/llm/lmStudio/runtime": () =>
              buildJsonResponse(200, { status: "connected" })
          }
        }
      )

      expect(screen.getByText(title)).toBeInTheDocument()
      expect(screen.getByText(body)).toBeInTheDocument()
      expect(screen.queryByRole("list", { name: /^Loaded/ })).toBeNull()
    }
  )

  it("says the pane is connecting to Groq while it connects", async () => {
    await startModelPane(TWO_MODELS, {
      extra: { provider: "groq", state: { status: "connecting" } },
      change: buildDefaultModelChange("groq", "llama-3.3-70b")
    })

    expect(screen.getByText("Connecting to Groq…")).toBeInTheDocument()
    expect(screen.getByText("Connecting…")).toBeInTheDocument()
  })

  it("says Groq can't be reached, and opens Providers to check its key", async () => {
    const { useLysStore, user } = await startModelPane(TWO_MODELS, {
      extra: { provider: "groq", state: { status: "unreachable" } },
      change: buildDefaultModelChange("groq", "llama-3.3-70b")
    })

    expect(screen.getByText("Groq can’t be reached.")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Check its key in Providers and your network, then refresh."
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open Providers" }))

    expect(useLysStore.getState().settingsPane).toBe("providers")
  })

  it("asks to turn a provider on while none is", async () => {
    const { useLysStore, user } = await startModelPane(TWO_MODELS, {
      change: (settings) => ({
        ...settings,
        providers: { ...settings.providers, enabled: [] }
      })
    })

    expect(screen.getByText("No provider is on.")).toBeInTheDocument()
    expect(
      screen.getByText("Turn one on in Providers to see its models.")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open Providers" }))

    expect(useLysStore.getState().settingsPane).toBe("providers")
  })

  it("shows a default whose provider is off as plain text, and says the provider is off", async () => {
    await startModelPane(TWO_MODELS, {
      change: buildDefaultModelChange("groq", "llama-3.3-70b")
    })

    expect(screen.getByText("llama-3.3-70b")).not.toHaveRole("button")
    expect(screen.queryByRole("button", { name: "llama-3.3-70b" })).toBeNull()
    expect(screen.getByText("Groq is off")).toBeInTheDocument()
    expect(listRowTexts("Loaded · 1")).toEqual(["qwen3-8b4.0 GB"])
  })

  it("lists cloud providers before the ones on this machine in the picker", async () => {
    const { user } = await startModelPane(TWO_MODELS, {
      extra: { provider: "groq", state: GROQ_MODELS }
    })

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: /^LM Studio/ })
    )
    const menu = await screen.findByRole("menu")
    const cloud = within(menu).getByRole("group", { name: "Cloud" })
    const local = within(menu).getByRole("group", { name: "On this machine" })

    expect(
      cloud.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(within(cloud).getAllByRole("menuitemradio")).toEqual([
      within(cloud).getByRole("menuitemradio", { name: /^Groq/ })
    ])
    expect(within(local).getAllByRole("menuitemradio")).toEqual([
      within(local).getByRole("menuitemradio", { name: /^LM Studio/ })
    ])
  })

  it("unloads a model that is not the default, keeping focus on the button while it says Unloading…", async () => {
    const unload = createControlledRoute()
    let isQwenLoaded = true
    const { user } = await startModelPane(
      { ...TWO_MODELS, defaultModel: null },
      {
        routes: {
          [UNLOAD_ROUTE]: unload.route,
          [INVENTORY_ROUTE]: () =>
            buildJsonResponse(200, {
              llms: [buildLlmInfo("qwen3-8b", { loaded: isQwenLoaded })],
              modelLoading: "lys"
            })
        }
      }
    )
    await user.click(screen.getByRole("button", { name: /^qwen3-8b/ }))
    const action = screen.getByRole("button", { name: "Unload" })
    expect(action).toHaveAccessibleDescription(
      "Unloading frees its memory. It can’t answer until you load it again."
    )

    await user.click(action)

    expect(screen.getByText("Unloading…")).toBeInTheDocument()
    expect(screen.getByText("Out of this machine’s memory")).toBeInTheDocument()
    expect(action).toBeDisabled()
    expect(action).toHaveFocus()
    expect(
      screen.getByRole("button", { name: "Set as default" })
    ).toBeDisabled()

    isQwenLoaded = false
    unload.responses[0]?.resolve(new Response(null, { status: 204 }))
    await waitForRenderedWork()

    expect(action).toHaveTextContent("Load")
    expect(action).toHaveFocus()
  })

  it("loads a model, keeping focus on the button while it says Loading…", async () => {
    const load = createControlledRoute()
    let isGemmaLoaded = false
    const { user } = await startModelPane(TWO_MODELS, {
      routes: {
        [LOAD_ROUTE]: load.route,
        [INVENTORY_ROUTE]: buildGemmaInventoryRoute(() => isGemmaLoaded)
      }
    })
    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))
    const action = screen.getByRole("button", { name: "Load" })

    await user.click(action)

    expect(listRowTexts("On disk · 1")).toEqual([
      "google/gemma-3:4bLoading…4.0 GB"
    ])
    expect(screen.getByText("Into this machine’s memory")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled()
    expect(
      screen.getByRole("progressbar", { name: "Loading google/gemma-3:4b" })
    ).toBeInTheDocument()
    expect(action).toHaveFocus()

    isGemmaLoaded = true
    load.responses[0]?.resolve(
      buildJsonResponse(
        200,
        buildLlmInfo("google/gemma-3:4b", { loaded: true })
      )
    )
    await waitForRenderedWork()

    expect(action).toHaveTextContent("Unload")
    expect(action).toHaveFocus()
  })

  it("offers no Load for an Ollama model on disk, and says why", async () => {
    const { user } = await startModelPane(TWO_MODELS, {
      extra: { provider: "ollama", state: OLLAMA_MODELS },
      change: buildDefaultModelChange("ollama", "llama3.2:3b")
    })

    await user.click(screen.getByRole("button", { name: /^mistral/ }))

    expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Load" })
    ).toHaveAccessibleDescription(
      "Start it in Ollama to use it. Lys can’t load Ollama models yet."
    )
  })

  it("keeps the default and shows the failure when Load and set as default fails", async () => {
    const { useLysStore, user } = await startModelPane(TWO_MODELS, {
      routes: {
        [LOAD_ROUTE]: () => new Response(null, { status: 500 }),
        "GET /api/v1/llm/lmStudio/runtime": () =>
          buildJsonResponse(200, { status: "connected" })
      }
    })
    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))

    await user.click(
      screen.getByRole("button", { name: "Load and set as default" })
    )
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.runtime.defaultModel).toEqual({
      provider: "lmStudio",
      modelKey: "qwen3-8b"
    })
    expect(screen.getByRole("alert")).not.toBeEmptyDOMElement()
    expect(
      screen.getByRole("button", { name: "Load and set as default" })
    ).toBeEnabled()
  })

  it("keeps a default chosen while Load and set as default ran, once the load finishes", async () => {
    const load = createControlledRoute()
    let isGemmaLoaded = false
    const { useLysStore, user } = await startModelPane(
      { ...TWO_MODELS, defaultModel: null },
      {
        routes: {
          [LOAD_ROUTE]: load.route,
          [INVENTORY_ROUTE]: buildGemmaInventoryRoute(() => isGemmaLoaded)
        }
      }
    )
    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))
    await user.click(
      screen.getByRole("button", { name: "Load and set as default" })
    )
    await user.click(screen.getByRole("button", { name: /^qwen3-8b/ }))
    await user.click(screen.getByRole("button", { name: "Set as default" }))

    isGemmaLoaded = true
    load.responses[0]?.resolve(
      buildJsonResponse(
        200,
        buildLlmInfo("google/gemma-3:4b", { loaded: true })
      )
    )
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.runtime.defaultModel).toEqual({
      provider: "lmStudio",
      modelKey: "qwen3-8b"
    })
  })
})
