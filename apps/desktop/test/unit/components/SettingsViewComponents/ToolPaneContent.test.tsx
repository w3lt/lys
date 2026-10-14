import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { UnavailableBackendTool } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  calculateToolTokenEstimate,
  formatToolTokenEstimate
} from "@/components/SettingsViewComponents/tool-presentation"
import { buildJsonResponse, startBackendFake } from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  READY_RUNTIME,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import { createControlledPromise } from "../../support/settlement"
import {
  buildBackendToolDefinition,
  buildToolDefinition
} from "../../support/toolFixtures"
import { waitForRenderedWork } from "../../support/rendering"

/** Tools the desktop lists, in Settings order. */
const TOOLS = [
  buildToolDefinition("read_text_file"),
  buildToolDefinition("find_files")
]

/** Tool the backend lists; it sends requests off this machine. */
const READ_PAGE = buildBackendToolDefinition("read_page")

/** Backend tool that can lack what it needs to run. */
const WEB_SEARCH = buildBackendToolDefinition("web_search")

/** A loaded model trained for tool use. */
const TRAINED_RUNTIME: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    models: [
      buildLlmInfo("qwen3-8b", { loaded: true, trainedForToolUse: true })
    ]
  }
}

/** A loaded model not trained for tool use. */
const UNTRAINED_RUNTIME: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    models: [buildLlmInfo("gemma-3", { loaded: true })]
  },
  defaultModel: "gemma-3"
}

/**
 * Formats the offer the status line states for some listed tools.
 *
 * @param tools - Tools switched on.
 * @returns The offer, such as `2 offered · ~216 tok per request`.
 */
function formatOffer(tools: readonly ToolDefinition[]): string {
  const tokens = tools.reduce(
    (total, tool) => total + calculateToolTokenEstimate(tool),
    0
  )
  return `${tools.length} offered · ${formatToolTokenEstimate(tokens)} per request`
}

/**
 * Renders the settings view on the Tools pane, with the backend listing
 * {@link READ_PAGE} by default, and waits for the pane body.
 *
 * @param runtime - Backend, LM Studio, and model facts.
 * @param backendTools - Tools the backend lists.
 * @param unavailableTools - Listed tools that cannot run now, and why; none
 * by default.
 * @returns The application store.
 */
async function startToolPane(
  runtime: RuntimeArrangement = TRAINED_RUNTIME,
  backendTools: readonly ToolDefinition[] = [READ_PAGE],
  unavailableTools: readonly UnavailableBackendTool[] = []
) {
  startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    "GET /api/v1/tools": () =>
      buildJsonResponse(200, { tools: backendTools, unavailableTools })
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "tools",
    runtime
  )
  render(<SettingsView onDone={vi.fn()} />)
  // The closing note is withheld until the lazily loaded pane body is shown.
  await screen.findByText(/^Tools come from Lys itself/)
  await waitForRenderedWork()
  return useLysStore
}

