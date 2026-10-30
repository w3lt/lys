import type { McpServerList } from "@lys/protocol"
import { mcpServerSettingsSchema, type ToolDefinition } from "@lys/share"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  calculateToolTokenEstimate,
  formatToolTokenEstimate
} from "@/components/SettingsViewComponents/tool-presentation"
import {
  buildJsonResponse,
  createTransportFailure,
  startBackendFake,
  type BackendFake,
  type BackendRoute,
  type BackendRoutes
} from "../../support/backendFake"
import {
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  buildMcpServerStatus,
  CONNECTING_MCP_STATE
} from "../../support/mcpFixtures"
import { buildLlmInfo } from "../../support/modelFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import { createControlledPromise } from "../../support/settlement"
import {
  buildUnreachableRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"
import {
  STORED_MCP_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import { buildMcpToolDefinition } from "../../support/toolFixtures"

/** Route key of the list read. */
const LIST_ROUTE = "GET /api/v1/mcp/servers"

/** Route key of the sync. */
const SYNC_ROUTE = "POST /api/v1/mcp/servers/sync"

/** Route key of a reconnect of the `notes` server. */
const RECONNECT_NOTES_ROUTE = "POST /api/v1/mcp/servers/notes/reconnect"

/** Route key of the backend's tool list. */
const TOOLS_ROUTE = "GET /api/v1/tools"

/** Tools the connected `files` server lists, in the server's order. */
const FILES_TOOLS = ["read_file", "write_file", "search"].map((name) =>
  buildMcpToolDefinition("files", name)
)

/** Both stored servers: the command server connected, the URL one refused. */
const STORED_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(3)),
  buildMcpServerStatus("notes", "http", buildFailedMcpState("unauthorized"))
])

/** Saved values that can be secrets, which the pane never shows as text. */
const SECRET_VALUES = ["debug", "fixture-0000"]

/** Problem of the stored `notes` server, which refused the request. */
const UNAUTHORIZED_TEXT =
  "The server refused the request. Check the token and the headers."

/** A loaded model trained for tool use, so the tools are offered. */
const TRAINED_RUNTIME: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    models: [
      buildLlmInfo("qwen3-8b", { loaded: true, trainedForToolUse: true })
    ],
    modelLoading: "lys"
  }
}

/**
 * Formats what some tools cost per request, as the pane says it.
 *
 * @param tools - Tools switched on.
 * @returns The estimate, such as `~216 tok`.
 */
function formatToolCost(tools: readonly ToolDefinition[]): string {
  return formatToolTokenEstimate(
    tools.reduce((total, tool) => total + calculateToolTokenEstimate(tool), 0)
  )
}

/**
 * Builds a route that answers with a server list.
 *
 * @param list - List the backend answers with.
 * @returns The route.
 */
function answerList(list: McpServerList): BackendRoute {
  return () => buildJsonResponse(200, list)
}

/**
 * Starts a native host holding the stored settings document and no tools
 * of the desktop's own, whose writes succeed or fail as the case says.
 *
 * @param saveSettings - Answer of every write; succeeds by default.
 * @returns The host observation handle.
 */
function startSettingsHost(saveSettings: () => unknown = () => null) {
  return startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: saveSettings,
    list_tools: () => []
  })
}

/**
 * Renders the settings view on the MCP pane, with the stored settings in the
 * application store, and waits for the pane body and its first reads.
 *
 * @param routes - Backend routes the case needs besides the inventory read;
 * the stored list answers the list read and the `files` tools the tool
 * read unless the case declares them.
 * @param runtime - Backend, LM Studio, and model facts; a model trained for
 * tool use by default.
 * @returns The stores and the backend observation handle.
 */
async function startMcpPane(
  routes: BackendRoutes = {},
  runtime: RuntimeArrangement = TRAINED_RUNTIME
) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    [LIST_ROUTE]: answerList(STORED_LIST),
    [TOOLS_ROUTE]: () =>
      buildJsonResponse(200, { tools: FILES_TOOLS, unavailableTools: [] }),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "mcp",
    runtime
  )
  const { useMcpServerStore } = await import("@/lib/store/mcp-servers")
  const { useToolStore } = await import("@/lib/store/tools")
  useLysStore.setState({ settings: STORED_SETTINGS })
  render(<SettingsView onDone={vi.fn()} />)
  // The closing note is withheld until the lazily loaded pane body is shown.
  await screen.findByText(/^Saved in settings\.json in Lys's home folder/)
  await waitForRenderedWork()
  return { useLysStore, useMcpServerStore, useToolStore, backend }
}

/**
 * Lists the route keys of the backend's MCP requests, in arrival order.
 *
 * @param backend - Backend observation handle.
 * @returns The route keys, without the inventory and tool reads.
 */
function listMcpRouteKeys(backend: BackendFake): string[] {
  return backend.requests
    .map((request) => request.routeKey)
    .filter((routeKey) => routeKey !== INVENTORY_ROUTE)
    .filter((routeKey) => routeKey !== TOOLS_ROUTE)
}

/**
 * Lists the settings documents the host was asked to write.
 *
 * @param commands - Native commands the host observed.
 * @returns The `newSettings` of each `save_settings` call, in order.
 */
function listWrittenDocuments(
  commands: readonly { command: string; args: unknown }[]
): unknown[] {
  return commands
    .filter((invoked) => invoked.command === "save_settings")
    .map((invoked) => (invoked.args as { newSettings: unknown }).newSettings)
}

/**
 * Gets the row of one saved server.
 *
 * @param serverName - Server name.
 * @returns The list item named by the server.
 */
function getServerRow(serverName: string): HTMLElement {
  return within(screen.getByRole("list", { name: "MCP servers" })).getByRole(
    "listitem",
    { name: serverName }
  )
}

/**
 * Gets the button that shows or hides one server's details.
 *
 * @param serverName - Server name.
 * @returns The toggle, named by the server.
 */
function getServerToggle(serverName: string): HTMLElement {
  return within(getServerRow(serverName)).getByRole("button", {
    name: serverName
  })
}

/**
 * Shows one server's details.
 *
 * @param user - User-event session of the case.
 * @param serverName - Server name.
 * @returns The server's row.
 */
async function expandServer(
  user: ReturnType<typeof userEvent.setup>,
  serverName: string
): Promise<HTMLElement> {
  await user.click(getServerToggle(serverName))
  return getServerRow(serverName)
}

