import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { BackendServerStatus } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type { ModelInventoryState } from "@/lib/store/model-runtime"
import { startBackendFake } from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  buildUnreachableRuntime,
  READY_RUNTIME
} from "../../support/runtimeFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import { waitForMicrotasks } from "../../support/settlement"

/** Rail entries as their tabs are named, in order. */
const RAIL_TABS = [
  "Runtime01",
  "Model02",
  "Generation03",
  "Agents04",
  "Tools05"
]

/**
 * Gets one rail tab.
 *
 * @param label - Pane label.
 * @param ordinal - Two-digit ordinal after the label.
 * @returns The tab.
 * @remarks With the view's styles applied, the label and ordinal are separate
 * blocks, so the name has a space between them, as a browser computes it.
 */
function getRailTab(label: string, ordinal: string): HTMLElement {
  return screen.getByRole("tab", {
    name: new RegExp(`^${label}\\s*${ordinal}$`)
  })
}

/**
 * Lets pending requests and store updates settle inside a React update scope.
 */
async function waitForRenderedWork(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
}

describe("SettingsView", () => {
  it("is the Settings landmark with a rail of every pane, the selected one shown", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("generation")

    render(<SettingsView onDone={vi.fn()} />)

    const settings = screen.getByRole("main", { name: "Settings" })
    const rail = within(settings).getByRole("tablist", {
      name: "Settings sections"
    })
    expect(
      within(rail)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(RAIL_TABS)
    expect(getRailTab("Generation", "03")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(
      screen.getByRole("heading", { level: 1, name: "Generation" })
    ).toBeInTheDocument()
    await waitForRenderedWork()
  })

  it("keeps the heading and Done while a pane loads, then shows it with its closing note", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("generation")

    render(<SettingsView onDone={vi.fn()} />)

    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading generation settings"
    )
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
    expect(
      await screen.findByText(
        "Saved automatically for future messages, including after restarting Lys. Messages already sent are unchanged."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("Reading generation settings")).toBeNull()
  })

  it("selects a pane from the rail as the application's pane", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { useLysStore, SettingsView } = await loadFreshSettingsView("runtime")
    const user = userEvent.setup()
    render(<SettingsView onDone={vi.fn()} />)

    await user.click(getRailTab("Model", "02"))

    expect(useLysStore.getState().settingsPane).toBe("model")
    expect(
      screen.getByRole("heading", { level: 1, name: "Model" })
    ).toBeInTheDocument()
    await waitForRenderedWork()
  })

  it("moves through the rail with the arrow keys and selects with Enter", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { useLysStore, SettingsView } = await loadFreshSettingsView("runtime")
    const user = userEvent.setup()
    render(<SettingsView onDone={vi.fn()} />)
    getRailTab("Runtime", "01").focus()

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")

    expect(getRailTab("Generation", "03")).toHaveFocus()
    expect(useLysStore.getState().settingsPane).toBe("generation")
    await waitForRenderedWork()
  })

  it("leaves once per press of Done", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("runtime")
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView onDone={onDone} />)

    await user.click(screen.getByRole("button", { name: "Done" }))

    expect(onDone).toHaveBeenCalledOnce()
    await waitForRenderedWork()
  })

  it.each<
    [string, BackendServerStatus, LmStudioStatus, ModelInventoryState, string]
  >([
    [
      "a stopped backend",
      "stopped",
      "unknown",
      { status: "unavailable" },
      "backend stopped"
    ],
    [
      "a starting backend",
      "starting",
      "unknown",
      { status: "unavailable" },
      "backend starting"
    ],
    [
      "a stopping backend",
      "stopping",
      "connected",
      { status: "unavailable" },
      "backend stopping"
    ],
    [
      "an unresponsive backend",
      "unresponsive",
      "unknown",
      { status: "unavailable" },
      "backend not responding"
    ],
    [
      "LM Studio in an unknown state",
      "running",
      "unknown",
      { status: "unavailable" },
      "backend up · LM Studio status unknown"
    ],
    [
      "LM Studio connecting",
      "running",
      "connecting",
      { status: "unavailable" },
      "backend up · connecting to LM Studio"
    ],
    [
      "LM Studio unreachable",
      "running",
      "unreachable",
      { status: "unavailable" },
      "backend up · LM Studio not reachable"
    ],
    [
      "loaded weights",
      "running",
      "connected",
      READY_RUNTIME.modelInventory,
      "backend up · model loaded"
    ],
    [
      "no loaded weights",
      "running",
      "connected",
      { status: "ready", models: [buildLlmInfo("qwen3-8b")] },
      "backend up · no model"
    ],
    [
      "an unreadable inventory",
      "running",
      "connected",
      { status: "failed" },
      "backend up · model state unavailable"
    ]
  ])(
    "summarizes %s at the foot of the rail",
    async (_case, backendStatus, lmStudioStatus, modelInventory, summary) => {
      const runtime = {
        ...READY_RUNTIME,
        backendStatus,
        lmStudioStatus,
        modelInventory
      }
      startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute(runtime) })
      const { SettingsView } = await loadFreshSettingsView(
        "generation",
        runtime
      )

      render(<SettingsView onDone={vi.fn()} />)

      expect(
        screen.getByRole("tablist", { name: "Settings sections" })
      ).toHaveTextContent(new RegExp(`${summary}$`))
      await waitForRenderedWork()
    }
  )

  it("reads the model inventory when shown with a running backend", async () => {
    const backend = startBackendFake({
      [INVENTORY_ROUTE]: buildInventoryRoute()
    })
    const { SettingsView } = await loadFreshSettingsView("generation")

    render(<SettingsView onDone={vi.fn()} />)
    await waitForRenderedWork()

    expect(backend.requests.map((request) => request.method)).toEqual(["GET"])
    expect(new URL(backend.requests[0]?.url ?? "").pathname).toBe(
      "/api/v1/llm/list"
    )
  })

  it("reads no inventory while the backend is not running", async () => {
    const backend = startBackendFake({})
    const { SettingsView } = await loadFreshSettingsView(
      "generation",
      buildUnreachableRuntime("stopped")
    )

    render(<SettingsView onDone={vi.fn()} />)
    await waitForRenderedWork()

    expect(backend.requests).toEqual([])
  })
})
