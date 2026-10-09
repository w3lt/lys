import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { buildJsonResponse, type BackendRoute } from "../../support/backendFake"
import { startAgentBackend } from "../../support/agentBackend"
import { buildAgent, buildAgentListPage } from "../../support/agentFixtures"
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
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Stored agent the cases open. */
const RESEARCHER = buildAgent("researcher", {
  name: "Researcher",
  bio: "Finds sources."
})

/** Another stored agent. */
const WRITER = buildAgent("writer", { name: "Writer", bio: "Drafts prose." })

/**
 * Renders the settings view on the Agents pane.
 *
 * @param runtime - Backend, LM Studio, and model facts.
 * @returns The application store.
 */
async function renderAgentPane(runtime: RuntimeArrangement = READY_RUNTIME) {
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "agents",
    runtime
  )
  render(<SettingsView onDone={vi.fn()} />)
  // The closing note is withheld until the lazily loaded pane body is shown.
  await screen.findByText(/^Saved by the backend in Lys's database/)
  return useLysStore
}

/**
 * Lets pending requests and store updates settle inside a React update scope.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
}

/**
 * Builds the inventory route the settings view reads with a running backend.
 *
 * @returns The inventory route keyed for a backend double.
 */
function buildInventoryRoutes() {
  return { [INVENTORY_ROUTE]: buildInventoryRoute() }
}

describe("AgentPaneContent", () => {
  it("asks for the backend instead of showing agents while it is stopped", async () => {
    const { backend } = startAgentBackend([RESEARCHER])
    await renderAgentPane(buildUnreachableRuntime("stopped"))
    await settle()

    expect(screen.getByRole("status")).toHaveTextContent(
      "Start the backend to manage agents."
    )
    expect(screen.queryByRole("region", { name: "yours" })).toBeNull()
    expect(backend.requests).toEqual([])
  })

  it("shows a placeholder while the agents are first read, then lists them", async () => {
    const list = createControlledPromise<Response>()
    startAgentBackend([RESEARCHER, WRITER], {
      routes: {
        ...buildInventoryRoutes(),
        "GET /api/v1/agents": () => list.promise
      }
    })
    await renderAgentPane()
    await settle()

    expect(
      screen.getAllByRole("status").map((status) => status.textContent)
    ).toEqual(["", "Reading agents settings"])

    list.resolve(
      buildJsonResponse(200, buildAgentListPage([RESEARCHER, WRITER]))
    )
    await settle()

    expect(
      screen.getByRole("button", { name: "Researcher researcher" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Reading agents settings")).toBeNull()
  })

  it("shows a failed read with Retry, which reads the agents again", async () => {
    let isListFailing = true
    const failingThenWorking: BackendRoute = () =>
      isListFailing
        ? new Response(null, { status: 500 })
        : buildJsonResponse(200, buildAgentListPage([RESEARCHER]))
    startAgentBackend([RESEARCHER], {
      routes: {
        ...buildInventoryRoutes(),
        "GET /api/v1/agents": failingThenWorking
      }
    })
    await renderAgentPane()
    await settle()
    const user = userEvent.setup()

    expect(screen.getByRole("status")).not.toBeEmptyDOMElement()
    isListFailing = false
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await settle()

    expect(
      screen.getByRole("button", { name: "Researcher researcher" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("reads the agents once the backend starts running", async () => {
    const { backend } = startAgentBackend([RESEARCHER], {
      routes: buildInventoryRoutes()
    })
    const useLysStore = await renderAgentPane(
      buildUnreachableRuntime("starting")
    )
    await settle()
    expect(backend.requests).toEqual([])

    act(() => {
      useLysStore.setState({ backendServerInfo: { status: "running" } })
    })
    await settle()

    expect(
      screen.getByRole("button", { name: "Researcher researcher" })
    ).toBeInTheDocument()
  })

  it("reads an opened agent with a way back, then edits it", async () => {
    const read = createControlledPromise<Response>()
    startAgentBackend([RESEARCHER], {
      routes: {
        ...buildInventoryRoutes(),
        "GET /api/v1/agents/researcher": () => read.promise
      }
    })
    await renderAgentPane()
    await settle()
    const user = userEvent.setup()

    await user.click(
      screen.getByRole("button", { name: "Researcher researcher" })
    )
    await settle()

    expect(screen.getByText("Reading researcher…")).toHaveAttribute(
      "role",
      "status"
    )
    expect(screen.getByRole("button", { name: "agents list" })).toHaveFocus()

    read.resolve(buildJsonResponse(200, RESEARCHER))
    await settle()

    expect(screen.getByRole("form", { name: "Researcher" })).toBeInTheDocument()
  })

  it("explains an agent that could not be read, and retries with focus kept on the way back", async () => {
    const reads: Response[] = [new Response(null, { status: 500 })]
    const retry = createControlledPromise<Response>()
    startAgentBackend([RESEARCHER], {
      routes: {
        ...buildInventoryRoutes(),
        "GET /api/v1/agents/researcher": () => reads.shift() ?? retry.promise
      }
    })
    await renderAgentPane()
    await settle()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole("button", { name: "Researcher researcher" })
    )
    await settle()

    expect(
      screen.getByText(/could not complete the agent request/)
    ).toHaveAttribute("role", "status")
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(screen.getByText("Reading researcher…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "agents list" })).toHaveFocus()

    retry.resolve(buildJsonResponse(200, RESEARCHER))
    await settle()
    expect(screen.getByRole("form", { name: "Researcher" })).toBeInTheDocument()
  })

  it("returns focus to the opened agent's row when its editor closes", async () => {
    startAgentBackend([RESEARCHER, WRITER], { routes: buildInventoryRoutes() })
    await renderAgentPane()
    await settle()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Writer writer" }))
    await settle()

    await user.click(screen.getByRole("button", { name: "Close" }))

    expect(screen.getByRole("button", { name: "Writer writer" })).toHaveFocus()
  })

  it("returns focus to New agent when a new agent's editor closes", async () => {
    startAgentBackend([RESEARCHER], { routes: buildInventoryRoutes() })
    await renderAgentPane()
    await settle()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "New agent" }))

    await user.click(screen.getByRole("button", { name: "Close" }))

    expect(screen.getByRole("button", { name: "New agent" })).toHaveFocus()
  })

  it("returns to the editor that was open when the pane appears again", async () => {
    startAgentBackend([RESEARCHER], { routes: buildInventoryRoutes() })
    const useLysStore = await renderAgentPane()
    await settle()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole("button", { name: "Researcher researcher" })
    )
    await settle()

    act(() => {
      useLysStore.setState({ settingsPane: "runtime" })
    })
    act(() => {
      useLysStore.setState({ settingsPane: "agents" })
    })
    await settle()

    expect(
      await screen.findByRole("form", { name: "Researcher" })
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(
      screen.getByRole("button", { name: "Researcher researcher" })
    ).toHaveFocus()
  })
})