/**
 * Gets the pane's status line, which speaks for the servers as a whole.
 *
 * @returns The status named MCP status.
 */
function getPaneStatus(): HTMLElement {
  return screen.getByRole("status", { name: "MCP status" })
}

/**
 * Opens the editor of a new server from Add server.
 *
 * @param user - User-event session of the case.
 * @returns The editor form.
 */
async function openNewServerEditor(
  user: ReturnType<typeof userEvent.setup>
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Add server" }))
  return screen.getByRole("form", { name: "New MCP server" })
}

/**
 * Removes one saved server through its details, confirming the removal,
 * and waits for the save.
 *
 * @param user - User-event session of the case.
 * @param serverName - Name of the server to remove.
 */
async function removeServer(
  user: ReturnType<typeof userEvent.setup>,
  serverName: string
): Promise<void> {
  const row = getServerRow(serverName)
  if (getServerToggle(serverName).getAttribute("aria-expanded") === "false") {
    await user.click(getServerToggle(serverName))
  }
  await user.click(
    within(row).getByRole("button", { name: `Remove ${serverName}` })
  )
  await user.click(
    within(within(row).getByRole("group", { name: /^remove / })).getByRole(
      "button",
      { name: `Remove ${serverName}` }
    )
  )
  await waitForRenderedWork()
}

