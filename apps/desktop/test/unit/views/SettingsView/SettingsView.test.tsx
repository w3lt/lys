import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { BackendServerStatus } from "@/lib/store"
import type {
  LlmProviderStatus,
  ModelInventoryState
} from "@/lib/store/model-runtime"
import { buildJsonResponse, startBackendFake } from "../../support/backendFake"
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
import { waitForRenderedWork } from "../../support/rendering"

/** Rail entries as their buttons read, in order. */
const RAIL_ENTRIES = [
  "Lys01",
  "Profile02",
  "Runtime03",
  "Models04",
  "Generation05",
  "Agents06",
  "Tools07",
  "MCP08",
  "Providers09",
  "Secrets10"
]

/** A runtime the rail summarizes, and the summary at the rail's foot. */
type RailStatusCase = {
  /** Backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** Latest LM Studio status the backend reported. */
  readonly lmStudioStatus: LlmProviderStatus
  /** Latest LM Studio inventory observation. */
  readonly modelInventory: ModelInventoryState
  /** Text the rail ends with. */
  readonly summary: string
}

/**
 * Gets one pane's rail button.
 *
 * @param label - Pane label.
 * @param ordinal - Two-digit ordinal after the label.
 * @returns The button.
 * @remarks With the view's styles applied, the label and ordinal are separate
 * blocks, so the name has a space between them, as a browser computes it.
 */
function getRailButton(label: string, ordinal: string): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`^${label}\\s*${ordinal}$`)
  })
}

/**
 * Gets the settings rail.
 *
 * @returns The navigation landmark named Settings sections.
 */
function getRail(): HTMLElement {
  return screen.getByRole("navigation", { name: "Settings sections" })
}

/**
 * Gets the disclosure button of one section of the shown pane.
 *
 * @param title - Matches the section's title in its heading's name.
 * @returns The button in the level-two heading the title names.
 */
function getSectionButton(title: RegExp): HTMLElement {
  return within(
    screen.getByRole("heading", { level: 2, name: title })
  ).getByRole("button")
}

