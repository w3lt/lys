import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { LM_STUDIO_UNREACHABLE_MESSAGE } from "@/lib/models/lm-studio-connection"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute,
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
import { createControlledPromise } from "../../support/settlement"
import { startHover, waitForRenderedWork } from "../../support/rendering"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

/** One resident model chosen as default, and one on disk. */
const TWO_MODELS: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    models: [
      buildLlmInfo("qwen3-8b", { loaded: true }),
      buildLlmInfo("gemma-3")
    ]
  }
}

/**
 * Renders the settings view on the Model pane and waits for the pane.
 *
 * @param runtime - Backend, LM Studio, and model facts.
 * @param routes - Backend routes replacing or adding to the inventory read.
 * @returns The application store and the backend observation handle.
 */
async function startModelPane(
  runtime: RuntimeArrangement = TWO_MODELS,
  routes: BackendRoutes = {}
) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "model",
    runtime
  )
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("heading", { name: "load configuration" })
  await waitForRenderedWork()
  return { useLysStore, backend }
}

/**
 * Gets the pane's Refresh button.
 *
 * @returns The inventory Refresh button.
 */
function getRefreshButton(): HTMLElement {
  return screen.getByRole("button", { name: "Refresh" })
}

describe("ModelPaneContent", () => {
  it("lists the downloaded models, marking the default", async () => {
    await startModelPane()

    const list = screen.getByRole("list", { name: "Downloaded models" })
    const rows = within(list).getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(
      within(rows[0]).getByRole("button", { pressed: true })
    ).toHaveTextContent(/^qwen3-8bdefault/)
    expect(
      within(rows[1]).getByRole("button", { pressed: false })
    ).toHaveTextContent(/^gemma-3/)
  })

  it("makes a row the default for this session without loading it", async () => {
    const { useLysStore, backend } = await startModelPane()
    const user = userEvent.setup()

    await user.click(
      screen.getByRole("button", { name: /^gemma-3/, pressed: false })
    )

    expect(useLysStore.getState().settings.runtime.defaultModel).toBe("gemma-3")
    expect(
      screen.getByRole("button", { name: /^gemma-3/, pressed: true })
    ).toBeInTheDocument()
    expect(backend.requests.map((request) => request.method)).toEqual(["GET"])
  })

  it("loads, unloads, and tests models from their rows", async () => {
    const { backend } = await startModelPane(TWO_MODELS, {
      "POST /api/v1/llm/load": () =>
        buildJsonResponse(200, buildLlmInfo("gemma-3", { loaded: true })),
      "PATCH /api/v1/llm/unload": () => new Response(null, { status: 204 }),
      "GET /api/v1/llm/qwen3-8b/health": () =>
        buildJsonResponse(200, {
          status: "ready",
          modelId: "qwen3-8b",
          latencyMs: 12
        })
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test qwen3-8b" }))
    await waitForRenderedWork()
    expect(
      screen.getByText("qwen3-8b: loaded · health query 12 ms")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Load gemma-3" }))
    await waitForRenderedWork()
    await user.click(screen.getByRole("button", { name: "Unload qwen3-8b" }))
    await waitForRenderedWork()

    expect(
      backend.requests
        .filter((request) => request.method !== "GET")
        .map((request) => [request.method, request.body])
    ).toEqual([
      [
        "POST",
        { modelId: "gemma-3", configuration: FIRST_RUN_LOAD_CONFIGURATION }
      ],
      ["PATCH", { modelId: "qwen3-8b" }]
    ])
  })

  it("refreshes the inventory on request, refusing new actions while it is read", async () => {
    const reads: ReturnType<typeof createControlledPromise<Response>>[] = []
    const controlledInventory: BackendRoute = () => {
      const read = createControlledPromise<Response>()
      reads.push(read)
      return read.promise
    }
    const { backend } = await startModelPane(TWO_MODELS, {
      [INVENTORY_ROUTE]: controlledInventory
    })
    const user = userEvent.setup()
    reads[0]?.resolve(
      buildJsonResponse(200, {
        llms:
          TWO_MODELS.modelInventory.status === "ready"
            ? TWO_MODELS.modelInventory.models
            : []
      })
    )
    await waitForRenderedWork()

    await user.click(getRefreshButton())
    await waitForRenderedWork()

    expect(getRefreshButton()).toBeDisabled()
    expect(screen.getByRole("button", { name: "Load gemma-3" })).toBeDisabled()
    expect(
      screen.getByRole("list", { name: "Downloaded models" })
    ).toHaveAttribute("aria-busy", "true")
    expect(screen.getByText("Refreshing model inventory…")).toBeInTheDocument()
    expect(backend.requests).toHaveLength(2)

    reads[1]?.resolve(
      buildJsonResponse(200, { llms: [buildLlmInfo("llama-4")] })
    )
    await waitForRenderedWork()

    expect(getRefreshButton()).toBeEnabled()
    expect(
      within(screen.getByRole("list", { name: "Downloaded models" }))
        .getAllByRole("listitem")
        .map((row) => within(row).getAllByRole("button")[0].textContent)
    ).toEqual(["llama-47B · Q4_K_M · 4.0 GB4.0 GB on disk"])
  })

  it.each<[string, RuntimeArrangement, string]>([
    [
      "the backend is stopped",
      buildUnreachableRuntime("stopped"),
      "Start the backend to list models."
    ],
    [
      "LM Studio is connecting",
      buildUnreachableRuntime("running", "connecting"),
      "Connecting to LM Studio…"
    ],
    [
      "LM Studio has no downloaded language models",
      { ...TWO_MODELS, modelInventory: { status: "ready", models: [] } },
      "No downloaded language models found in LM Studio."
    ]
  ])("explains an empty list when %s", async (_case, runtime, message) => {
    await startModelPane(runtime)

    expect(screen.queryAllByRole("listitem")).toEqual([])
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it("explains a failed inventory read and offers Refresh", async () => {
    await startModelPane(TWO_MODELS, {
      [INVENTORY_ROUTE]: () => new Response(null, { status: 500 }),
      "GET /api/v1/llm/runtime": () =>
        buildJsonResponse(200, { status: "connected" })
    })

    expect(
      screen.getByText("Model inventory is unavailable. Refresh to try again.")
    ).toBeInTheDocument()
    expect(getRefreshButton()).toBeEnabled()
  })

  it("disables Refresh while LM Studio is not reachable, describing why", async () => {
    await startModelPane(buildUnreachableRuntime("running", "unreachable"))

    expect(getRefreshButton()).toBeDisabled()
    expect(getRefreshButton()).toHaveAccessibleDescription(
      LM_STUDIO_UNREACHABLE_MESSAGE
    )
    expect(screen.getByText(LM_STUDIO_UNREACHABLE_MESSAGE)).toBeInTheDocument()
  })

  it("repeats why Refresh is disabled in a tooltip after 600 ms of hover", async () => {
    await startModelPane(buildUnreachableRuntime("running", "unreachable"))
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })

    // A disabled button receives no pointer events; its tooltip trigger
    // wraps it.
    startHover(getRefreshButton().parentElement ?? getRefreshButton())
    act(() => {
      vi.advanceTimersByTime(599)
    })
    const beforeDelay = screen.getAllByText(LM_STUDIO_UNREACHABLE_MESSAGE)
    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(beforeDelay).toHaveLength(1)
    expect(screen.getAllByText(LM_STUDIO_UNREACHABLE_MESSAGE)).toHaveLength(2)
  })

  it("describes Refresh only while LM Studio is not reachable", async () => {
    await startModelPane()

    expect(getRefreshButton()).toBeEnabled()
    expect(getRefreshButton()).not.toHaveAttribute("aria-describedby")
  })

  it("states that a load configuration is saved per model and applies at load, and that the meters measure against the loaded context length", async () => {
    await startModelPane()

    expect(
      screen.getByText(
        "Model operations use the backend. A load configuration is saved for each model and applies when that model is loaded, not per request. The composer's context meter and the Agents pane measure against the context length the model is loaded with. Default selection lasts for this session."
      )
    ).toBeInTheDocument()
  })
})