describe("McpPaneContent", () => {
  it("lists the saved servers with how each runs, what it reaches, and its state, never a secret", async () => {
    startSettingsHost()
    const { backend } = await startMcpPane()

    expect(
      screen.getByRole("heading", { level: 1, name: "MCP" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Programs and services that give the agents more tools. Local ones Lys starts on this machine; remote ones it reaches by URL. Each runs as you, so add only servers you trust."
      )
    ).toBeInTheDocument()
    const section = screen.getByRole("region", { name: "servers" })
    expect(section).toHaveTextContent(
      `1 of 2 connected · 3 tools · ${formatToolCost(FILES_TOOLS)} per request`
    )
    const files = getServerToggle("files")
    expect(files).toHaveAttribute("aria-expanded", "false")
    expect(files).toHaveAccessibleDescription(
      "stdio Running /opt/homebrew/bin/npx -y @modelcontextprotocol/server-filesystem /tmp 3 tools"
    )
    expect(getServerToggle("notes")).toHaveAccessibleDescription(
      "http failed https://mcp.example.test/notes"
    )
    for (const secret of SECRET_VALUES) {
      expect(section).not.toHaveTextContent(secret)
    }
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE])
  })

  it("shows one server's state, tools, approval, and configuration at a time, never a secret", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const files = await expandServer(user, "files")

    expect(getServerToggle("files")).toHaveAttribute("aria-expanded", "true")
    expect(within(files).getByRole("status")).toHaveTextContent(
      "files: Running3 tools listed"
    )
    expect(
      within(files).getByRole("button", { name: "Restart files" })
    ).toHaveTextContent("Restart")
    const tools = within(files).getByRole("region", { name: "tools" })
    expect(tools).toHaveTextContent(
      `3 of 3 on · ${formatToolCost(FILES_TOOLS)}`
    )
    const chips = within(
      within(tools).getByRole("list", { name: "Tools of files" })
    ).getAllByRole("button")
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "read_file",
      "write_file",
      "search"
    ])
    for (const chip of chips) {
      expect(chip).toHaveAttribute("aria-pressed", "true")
    }
    expect(chips[0]).toHaveAccessibleDescription("Runs read_file on files.")
    const approval = within(files).getByRole("group", {
      name: "Before its tools run"
    })
    expect(
      within(approval).getByRole("button", { name: "Ask me" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(approval).toHaveAccessibleDescription(
      "You see each call and its arguments first. Nothing runs until you say yes."
    )
    const configuration = within(files).getByRole("region", {
      name: "configuration"
    })
    expect(configuration).toHaveTextContent(
      "transportstdio · child process of Lyscommand/opt/homebrew/bin/npxarguments-y @modelcontextprotocol/server-filesystem /tmpenvironmentLOG_LEVEL"
    )

    const notes = await expandServer(user, "notes")

    expect(getServerToggle("files")).toHaveAttribute("aria-expanded", "false")
    expect(within(files).queryByRole("region")).toBeNull()
    expect(within(notes).getByRole("status")).toHaveTextContent(
      `notes: Failed${UNAUTHORIZED_TEXT}`
    )
    expect(
      within(notes).getByRole("region", { name: "tools" })
    ).toHaveTextContent(
      "It stopped before listing any tools. Fix the cause above, then retry."
    )
    expect(
      within(notes).getByRole("region", { name: "configuration" })
    ).toHaveTextContent(
      "transportstreamable httpurlhttps://mcp.example.test/notessign-inbearer tokenheadersnone"
    )
    for (const secret of SECRET_VALUES) {
      expect(
        screen.getByRole("region", { name: "servers" })
      ).not.toHaveTextContent(secret)
    }
  })

  it("switches a server's tool off and on from its chip, which the application store saves", async () => {
    const host = startSettingsHost()
    const { useLysStore } = await startMcpPane()
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    const readFile = within(files).getByRole("button", { name: "read_file" })

    await user.click(readFile)
    await waitForRenderedWork()

    expect(readFile).toHaveAttribute("aria-pressed", "false")
    expect(
      useLysStore.getState().settings.tools.switches.get(FILES_TOOLS[0].name)
    ).toBe(false)
    expect(getServerToggle("files")).toHaveAccessibleDescription(
      expect.stringMatching(/ 2 of 3 tools$/)
    )
    expect(
      within(files).getByRole("region", { name: "tools" })
    ).toHaveTextContent(`2 of 3 on · ${formatToolCost(FILES_TOOLS.slice(1))}`)
    expect(listWrittenDocuments(host.commands).at(-1)).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      tools: {
        ...STORED_SETTINGS_DOCUMENT.tools,
        switches: {
          ...STORED_SETTINGS_DOCUMENT.tools.switches,
          [FILES_TOOLS[0].name]: false
        }
      }
    })

    await user.click(readFile)
    await waitForRenderedWork()

    expect(readFile).toHaveAttribute("aria-pressed", "true")
    expect(
      useLysStore.getState().settings.tools.switches.get(FILES_TOOLS[0].name)
    ).toBe(true)
  })

  it("sets every tool of a server to Just run or Ask me at once, and shows differing choices as neither", async () => {
    startSettingsHost()
    const { useLysStore } = await startMcpPane()
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    const approval = within(files).getByRole("group", {
      name: "Before its tools run"
    })

    await user.click(within(approval).getByRole("button", { name: "Just run" }))
    await waitForRenderedWork()

    const justRun = useLysStore.getState().settings.tools.justRunToolNames
    for (const tool of FILES_TOOLS) {
      expect(justRun.has(tool.name)).toBe(true)
    }
    expect(justRun.has("read_page")).toBe(true)
    expect(
      within(approval).getByRole("button", { name: "Just run" })
    ).toHaveAttribute("aria-pressed", "true")

    useLysStore.getState().updateToolApproval(FILES_TOOLS[1].name, "ask")
    await waitForRenderedWork()

    for (const name of ["Ask me", "Just run"]) {
      expect(within(approval).getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        "false"
      )
    }
    expect(approval).toHaveAccessibleDescription(
      "Some of its tools ask first and some run at once. Choose one for all of them."
    )
  })

  it("lists the saved servers without state while the backend is not running, and asks nothing of it", async () => {
    startSettingsHost()
    const { backend } = await startMcpPane(
      {},
      buildUnreachableRuntime("stopped")
    )
    const user = userEvent.setup()

    expect(getPaneStatus()).toHaveTextContent(
      "Start the backend in Settings → Runtime to connect to MCP servers."
    )
    expect(screen.getByRole("region", { name: "servers" })).toHaveTextContent(
      "2 saved"
    )
    expect(getServerToggle("files")).toHaveAccessibleDescription(
      expect.stringContaining("Not connected")
    )
    const files = await expandServer(user, "files")
    expect(within(files).getByRole("status")).toHaveTextContent(
      "files: Not connectedLys connects once the backend runs."
    )
    expect(
      within(files).getByRole("button", { name: "Start files" })
    ).toBeDisabled()
    expect(
      within(files).getByRole("button", { name: "Edit files" })
    ).toBeEnabled()
    expect(backend.requests).toEqual([])
  })

  it("offers the two kinds of server when none is saved, each opening its editor", async () => {
    startSettingsHost()
    const { useLysStore } = await startMcpPane({
      [LIST_ROUTE]: answerList(buildMcpServerList([]))
    })
    const user = userEvent.setup()

    useLysStore.setState({
      settings: { ...STORED_SETTINGS, mcp: { servers: [] } }
    })
    await waitForRenderedWork()

    expect(
      screen.getByText(
        "No servers yet. Each one gives the agents more tools: your issue tracker, a database, a repository. Add one by the command that starts it, or by its URL."
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "MCP servers" })).toBeNull()
    expect(screen.getByRole("region", { name: "servers" })).toHaveTextContent(
      "none yet"
    )
    const remote = screen.getByRole("button", { name: "Remote server" })
    expect(remote).toHaveAccessibleDescription(
      "http https://mcp.example.com/mcp"
    )

    await user.click(remote)

    const form = screen.getByRole("form", { name: "New MCP server" })
    expect(
      within(form).getByRole("radio", { name: "Remote server" })
    ).toBeChecked()
    expect(within(form).getByRole("textbox", { name: "URL" })).toBeRequired()
  })

  it("adds a local program, applies the saved list, and shows the new server with Edit focused", async () => {
    const host = startSettingsHost()
    const syncedList = buildMcpServerList([
      ...STORED_LIST.servers,
      buildMcpServerStatus("tools", "stdio", CONNECTING_MCP_STATE)
    ])
    const { backend, useLysStore } = await startMcpPane({
      [SYNC_ROUTE]: answerList(syncedList)
    })
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    expect(
      within(form).getByRole("heading", { name: "new server" })
    ).toBeInTheDocument()
    expect(
      within(form).getByRole("radio", { name: "Local program" })
    ).toBeChecked()
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveFocus()
    await user.type(
      within(form).getByRole("textbox", { name: "Name" }),
      "tools"
    )
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.type(
      within(form).getByRole("textbox", { name: "Arguments" }),
      '--stdio "two words"'
    )
    await user.click(within(form).getByRole("button", { name: "add variable" }))
    await user.keyboard("TOKEN")
    await user.type(
      within(form).getByLabelText("Value of variable 1"),
      "fixture-1111"
    )
    await user.click(within(form).getByRole("button", { name: "Add server" }))
    await waitForRenderedWork()

    const added = mcpServerSettingsSchema.parse({
      name: "tools",
      transport: "stdio",
      command: "/usr/bin/tools",
      arguments: ["--stdio", "two words"],
      environment: [{ name: "TOKEN", value: "fixture-1111" }]
    })
    expect(listWrittenDocuments(host.commands)).toEqual([
      {
        ...STORED_SETTINGS_DOCUMENT,
        mcp: { servers: [...STORED_MCP_SETTINGS.servers, added] }
      }
    ])
    expect(useLysStore.getState().settings.mcp.servers).toHaveLength(3)
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE, SYNC_ROUTE])
    expect(screen.queryByRole("form")).toBeNull()
    expect(getServerToggle("tools")).toHaveAttribute("aria-expanded", "true")
    expect(within(getServerRow("tools")).getByRole("status")).toHaveTextContent(
      "tools: Startingstarted · waiting for initialize"
    )
    expect(
      within(getServerRow("tools")).getByRole("button", { name: "Edit tools" })
    ).toHaveFocus()
  })

  it("adds a remote server whose token is saved as its Authorization header, hidden until shown", async () => {
    const host = startSettingsHost()
    await startMcpPane({ [SYNC_ROUTE]: answerList(STORED_LIST) })
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.click(within(form).getByRole("radio", { name: "Remote server" }))
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "docs")
    await user.type(
      within(form).getByRole("textbox", { name: "URL" }),
      "https://docs.example.test/mcp"
    )
    const signIn = within(form).getByRole("group", { name: "Sign-in" })
    expect(signIn).toHaveAccessibleDescription(
      "Anyone who can reach the URL can use it. Fine for servers on your own network."
    )
    expect(within(form).queryByLabelText("Token")).toBeNull()
    await user.click(within(signIn).getByRole("button", { name: "Token" }))
    const token = within(form).getByLabelText("Token")
    expect(signIn).toHaveAccessibleDescription(
      "Sent as Authorization: Bearer … with each request, and saved in plain text."
    )
    await user.type(token, "fixture-2222")
    expect(token).toHaveAttribute("type", "password")
    const showToken = within(form).getByRole("button", { name: "Show token" })
    await user.click(showToken)
    expect(token).toHaveAttribute("type", "text")
    expect(showToken).toHaveAttribute("aria-pressed", "true")
    await user.click(within(form).getByRole("button", { name: "add header" }))
    await user.keyboard("X-Workspace")
    await user.type(within(form).getByLabelText("Value of header 1"), "lys")
    await user.click(within(form).getByRole("button", { name: "Add server" }))
    await waitForRenderedWork()

    const added = mcpServerSettingsSchema.parse({
      name: "docs",
      transport: "http",
      url: "https://docs.example.test/mcp",
      headers: [
        { name: "Authorization", value: "Bearer fixture-2222" },
        { name: "X-Workspace", value: "lys" }
      ]
    })
    expect(listWrittenDocuments(host.commands)).toEqual([
      {
        ...STORED_SETTINGS_DOCUMENT,
        mcp: { servers: [...STORED_MCP_SETTINGS.servers, added] }
      }
    ])
  })

  it("shows each field's first problem on Save, focuses a summary that leads to each, and saves nothing", async () => {
    const host = startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.type(
      within(form).getByRole("textbox", { name: "Name" }),
      "files"
    )
    await user.type(
      within(form).getByRole("textbox", { name: "Arguments" }),
      '-y "unclosed'
    )
    await user.click(within(form).getByRole("button", { name: "Add server" }))

    const summary = within(form).getByRole("group", {
      name: "Fix 3 fields to save:"
    })
    expect(summary).toHaveFocus()
    expect(
      within(summary)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual([
      "Name: Another MCP server already has this name.",
      "Command: Enter the command that starts the server, up to 1024 characters.",
      "Arguments: Close the quote at character 4."
    ])
    const name = within(form).getByRole("textbox", { name: "Name" })
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription(
      "a-z, 0-9, single hyphens · up to 20 its tools arrive as mcp__files__… Another MCP server already has this name."
    )
    const command = within(form).getByRole("textbox", { name: "Command" })
    expect(command).toHaveAccessibleDescription(
      "the program Lys starts, by its full path Enter the command that starts the server, up to 1024 characters."
    )

    await user.click(
      within(summary).getByRole("button", {
        name: "Command: Enter the command that starts the server, up to 1024 characters."
      })
    )

    expect(command).toHaveFocus()
    expect(name).toHaveValue("files")
    expect(listWrittenDocuments(host.commands)).toEqual([])
  })

  it("focuses the only field with a problem on Save, without a summary", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.click(within(form).getByRole("button", { name: "Add server" }))

    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveFocus()
    expect(within(form).queryByRole("group", { name: /^Fix / })).toBeNull()
  })

  it("focuses the row input that breaks a rule, and names the row in its problem", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.type(
      within(form).getByRole("textbox", { name: "Name" }),
      "tools"
    )
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.click(within(form).getByRole("button", { name: "add variable" }))
    await user.keyboard("1BAD")
    await user.click(within(form).getByRole("button", { name: "Add server" }))

    const environment = within(form).getByRole("group", { name: "Environment" })
    const variableName = within(environment).getByRole("textbox", {
      name: "Name of variable 1"
    })
    expect(variableName).toHaveFocus()
    expect(variableName).toHaveAttribute("aria-invalid", "true")
    expect(variableName).toHaveAccessibleDescription(/^Variable 1: /)
    expect(environment).toHaveAccessibleDescription(
      expect.stringMatching(
        /^NAME: letters, digits, _ · values saved in plain text Variable 1: /
      )
    )
  })

  it("marks the required fields and states each field's format before entry", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    const name = within(form).getByRole("textbox", { name: "Name" })

    expect(name).toBeRequired()
    expect(name).toHaveAccessibleDescription(
      "a-z, 0-9, single hyphens · up to 20 its tools arrive as mcp__name__…"
    )
    await user.type(name, "github")
    expect(name).toHaveAccessibleDescription(
      "a-z, 0-9, single hyphens · up to 20 its tools arrive as mcp__github__…"
    )
    expect(
      within(form).getByRole("textbox", { name: "Command" })
    ).toHaveAccessibleDescription("the program Lys starts, by its full path")
    expect(
      within(form).getByRole("textbox", { name: "Arguments" })
    ).not.toBeRequired()
    expect(
      within(form).getByRole("group", { name: "Environment" })
    ).toHaveAccessibleDescription(
      "NAME: letters, digits, _ · values saved in plain text"
    )
    expect(within(form).getAllByText("required")).toHaveLength(2)

    await user.click(within(form).getByRole("radio", { name: "Remote server" }))

    expect(within(form).getByRole("textbox", { name: "URL" })).toBeRequired()
    expect(
      within(form).getByRole("textbox", { name: "URL" })
    ).toHaveAccessibleDescription(
      "streamable http · https://, or http:// for localhost"
    )
    expect(
      within(form).getByRole("group", { name: "Headers" })
    ).toHaveAccessibleDescription("optional · values saved in plain text")
    expect(within(form).getAllByText("required")).toHaveLength(2)
  })

  it("updates a problem as the person types after the first Save", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.click(within(form).getByRole("button", { name: "Add server" }))
    await user.type(
      within(form).getByRole("textbox", { name: "Name" }),
      "fresh"
    )

    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "aria-invalid",
      "false"
    )
    expect(
      within(form).getByRole("textbox", { name: "Command" })
    ).toHaveAttribute("aria-invalid", "true")
  })

  it("edits a remote server in place, keeping its place, its token, and saying it is unsaved meanwhile", async () => {
    const host = startSettingsHost()
    const { backend } = await startMcpPane({
      [SYNC_ROUTE]: answerList(STORED_LIST)
    })
    const user = userEvent.setup()

    const notes = await expandServer(user, "notes")
    await user.click(within(notes).getByRole("button", { name: "Edit notes" }))
    const form = screen.getByRole("form", { name: "notes" })
    expect(
      within(form).getByRole("heading", { name: "editing · notes" })
    ).toBeInTheDocument()
    expect(
      within(form).getByRole("radio", { name: "Remote server" })
    ).toBeChecked()
    expect(
      within(within(form).getByRole("group", { name: "Sign-in" })).getByRole(
        "button",
        { name: "Token" }
      )
    ).toHaveAttribute("aria-pressed", "true")
    const token = within(form).getByLabelText("Token")
    expect(token).toHaveValue("fixture-0000")
    expect(token).toHaveAttribute("type", "password")
    expect(within(form).queryByLabelText("Name of header 1")).toBeNull()
    expect(within(form).queryByText("unsaved")).toBeNull()
    const url = within(form).getByRole("textbox", { name: "URL" })
    await user.clear(url)
    await user.type(url, "http://localhost:7000/mcp")
    expect(within(form).getByText("unsaved")).toBeInTheDocument()
    await user.keyboard("{Enter}")
    await waitForRenderedWork()

    expect(listWrittenDocuments(host.commands)).toEqual([
      {
        ...STORED_SETTINGS_DOCUMENT,
        mcp: {
          servers: [
            STORED_MCP_SETTINGS.servers[0],
            {
              ...STORED_MCP_SETTINGS.servers[1],
              url: "http://localhost:7000/mcp"
            }
          ]
        }
      }
    ])
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE, SYNC_ROUTE])
    expect(getServerToggle("notes")).toHaveAttribute("aria-expanded", "true")
    expect(
      within(getServerRow("notes")).getByRole("button", { name: "Edit notes" })
    ).toHaveFocus()
  })

  it("saves on ⌘ Enter from any field", async () => {
    const host = startSettingsHost()
    await startMcpPane({ [SYNC_ROUTE]: answerList(STORED_LIST) })
    const user = userEvent.setup()

    const files = await expandServer(user, "files")
    await user.click(within(files).getByRole("button", { name: "Edit files" }))
    const form = screen.getByRole("form", { name: "files" })
    await user.click(within(form).getByLabelText("Value of variable 1"))
    await user.keyboard("{Meta>}{Enter}{/Meta}")
    await waitForRenderedWork()

    expect(listWrittenDocuments(host.commands)).toEqual([
      STORED_SETTINGS_DOCUMENT
    ])
  })

  it("keeps what was typed for the other transport when switching back", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.click(within(form).getByRole("radio", { name: "Remote server" }))

    expect(within(form).queryByRole("textbox", { name: "Command" })).toBeNull()
    expect(
      within(form).getByRole("group", { name: "Headers" })
    ).toBeInTheDocument()

    await user.click(within(form).getByRole("radio", { name: "Local program" }))

    expect(within(form).getByRole("textbox", { name: "Command" })).toHaveValue(
      "/usr/bin/tools"
    )
  })

  it("adds and removes rows, moving focus to a new row's name and, after a removal, to the add button", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    const addVariable = within(form).getByRole("button", {
      name: "add variable"
    })
    await user.click(addVariable)

    expect(within(form).getByLabelText("Name of variable 1")).toHaveFocus()
    expect(within(form).getByLabelText("Value of variable 1")).toHaveAttribute(
      "type",
      "text"
    )
    expect(
      within(form).getByRole("button", { name: "Show value of variable 1" })
    ).toHaveAttribute("aria-pressed", "true")
    await user.keyboard("FIRST")
    await user.click(addVariable)
    expect(within(form).getByLabelText("Name of variable 2")).toHaveFocus()
    await user.keyboard("SECOND")

    await user.click(
      within(form).getByRole("button", { name: "Remove variable 1" })
    )

    expect(addVariable).toHaveFocus()
    expect(within(form).getByLabelText("Name of variable 1")).toHaveValue(
      "SECOND"
    )
    expect(within(form).queryByLabelText("Name of variable 2")).toBeNull()
  })

  it("hides saved values until the person shows them", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const files = await expandServer(user, "files")
    await user.click(within(files).getByRole("button", { name: "Edit files" }))
    const form = screen.getByRole("form", { name: "files" })
    const value = within(form).getByLabelText("Value of variable 1")
    const show = within(form).getByRole("button", {
      name: "Show value of variable 1"
    })

    expect(within(form).getByLabelText("Name of variable 1")).toHaveValue(
      "LOG_LEVEL"
    )
    expect(value).toHaveAttribute("type", "password")
    expect(show).toHaveAttribute("aria-pressed", "false")

    await user.click(show)

    expect(value).toHaveAttribute("type", "text")
    expect(value).toHaveValue("debug")
  })

  it("fills a new server from a pasted config and says from which server", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    const pasteJson = within(form).getByRole("button", { name: "paste json" })
    await user.click(pasteJson)
    const field = within(form).getByRole("textbox", { name: "Paste JSON" })
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(
      "claude_desktop_config.json, .cursor/mcp.json or a single server object"
    )
    await user.paste(
      JSON.stringify({
        mcpServers: {
          "GitHub Tools": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "fixture-3333" }
          },
          other: { url: "https://other.example.test/mcp" }
        }
      })
    )

    expect(field).toHaveAccessibleDescription(
      "filled from json · first of 2 servers · add the rest the same way"
    )
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveValue(
      "github-tools"
    )
    expect(within(form).getByRole("textbox", { name: "Command" })).toHaveValue(
      "npx"
    )
    expect(
      within(form).getByRole("textbox", { name: "Arguments" })
    ).toHaveValue("-y @modelcontextprotocol/server-github")
    expect(within(form).getByLabelText("Name of variable 1")).toHaveValue(
      "GITHUB_TOKEN"
    )
    expect(within(form).getByLabelText("Value of variable 1")).toHaveAttribute(
      "type",
      "password"
    )

    await user.click(within(form).getByRole("button", { name: "close" }))

    expect(
      within(form).queryByRole("textbox", { name: "Paste JSON" })
    ).toBeNull()
    expect(
      within(form).getByRole("button", { name: "paste json" })
    ).toHaveFocus()
  })

  it("says why a pasted config cannot fill the fields, and leaves them as they are", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const form = await openNewServerEditor(user)
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "kept")
    await user.click(within(form).getByRole("button", { name: "paste json" }))
    await user.paste(
      '{ "mcpServers": { "old": { "url": "https://old.test/sse", "type": "sse" } } }'
    )

    expect(
      within(form).getByRole("textbox", { name: "Paste JSON" })
    ).toHaveAccessibleDescription(
      "lys doesn't speak sse · use the server's streamable http url"
    )
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveValue(
      "kept"
    )
    expect(
      within(form).getByRole("radio", { name: "Local program" })
    ).toBeChecked()
  })

  it("closes an editor on Cancel, Escape, or the back button without saving, returning focus to its opener", async () => {
    const host = startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const files = await expandServer(user, "files")
    await user.click(within(files).getByRole("button", { name: "Edit files" }))
    await user.type(
      within(screen.getByRole("form", { name: "files" })).getByRole("textbox", {
        name: "Command"
      }),
      "-changed"
    )
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByRole("form")).toBeNull()
    expect(
      within(getServerRow("files")).getByRole("button", { name: "Edit files" })
    ).toHaveFocus()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("form")).toBeNull()
    expect(screen.getByRole("button", { name: "Add server" })).toHaveFocus()

    await user.click(
      within(getServerRow("files")).getByRole("button", { name: "Edit files" })
    )
    await user.click(screen.getByRole("button", { name: "mcp servers" }))

    expect(screen.queryByRole("form")).toBeNull()
    expect(
      within(getServerRow("files")).getByRole("button", { name: "Edit files" })
    ).toHaveFocus()
    expect(listWrittenDocuments(host.commands)).toEqual([])
  })

  it("asks before removing a server and its secrets, keeps it on Escape, and removes it on Remove", async () => {
    const host = startSettingsHost()
    const { backend } = await startMcpPane({
      [SYNC_ROUTE]: answerList(buildMcpServerList([STORED_LIST.servers[1]]))
    })
    const user = userEvent.setup()
    const files = await expandServer(user, "files")

    await user.click(
      within(files).getByRole("button", { name: "Remove files" })
    )
    const question = within(files).getByRole("group", {
      name: "remove files and its secrets?"
    })
    expect(
      within(question).getByRole("button", { name: "Keep files" })
    ).toHaveFocus()
    await user.keyboard("{Escape}")

    expect(within(files).queryByRole("group", { name: /^remove / })).toBeNull()
    expect(
      within(files).getByRole("button", { name: "Remove files" })
    ).toHaveFocus()
    expect(listWrittenDocuments(host.commands)).toEqual([])

    await removeServer(user, "files")

    expect(listWrittenDocuments(host.commands)).toEqual([
      {
        ...STORED_SETTINGS_DOCUMENT,
        mcp: { servers: [STORED_MCP_SETTINGS.servers[1]] }
      }
    ])
    expect(
      within(screen.getByRole("list", { name: "MCP servers" })).queryByRole(
        "listitem",
        { name: "files" }
      )
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Add server" })).toHaveFocus()
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE, SYNC_ROUTE])
  })

  it("reports a failed removal in the status line and keeps the server", async () => {
    startSettingsHost(() => Promise.reject("Disk full"))
    await startMcpPane()
    const user = userEvent.setup()

    await removeServer(user, "files")

    expect(getPaneStatus()).toHaveTextContent(
      "Lys couldn't write the MCP servers to its settings file."
    )
    expect(getServerRow("files")).toBeInTheDocument()
  })

  it("keeps the editor open with an alert when its save fails", async () => {
    startSettingsHost(() => Promise.reject("Disk full"))
    const { backend } = await startMcpPane()
    const user = userEvent.setup()

    const files = await expandServer(user, "files")
    await user.click(within(files).getByRole("button", { name: "Edit files" }))
    const form = screen.getByRole("form", { name: "files" })
    expect(within(form).getByRole("alert")).toHaveTextContent("")
    await user.click(within(form).getByRole("button", { name: "Save" }))
    await waitForRenderedWork()

    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Lys couldn't write the MCP servers to its settings file."
    )
    // The editor's alert says it; the pane's status line does not repeat it.
    expect(
      screen.getAllByText(
        "Lys couldn't write the MCP servers to its settings file."
      )
    ).toHaveLength(1)
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE])
  })

  it("reconnects one server and shows the state the backend answers", async () => {
    startSettingsHost()
    const { backend } = await startMcpPane({
      [RECONNECT_NOTES_ROUTE]: answerList(
        buildMcpServerList([
          STORED_LIST.servers[0],
          buildMcpServerStatus("notes", "http", buildConnectedMcpState(1))
        ])
      )
    })
    const user = userEvent.setup()
    const notes = await expandServer(user, "notes")

    const state = within(notes).getByRole("status")
    expect(state).toHaveAttribute("aria-atomic", "true")
    expect(state).toHaveTextContent(`notes: Failed${UNAUTHORIZED_TEXT}`)
    await user.click(within(notes).getByRole("button", { name: "Retry notes" }))
    await waitForRenderedWork()

    expect(listMcpRouteKeys(backend)).toEqual([
      LIST_ROUTE,
      RECONNECT_NOTES_ROUTE
    ])
    // The row's own status, there before the change, says the new state.
    expect(within(getServerRow("notes")).getByRole("status")).toBe(state)
    expect(state).toHaveTextContent("notes: Connected1 tool listed")
    expect(
      within(getServerRow("notes")).getByRole("button", {
        name: "Reconnect notes"
      })
    ).toBeInTheDocument()
  })

  it("says a saved server the backend has not applied is not applied", async () => {
    startSettingsHost()
    await startMcpPane({
      [LIST_ROUTE]: answerList(buildMcpServerList([STORED_LIST.servers[0]]))
    })
    const user = userEvent.setup()

    expect(getServerToggle("notes")).toHaveAccessibleDescription(
      expect.stringContaining("not applied")
    )
    const notes = await expandServer(user, "notes")
    expect(within(notes).getByRole("status")).toHaveTextContent(
      "notes: Not appliedConnect applies the saved servers."
    )
    expect(
      within(notes).getByRole("button", { name: "Connect notes" })
    ).toBeEnabled()
  })

  it("says why the backend keeps the servers it applied last", async () => {
    startSettingsHost()
    await startMcpPane({
      [LIST_ROUTE]: answerList(
        buildMcpServerList(STORED_LIST.servers, "invalid")
      )
    })

    expect(getPaneStatus()).toHaveTextContent(
      "The mcp group in settings.json isn't valid. Lys keeps the servers it applied last."
    )
  })

  it("reads the states again each time the pane opens, so a connection that ended shows", async () => {
    startSettingsHost()
    let reads = 0
    const { backend } = await startMcpPane({
      [LIST_ROUTE]: () => {
        reads += 1
        return buildJsonResponse(
          200,
          reads === 1
            ? STORED_LIST
            : buildMcpServerList([
                buildMcpServerStatus(
                  "files",
                  "stdio",
                  buildFailedMcpState("closed")
                ),
                STORED_LIST.servers[1]
              ])
        )
      }
    })
    const user = userEvent.setup()
    expect(getServerToggle("files")).toHaveAccessibleDescription(
      expect.stringContaining("Running")
    )

    await user.click(screen.getByRole("tab", { name: /^Generation\s*03$/ }))
    await user.click(screen.getByRole("tab", { name: /^MCP\s*06$/ }))
    await screen.findByText(/^Saved in settings\.json in Lys's home folder/)
    await waitForRenderedWork()

    expect(getServerToggle("files")).toHaveAccessibleDescription(
      expect.stringContaining("failed")
    )
    const files = await expandServer(user, "files")
    expect(within(files).getByRole("status")).toHaveTextContent(
      "files: FailedThe connection ended: the server stopped or closed it, or sent an answer too large to read."
    )
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE, LIST_ROUTE])
  })

  it("shows a failed read with Retry, which reads the states again", async () => {
    startSettingsHost()
    let reads = 0
    const { backend } = await startMcpPane({
      [LIST_ROUTE]: () => {
        reads += 1
        return reads === 1
          ? Promise.reject(createTransportFailure())
          : buildJsonResponse(200, STORED_LIST)
      }
    })
    const user = userEvent.setup()

    expect(getPaneStatus()).toHaveTextContent(
      "Lys couldn't read the state of the MCP servers: The backend could not be reached."
    )
    expect(getServerToggle("files")).toHaveAccessibleDescription(
      expect.stringContaining("State unknown")
    )
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitForRenderedWork()

    expect(getPaneStatus()).toHaveFocus()
    expect(getPaneStatus()).toHaveTextContent("")
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(getServerToggle("files")).toHaveAccessibleDescription(
      expect.stringContaining("Running")
    )
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE, LIST_ROUTE])
  })

  it("lists the tools the backend skipped on request, and says when it read only some", async () => {
    startSettingsHost()
    await startMcpPane({
      [LIST_ROUTE]: answerList(
        buildMcpServerList([
          buildMcpServerStatus(
            "files",
            "stdio",
            buildConnectedMcpState(
              2,
              [
                { name: "", reason: "unsupported-name" },
                { name: "deep", reason: "unsupported-input-schema" }
              ],
              true
            )
          )
        ])
      )
    })
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    const toggle = within(files).getByRole("button", {
      name: "Skipped tools of files"
    })

    expect(within(files).getByRole("status")).toHaveTextContent(
      "files: Running2 tools listed · 2 skipped"
    )
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(files).not.toHaveTextContent("(no name)")

    await user.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(files).toHaveTextContent(
      "(no name)Its name is empty, too long, or holds characters you can't see."
    )
    expect(files).toHaveTextContent(
      "deepIts input schema isn't one Lys can offer to a model."
    )
    expect(files).toHaveTextContent(
      "The server lists more tools than Lys reads. Lys reads the first 128."
    )
  })

  it("names each server's actions after it, starting with their visible text", async () => {
    startSettingsHost()
    await startMcpPane({
      [LIST_ROUTE]: answerList(
        buildMcpServerList([
          buildMcpServerStatus(
            "files",
            "stdio",
            buildConnectedMcpState(2, [
              { name: "deep", reason: "duplicate-name" }
            ])
          ),
          STORED_LIST.servers[1]
        ])
      )
    })
    const user = userEvent.setup()
    const files = await expandServer(user, "files")

    for (const [name, text] of [
      ["Restart files", "Restart"],
      ["Edit files", "Edit"],
      ["Remove files", "Remove"],
      ["Skipped tools of files", "Skipped tools"]
    ]) {
      expect(within(files).getByRole("button", { name })).toHaveTextContent(
        text
      )
    }

    await user.click(
      within(files).getByRole("button", { name: "Remove files" })
    )
    const question = within(files).getByRole("group", { name: /^remove / })

    expect(
      within(question).getByRole("button", { name: "Keep files" })
    ).toHaveTextContent("Keep")
    expect(
      within(question).getByRole("button", { name: "Remove files" })
    ).toHaveTextContent("Remove")
  })

  it("moves focus to Add server after each of two removals in a row", async () => {
    startSettingsHost()
    await startMcpPane({ [SYNC_ROUTE]: answerList(STORED_LIST) })
    const user = userEvent.setup()

    await removeServer(user, "files")
    const afterFirst = document.activeElement
    await removeServer(user, "notes")

    const addServer = screen.getByRole("button", { name: "Add server" })
    expect(afterFirst).toBe(addServer)
    expect(addServer).toHaveFocus()
  })

  it("moves focus to Add server after a removal that follows a cancelled new server", async () => {
    startSettingsHost()
    await startMcpPane({ [SYNC_ROUTE]: answerList(STORED_LIST) })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    const afterCancel = document.activeElement
    await removeServer(user, "files")

    const addServer = screen.getByRole("button", { name: "Add server" })
    expect(afterCancel).toBe(addServer)
    expect(addServer).toHaveFocus()
  })

  it("offers Retry when the backend could not be asked to apply a save, and says so again when the retry fails too", async () => {
    startSettingsHost()
    const secondSync = createControlledPromise<Response>()
    let syncs = 0
    const { backend } = await startMcpPane({
      [SYNC_ROUTE]: () => {
        syncs += 1
        return syncs === 1
          ? Promise.reject(createTransportFailure())
          : secondSync.promise
      }
    })
    const user = userEvent.setup()
    const failure =
      "Lys's request to apply the MCP servers failed: The backend could not be reached."

    await removeServer(user, "files")
    expect(getPaneStatus()).toHaveTextContent(failure)
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitForRenderedWork()

    expect(getPaneStatus()).toHaveFocus()
    expect(getPaneStatus()).toHaveTextContent("")
    expect(listMcpRouteKeys(backend)).toEqual([
      LIST_ROUTE,
      SYNC_ROUTE,
      SYNC_ROUTE
    ])

    secondSync.reject(createTransportFailure())
    await waitForRenderedWork()

    expect(getPaneStatus()).toHaveTextContent(failure)
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("disables Add server once the most servers the settings allow are saved, and says so", async () => {
    startSettingsHost()
    const { useLysStore } = await startMcpPane()
    const servers = Array.from({ length: 16 }, (_, index) =>
      mcpServerSettingsSchema.parse({
        name: `server-${index}`,
        transport: "stdio",
        command: "/usr/bin/server"
      })
    )

    useLysStore.setState({
      settings: { ...STORED_SETTINGS, mcp: { servers } }
    })
    await waitForRenderedWork()

    expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled()
    expect(
      screen.getByText("Lys keeps up to 16 servers. Remove one to add another.")
    ).toBeInTheDocument()
  })

  it("warns while the servers' tools are not offered, and opens the Tools pane", async () => {
    startSettingsHost()
    const { useLysStore, useToolStore } = await startMcpPane()
    const user = userEvent.setup()

    expect(screen.queryByText(/nothing from (them|here) is offered/)).toBeNull()

    useToolStore.getState().updateToolCallsOn(false)
    await waitForRenderedWork()

    expect(
      screen.getByText(
        "Tool calls are off · servers stay connected, nothing from them is offered"
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open Tools" }))

    expect(useLysStore.getState().settingsPane).toBe("tools")
  })

  it("warns that a model not trained for tool calls is offered nothing from the servers", async () => {
    startSettingsHost()
    await startMcpPane({}, READY_RUNTIME)

    expect(
      screen.getByText(
        "qwen3-8b isn't trained for tool calls · nothing from here is offered"
      )
    ).toBeInTheDocument()
  })

  it("reads the tools once when the backend runs and none were read", async () => {
    const host = startSettingsHost()
    const { backend, useToolStore } = await startMcpPane()

    expect(
      backend.requests.filter((request) => request.routeKey === TOOLS_ROUTE)
    ).toHaveLength(1)
    expect(
      host.commands.filter((invoked) => invoked.command === "list_tools")
    ).toHaveLength(1)
    expect(useToolStore.getState().list.status).toBe("loaded")
  })

  it("reports a failed save of a tool choice, keeping the choice, and saves again on Retry saving", async () => {
    let isDiskFull = true
    const host = startSettingsHost(() =>
      isDiskFull ? Promise.reject("Disk full") : null
    )
    await startMcpPane()
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    const saveStatus = screen.getByRole("status", {
      name: "Tool choices save"
    })
    const approval = within(files).getByRole("group", {
      name: "Before its tools run"
    })

    await user.click(within(approval).getByRole("button", { name: "Just run" }))
    await waitForRenderedWork()

    expect(screen.getByRole("status", { name: "Tool choices save" })).toBe(
      saveStatus
    )
    expect(saveStatus).toHaveTextContent(
      "Couldn't save your tool choices. Each switch applies until Lys quits, but Just run keeps following the choices Lys last saved until a save works."
    )
    expect(
      within(approval).getByRole("button", { name: "Just run" })
    ).toHaveAttribute("aria-pressed", "true")
    isDiskFull = false
    await user.click(screen.getByRole("button", { name: "Retry saving" }))
    await waitForRenderedWork()

    expect(listWrittenDocuments(host.commands).at(-1)).toEqual({
      ...STORED_SETTINGS_DOCUMENT,
      tools: {
        ...STORED_SETTINGS_DOCUMENT.tools,
        justRun: [
          ...STORED_SETTINGS_DOCUMENT.tools.justRun,
          ...FILES_TOOLS.map((tool) => tool.name)
        ]
      }
    })
    expect(saveStatus).toHaveTextContent(/^$/)
    expect(screen.queryByRole("button", { name: "Retry saving" })).toBeNull()
  })

  it("moves focus to Edit once when its editor closes, not each time the row is expanded again", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    await user.click(within(files).getByRole("button", { name: "Edit files" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    const afterClose = document.activeElement

    await user.click(getServerToggle("files"))
    await user.click(getServerToggle("files"))

    expect(afterClose).toHaveAccessibleName("Edit files")
    expect(getServerToggle("files")).toHaveAttribute("aria-expanded", "true")
    expect(getServerToggle("files")).toHaveFocus()
  })

  it("keeps another server's details and focus when a removal is saved after the person moved on", async () => {
    const write = createControlledPromise<unknown>()
    startSettingsHost(() => write.promise)
    await startMcpPane({
      [SYNC_ROUTE]: answerList(buildMcpServerList([STORED_LIST.servers[1]]))
    })
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    await user.click(
      within(files).getByRole("button", { name: "Remove files" })
    )
    await user.click(
      within(within(files).getByRole("group", { name: /^remove / })).getByRole(
        "button",
        { name: "Remove files" }
      )
    )

    await user.click(getServerToggle("notes"))
    write.resolve(null)
    await waitForRenderedWork()

    expect(
      within(screen.getByRole("list", { name: "MCP servers" })).queryByRole(
        "listitem",
        { name: "files" }
      )
    ).toBeNull()
    expect(getServerToggle("notes")).toHaveAttribute("aria-expanded", "true")
    expect(getServerToggle("notes")).toHaveFocus()
  })

  it("closes a removed server's details, so it shows collapsed when it is saved again", async () => {
    startSettingsHost()
    const { useLysStore } = await startMcpPane({
      [SYNC_ROUTE]: answerList(buildMcpServerList([STORED_LIST.servers[1]]))
    })
    const user = userEvent.setup()
    await expandServer(user, "files")

    await removeServer(user, "files")
    act(() => useLysStore.setState({ settings: STORED_SETTINGS }))

    expect(getServerToggle("files")).toHaveAttribute("aria-expanded", "false")
  })

  it("disables the approval of a server that lists no tool, saying its tools then follow their saved choices", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    const notes = await expandServer(user, "notes")

    const approval = within(notes).getByRole("group", {
      name: "Before its tools run"
    })
    expect(approval).toHaveAccessibleDescription(
      "You can choose once it lists its tools. Each then follows the choice saved for it, and a tool without one asks first."
    )
    for (const name of ["Ask me", "Just run"]) {
      expect(within(approval).getByRole("button", { name })).toBeDisabled()
    }
  })

  it("changes and saves nothing when the chosen approval is pressed again", async () => {
    const host = startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()
    const files = await expandServer(user, "files")
    const approval = within(files).getByRole("group", {
      name: "Before its tools run"
    })

    await user.click(within(approval).getByRole("button", { name: "Ask me" }))
    await waitForRenderedWork()

    expect(
      within(approval).getByRole("button", { name: "Ask me" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(listWrittenDocuments(host.commands)).toEqual([])
  })
})
