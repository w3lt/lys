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
import { STORED_SETTINGS_DOCUMENT } from "../../support/settingsFixtures"
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
    modelLoading: "lys",
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
    modelLoading: "lys",
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
  await screen.findByText(/^Lys's own tools cannot be added or removed here/)
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
    ).toEqual([
      "",
      "Reading tools settings",
      "",
      "No location saved. get_location fails until you save one."
    ])

    tools.resolve(TOOLS)
    await waitForRenderedWork()

    expect(screen.getByRole("region", { name: "files" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "web" })).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Tool calls" })
    ).toBeInTheDocument()
  })

  it("shows the location section, with its labelled fields, while the tools cannot be read", async () => {
    startNativeHostFake({
      list_tools: () => Promise.reject("command list_tools failed")
    })
    await startToolPane()

    const section = screen.getByRole("region", { name: "your location" })
    expect(section).toHaveTextContent(/Lys never detects where you are/)
    for (const label of ["City", "Region", "Country"]) {
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(
        "Each field is optional and holds up to 100 characters."
      )
    }
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

  it("states what a trained model is offered, updates it as tools are switched, and saves the switch", async () => {
    const host = startNativeHostFake({
      list_tools: () => TOOLS,
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })
    await startToolPane()
    const user = userEvent.setup()
    const toolCalls = screen.getByRole("switch", { name: "Tool calls" })

    expect(toolCalls).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer(TOOLS)}`
    )
    await user.click(screen.getByRole("switch", { name: "Use find_files" }))
    await waitForRenderedWork()

    expect(toolCalls).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer([TOOLS[0]])}`
    )
    expect(screen.getByRole("region", { name: "files" })).toHaveTextContent(
      /^files1 of 2 on/
    )
    expect(host.commands.at(-1)).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          tools: { justRun: [], switches: { find_files: false } }
        }
      }
    })
  })

  it("shows the saved switches, a tool without one at its default", async () => {
    startNativeHostFake({ list_tools: () => TOOLS })
    const useLysStore = await startToolPane()
    const { settings } = useLysStore.getState()

    act(() => {
      useLysStore.setState({
        settings: {
          ...settings,
          tools: {
            justRunToolNames: new Set(),
            switches: new Map([
              ["read_page", true],
              ["find_files", false]
            ])
          }
        }
      })
    })

    expect(screen.getByRole("switch", { name: "Use read_page" })).toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Use find_files" })
    ).not.toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Use read_text_file" })
    ).toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Tool calls" })
    ).toHaveAccessibleDescription(
      `qwen3-8b · ${formatOffer([TOOLS[0], READ_PAGE])}`
    )
  })

  it("leaves the backend's tool out of the offer until it is switched on", async () => {
    startNativeHostFake({
      list_tools: () => TOOLS,
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })
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

  it("saves a tool put on Just run, says what that does, and reports the save", async () => {
    const write = createControlledPromise<null>()
    const host = startNativeHostFake({
      list_tools: () => TOOLS,
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => write.promise
    })
    await startToolPane()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "read_text_file" }))

    await user.click(screen.getByRole("button", { name: "Just run" }))
    const saveStatus = screen.getByRole("status", {
      name: "Tool choices save"
    })
    const whileSaving = saveStatus.textContent
    write.resolve(null)
    await waitForRenderedWork()

    expect(
      screen.getByRole("group", { name: "Before it runs" })
    ).toHaveAccessibleDescription(
      "Runs the moment the model asks, without showing you the call."
    )
    expect(whileSaving).toBe("Saving tool choices…")
    expect(saveStatus).toHaveTextContent(/^$/)
    expect(host.commands.at(-1)).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          tools: { justRun: ["read_text_file"], switches: {} }
        }
      }
    })
  })

  it("reports a failed save and saves again on Retry saving, keeping the choice meanwhile", async () => {
    const writes: (() => unknown)[] = [() => Promise.reject("Disk full")]
    const host = startNativeHostFake({
      list_tools: () => TOOLS,
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => (writes.shift() ?? (() => null))()
    })
    await startToolPane()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "read_text_file" }))
    await user.click(screen.getByRole("button", { name: "Just run" }))
    await waitForRenderedWork()

    expect(
      screen.getByRole("status", { name: "Tool choices save" })
    ).toHaveTextContent(
      "Couldn't save your tool choices. Each switch applies until Lys quits, but Just run keeps following the choices Lys last saved until a save works."
    )
    expect(screen.getByRole("button", { name: "Just run" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await user.click(screen.getByRole("button", { name: "Retry saving" }))
    await waitForRenderedWork()

    expect(
      host.commands.filter((invoked) => invoked.command === "save_settings")
    ).toHaveLength(2)
    expect(
      screen.getByRole("status", { name: "Tool choices save" })
    ).toHaveTextContent(/^$/)
    expect(screen.queryByRole("button", { name: "Retry saving" })).toBeNull()
  })

  it("keeps a failed save's status and Retry saving while the tools are read again, and after that read fails", async () => {
    const reread = createControlledPromise<unknown>()
    const reads: (() => unknown)[] = [() => TOOLS]
    startNativeHostFake({
      list_tools: () => (reads.shift() ?? (() => reread.promise))(),
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })
    await startToolPane()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "read_text_file" }))
    await user.click(screen.getByRole("button", { name: "Just run" }))
    await waitForRenderedWork()
    const { useToolStore } = await import("@/lib/store/tools")
    const saveFailure =
      "Couldn't save your tool choices. Each switch applies until Lys quits, but Just run keeps following the choices Lys last saved until a save works."

    act(() => void useToolStore.getState().loadTools())
    await waitForRenderedWork()
    const whileReading = screen.getByRole("status", {
      name: "Tool choices save"
    }).textContent
    const retryWhileReading = screen.queryByRole("button", {
      name: "Retry saving"
    })
    reread.reject("command list_tools failed")
    await waitForRenderedWork()

    expect(whileReading).toBe(saveFailure)
    expect(retryWhileReading).toBeInTheDocument()
    expect(screen.getByText("Lys couldn't read its tool list.")).toBeVisible()
    expect(
      screen.getByRole("status", { name: "Tool choices save" })
    ).toHaveTextContent(saveFailure)
    expect(
      screen.getByRole("button", { name: "Retry saving" })
    ).toBeInTheDocument()
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