describe("ToolPaneContent", () => {
  it("reads the tools when first shown, with a placeholder meanwhile", async () => {
    const tools = createControlledPromise<unknown>()
    startNativeHostFake({ list_tools: () => tools.promise })
    await startToolPane()

    expect(
      screen.getAllByRole("status").map((status) => status.textContent)
    ).toEqual(["", "Reading tools settings"])

    tools.resolve(TOOLS)
    await waitForRenderedWork()

    expect(screen.getByRole("region", { name: "files" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "web" })).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Tool calls" })
    ).toBeInTheDocument()
  })

  it("shows a failed read with Retry, which reads the tools again", async () => {
    const reads: (() => unknown)[] = [
      () => Promise.reject("command list_tools failed")
    ]
    const host = startNativeHostFake({
      list_tools: () => (reads.shift() ?? (() => TOOLS))()
    })
    await startToolPane()
    const user = userEvent.setup()

    expect(
      screen.getByText("Lys couldn't read its tool list.")
    ).toHaveAttribute("role", "status")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitForRenderedWork()

    expect(host.commands).toHaveLength(2)
    expect(screen.getByRole("region", { name: "files" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("keeps the tools it read when the pane is shown again", async () => {
    const host = startNativeHostFake({ list_tools: () => TOOLS })
    const useLysStore = await startToolPane()

    act(() => {
      useLysStore.setState({ settingsPane: "runtime" })
    })
    act(() => {
      useLysStore.setState({ settingsPane: "tools" })
    })
    await screen.findByRole("region", { name: "files" })

    expect(host.commands).toHaveLength(1)
  })

  it("states what a trained model is offered and updates it as tools are switched", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    await startToolPane()
    const user = userEvent.setup()
    const toolCalls = screen.getByRole("switch", { name: "Tool calls" })

    expect(toolCalls).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer(TOOLS)}`
    )
    await user.click(screen.getByRole("switch", { name: "Use find_files" }))

    expect(toolCalls).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer([TOOLS[0]])}`
    )
    expect(screen.getByRole("region", { name: "files" })).toHaveTextContent(
      /^files1 of 2 on/
    )
  })

  it("leaves the backend's tool out of the offer until it is switched on", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    await startToolPane()
    const user = userEvent.setup()
    const toolCalls = screen.getByRole("switch", { name: "Tool calls" })
    expect(toolCalls).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer(TOOLS)}`
    )

    await user.click(screen.getByRole("switch", { name: "Use read_page" }))

    expect(toolCalls).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer([...TOOLS, READ_PAGE])}`
    )
    expect(screen.getByRole("region", { name: "web" })).toHaveTextContent(
      /^web1 of 1 on/
    )
  })

  it("leaves a tool that cannot run now out of the offer and opens the Secrets pane on request", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    const useLysStore = await startToolPane(
      TRAINED_RUNTIME,
      [READ_PAGE, WEB_SEARCH],
      [{ name: "web_search", reason: "api-key-missing" }]
    )
    const user = userEvent.setup()

    const searchSwitch = screen.getByRole("switch", { name: "Use web_search" })
    await user.click(searchSwitch)
    expect(searchSwitch).not.toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Tool calls" })
    ).toHaveAccessibleDescription(`qwen3-8b · ${formatOffer(TOOLS)}`)
    await user.click(screen.getByRole("button", { name: "Open Secrets" }))

    expect(useLysStore.getState().settingsPane).toBe("secrets")
    expect(
      screen.getByRole("heading", { level: 1, name: "Secrets" })
    ).toBeInTheDocument()
    await waitForRenderedWork()
  })

  it("offers nothing once tool calls are switched off", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    await startToolPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Tool calls" }))

    expect(
      screen.getByRole("region", { name: "Tool calls off" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Tool calls" })
    ).toHaveAccessibleDescription(
      "agents answer from the prompt alone · nothing is offered"
    )
  })

  it("expands at most one tool at a time", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    await startToolPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "read_text_file" }))
    await user.click(screen.getByRole("button", { name: "find_files" }))

    expect(
      screen.getByRole("button", { name: "read_text_file" })
    ).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "find_files" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  })

  it("locks the controls for a model not trained for tools, and restores them when it changes", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    const useLysStore = await startToolPane(TRAINED_RUNTIME)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "read_text_file" }))

    act(() => {
      useLysStore.setState({
        modelInventory: UNTRAINED_RUNTIME.modelInventory,
        modelRuntime: { status: "loaded", modelKey: "gemma-3" }
      })
    })

    expect(
      screen.getByRole("region", {
        name: "The current model isn't trained for tool calls"
      })
    ).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Tool calls" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    const toggle = screen.getByRole("button", { name: "read_text_file" })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    act(() => {
      useLysStore.setState({
        modelInventory: TRAINED_RUNTIME.modelInventory,
        modelRuntime: { status: "loaded", modelKey: "qwen3-8b" }
      })
    })

    expect(
      screen.queryByRole("region", {
        name: "The current model isn't trained for tool calls"
      })
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "read_text_file" })
    ).toHaveAttribute("aria-expanded", "true")
  })
})
