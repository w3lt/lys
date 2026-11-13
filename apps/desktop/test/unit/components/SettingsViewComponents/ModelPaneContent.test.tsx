import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { LlmProvider } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  updateProviderModelState,
  type ProviderModelState
} from "@/lib/store/model-runtime"
import type { LysSettings } from "@/lib/store/settings"
import {
  buildJsonResponse,
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

/** Another provider the pane shows beside LM Studio, with its routes. */
type ExtraProvider = {
  /** The provider, turned on in the settings. */
  readonly provider: Exclude<LlmProvider, "lmStudio">
  /** Its status and models. */
  readonly state: Partial<ProviderModelState>
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
 * Renders the settings view on the Model pane with LM Studio, and another
 * provider when given, and waits for the pane's body to settle.
 *
 * @param runtime - Backend, LM Studio, and default model facts.
 * @param options - Extra routes, another provider, and settings changes.
 * @returns The application store and the backend observation handle.
 */
async function startModelPane(
  runtime: RuntimeArrangement = TWO_MODELS,
  options: {
    readonly routes?: BackendRoutes
    readonly extra?: ExtraProvider
    readonly change?: (settings: LysSettings) => LysSettings
  } = {}
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
    expect(screen.getByText("All models · 2")).toBeInTheDocument()
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
        "POST /api/v1/llm/lmStudio/load": () => {
          isGemmaLoaded = true
          return buildJsonResponse(
            200,
            buildLlmInfo("google/gemma-3:4b", { loaded: true })
          )
        },
        [INVENTORY_ROUTE]: () =>
          buildJsonResponse(200, {
            llms: [
              buildLlmInfo("qwen3-8b", { loaded: true }),
              buildLlmInfo("google/gemma-3:4b", { loaded: isGemmaLoaded })
            ],
            modelLoading: "lys"
          })
      }
    })
    await user.click(screen.getByRole("button", { name: /^google\/gemma-3/ }))

    await user.click(
      screen.getByRole("button", { name: "Load and set as default" })
    )
    await waitForRenderedWork()

    expect(listRouteKeys(backend)).toContain("POST /api/v1/llm/lmStudio/load")
    expect(useLysStore.getState().settings.runtime.defaultModel).toEqual({
      provider: "lmStudio",
      modelKey: "google/gemma-3:4b"
    })
    expect(
      screen.getByText("Default for new conversations")
    ).toBeInTheDocument()
  })

  it("makes a loaded model the default for this session", async () => {
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

    expect(screen.getByText("Showing 1 of 2")).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Loaded · 1" })).toBeNull()

    await user.type(filter, "zzz")

    expect(screen.getByText("No model matches “gemmazzz”.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear filter" }))

    expect(filter).toHaveValue("")
    expect(screen.getByText("All models · 2")).toBeInTheDocument()
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
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(new Date(2026, 10, 13, 9, 5))
    const { backend, user } = await startModelPane(TWO_MODELS, {
      extra: { provider: "groq", state: GROQ_MODELS },
      change: (settings) => ({
        ...settings,
        runtime: {
          ...settings.runtime,
          defaultModel: { provider: "groq", modelKey: "llama-3.3-70b" }
        }
      }),
      routes: {
        "GET /api/v1/llm/groq/llama-3.3-70b/health": () =>
          buildJsonResponse(200, {
            status: "ready",
            modelId: "llama-3.3-70b",
            latencyMs: 40
          })
      }
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
    expect(screen.getByText("Checked at 09:05. Available.")).toBeInTheDocument()
  })

  it("says a failed check could not ask Groq, and offers to try again", async () => {
    const { user } = await startModelPane(TWO_MODELS, {
      extra: { provider: "groq", state: GROQ_MODELS },
      change: (settings) => ({
        ...settings,
        runtime: {
          ...settings.runtime,
          defaultModel: { provider: "groq", modelKey: "llama-3.3-70b" }
        }
      }),
      routes: {
        "GET /api/v1/llm/groq/llama-3.3-70b/health": () =>
          new Response(null, { status: 500 }),
        "GET /api/v1/llm/groq/runtime": () =>
          buildJsonResponse(200, { status: "connected" })
      }
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
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(new Date(2026, 10, 13, 14, 7))
    await startModelPane()

    expect(screen.getByText("Refreshed at 14:07")).toBeInTheDocument()
  })
})