describe("SettingsView", () => {
  it("is the Settings landmark with a rail of every pane, the selected one shown", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("generation")

    render(<SettingsView onDone={vi.fn()} />)

    const settings = screen.getByRole("main", { name: "Settings" })
    const rail = within(settings).getByRole("navigation", {
      name: "Settings sections"
    })
    expect(
      within(rail)
        .getAllByRole("listitem")
        .map((entry) => entry.textContent)
    ).toEqual(RAIL_ENTRIES)
    expect(getRailButton("Generation", "05")).toHaveAttribute(
      "aria-current",
      "page"
    )
    expect(getRailButton("Runtime", "03")).not.toHaveAttribute("aria-current")
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

    await user.click(getRailButton("Models", "04"))

    expect(useLysStore.getState().settingsPane).toBe("model")
    expect(
      screen.getByRole("heading", { level: 1, name: "Models" })
    ).toBeInTheDocument()
    await waitForRenderedWork()
  })

  it("lists the Lys pane's sections under its entry, and jumps to one, opening it", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("lys")
    const user = userEvent.setup()
    render(<SettingsView onDone={vi.fn()} />)
    await user.click(
      await screen.findByRole("button", { name: "Collapse all" })
    )
    const email = getSectionButton(/Set up Lys's mailbox/)

    expect(email).toHaveAttribute("aria-expanded", "false")
    const sections = within(getRail()).getByRole("list", {
      name: "Lys sections"
    })
    expect(
      within(sections)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["About Lys", "EmailNot set up"])
    await user.click(within(sections).getByRole("button", { name: /^Email/ }))

    expect(email).toHaveAttribute("aria-expanded", "true")
    expect(email).toHaveFocus()
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeVisible()
  })

  it("opens every section again with Expand all", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("profile")
    const user = userEvent.setup()
    render(<SettingsView onDone={vi.fn()} />)

    await user.click(
      await screen.findByRole("button", { name: "Collapse all" })
    )
    await user.click(screen.getByRole("button", { name: "Expand all" }))

    for (const title of ["About you", "Location", "Preferences"]) {
      expect(getSectionButton(new RegExp(title))).toHaveAttribute(
        "aria-expanded",
        "true"
      )
    }
  })

  it("leaves once per press of Done", async () => {
    startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
    const { SettingsView } = await loadFreshSettingsView("runtime")
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView onDone={onDone} />)
    // The loading frame and the pane's frame each have a Done button; press
    // the one that stays.
    await screen.findByRole("switch", { name: "Start it when Lys opens" })

    await user.click(screen.getByRole("button", { name: "Done" }))

    expect(onDone).toHaveBeenCalledOnce()
    await waitForRenderedWork()
  })

  it.each<[string, RailStatusCase]>([
    [
      "a stopped backend",
      {
        backendStatus: "stopped",
        lmStudioStatus: "unknown",
        modelInventory: { status: "unavailable" },
        summary: "backend stopped"
      }
    ],
    [
      "a starting backend",
      {
        backendStatus: "starting",
        lmStudioStatus: "unknown",
        modelInventory: { status: "unavailable" },
        summary: "backend starting"
      }
    ],
    [
      "a stopping backend",
      {
        backendStatus: "stopping",
        lmStudioStatus: "connected",
        modelInventory: { status: "unavailable" },
        summary: "backend stopping"
      }
    ],
    [
      "an unresponsive backend",
      {
        backendStatus: "unresponsive",
        lmStudioStatus: "unknown",
        modelInventory: { status: "unavailable" },
        summary: "backend not responding"
      }
    ],
    [
      "LM Studio in an unknown state, as about to be connected",
      {
        backendStatus: "running",
        lmStudioStatus: "unknown",
        modelInventory: { status: "unavailable" },
        summary: "backend up · connecting to LM Studio"
      }
    ],
    [
      "LM Studio turned off on the backend",
      {
        backendStatus: "running",
        lmStudioStatus: "off",
        modelInventory: { status: "unavailable" },
        summary: "backend up · LM Studio is off"
      }
    ],
    [
      "LM Studio connecting",
      {
        backendStatus: "running",
        lmStudioStatus: "connecting",
        modelInventory: { status: "unavailable" },
        summary: "backend up · connecting to LM Studio"
      }
    ],
    [
      "LM Studio unreachable",
      {
        backendStatus: "running",
        lmStudioStatus: "unreachable",
        modelInventory: { status: "unavailable" },
        summary: "backend up · LM Studio not reachable"
      }
    ],
    [
      "loaded weights",
      {
        backendStatus: "running",
        lmStudioStatus: "connected",
        modelInventory: READY_RUNTIME.modelInventory,
        summary: "backend up · model loaded"
      }
    ],
    [
      "no loaded weights",
      {
        backendStatus: "running",
        lmStudioStatus: "connected",
        modelInventory: {
          status: "ready",
          modelLoading: "lys",
          models: [buildLlmInfo("qwen3-8b")]
        },
        summary: "backend up · no model"
      }
    ],
    [
      "an unreadable inventory",
      {
        backendStatus: "running",
        lmStudioStatus: "connected",
        modelInventory: { status: "failed" },
        summary: "backend up · model state unavailable"
      }
    ]
  ])(
    "summarizes %s at the foot of the rail",
    async (
      _case,
      { backendStatus, lmStudioStatus, modelInventory, summary }
    ) => {
      const runtime = {
        ...READY_RUNTIME,
        backendStatus,
        lmStudioStatus,
        modelInventory
      }
      startBackendFake({
        [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
        // A failed inventory read is followed by a re-read of LM Studio.
        "GET /api/v1/llm/lmStudio/runtime": () =>
          buildJsonResponse(200, { status: lmStudioStatus })
      })
      const { SettingsView } = await loadFreshSettingsView(
        "generation",
        runtime
      )

      render(<SettingsView onDone={vi.fn()} />)
      await waitForRenderedWork()

      expect(getRail()).toHaveTextContent(new RegExp(`${summary}$`))
    }
  )

  it("reads the model inventory of each connected provider when shown with a running backend", async () => {
    const backend = startBackendFake({
      [INVENTORY_ROUTE]: buildInventoryRoute()
    })
    const { SettingsView } = await loadFreshSettingsView("generation")

    render(<SettingsView onDone={vi.fn()} />)
    await waitForRenderedWork()

    expect(backend.requests.map((request) => request.method)).toEqual(["GET"])
    expect(new URL(backend.requests[0]?.url ?? "").pathname).toBe(
      "/api/v1/llm/lmStudio/list"
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
