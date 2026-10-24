import type { McpServerList } from "@lys/protocol"
import { mcpServerSettingsSchema } from "@lys/share"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
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

/** Route key of the list read. */
const LIST_ROUTE = "GET /api/v1/mcp/servers"

/** Route key of the sync. */
const SYNC_ROUTE = "POST /api/v1/mcp/servers/sync"

/** Route key of a reconnect of the `notes` server. */
const RECONNECT_NOTES_ROUTE = "POST /api/v1/mcp/servers/notes/reconnect"

/** Both stored servers: the command server connected, the URL one refused. */
const STORED_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(3)),
  buildMcpServerStatus("notes", "http", buildFailedMcpState("unauthorized"))
])

/** Saved values that can be secrets, which the list never shows. */
const SECRET_VALUES = ["debug", "Bearer fixture-0000"]

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
 * Starts a native host holding the stored settings document, whose writes
 * succeed or fail as the case says.
 *
 * @param saveSettings - Answer of every write; succeeds by default.
 * @returns The host observation handle.
 */
function startSettingsHost(saveSettings: () => unknown = () => null) {
  return startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: saveSettings
  })
}

/**
 * Renders the settings view on the MCP pane, with the stored settings in the
 * application store, and waits for the pane body and its first read.
 *
 * @param routes - Backend routes the case needs besides the inventory read;
 * the stored list answers the list read unless the case declares it.
 * @param runtime - Backend, LM Studio, and model facts.
 * @returns The stores and the backend observation handle.
 */
async function startMcpPane(
  routes: BackendRoutes = {},
  runtime: RuntimeArrangement = READY_RUNTIME
) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    [LIST_ROUTE]: answerList(STORED_LIST),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "mcp",
    runtime
  )
  const { useMcpServerStore } = await import("@/lib/store/mcp-servers")
  useLysStore.setState({ settings: STORED_SETTINGS })
  render(<SettingsView onDone={vi.fn()} />)
  // The closing note is withheld until the lazily loaded pane body is shown.
  await screen.findByText(/^Saved in settings\.json in Lys's home folder/)
  await waitForRenderedWork()
  return { useLysStore, useMcpServerStore, backend }
}

/**
 * Lists the route keys of the backend requests other than the inventory
 * read, in arrival order.
 *
 * @param backend - Backend observation handle.
 * @returns The route keys.
 */
function listMcpRouteKeys(backend: BackendFake): string[] {
  return backend.requests
    .map((request) => request.routeKey)
    .filter((routeKey) => routeKey !== INVENTORY_ROUTE)
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
 * Gets the pane's status line, which speaks for the servers as a whole.
 *
 * @returns The status named MCP status.
 */
function getPaneStatus(): HTMLElement {
  return screen.getByRole("status", { name: "MCP status" })
}

/**
 * Removes one saved server through its row, confirming the removal, and
 * waits for the save.
 *
 * @param user - User-event session of the case.
 * @param serverName - Name of the server to remove.
 */
async function removeServer(
  user: ReturnType<typeof userEvent.setup>,
  serverName: string
): Promise<void> {
  await user.click(
    within(getServerRow(serverName)).getByRole("button", {
      name: `Remove ${serverName}`
    })
  )
  await user.click(
    within(
      screen.getByRole("group", { name: `Remove ${serverName}?` })
    ).getByRole("button", { name: `Remove ${serverName}` })
  )
  await waitForRenderedWork()
}

describe("McpPaneContent", () => {
  it("lists the saved servers with how Lys reaches them and their state, never a secret", async () => {
    startSettingsHost()
    const { backend } = await startMcpPane()

    expect(
      screen.getByRole("heading", { level: 1, name: "MCP" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Servers that give the agents more tools. Each runs as you, so add only servers you trust."
      )
    ).toBeInTheDocument()
    const section = screen.getByRole("region", { name: "servers" })
    expect(section).toHaveTextContent("2 of 16")
    const files = getServerRow("files")
    expect(files).toHaveTextContent("Command")
    expect(files).toHaveTextContent(
      "/opt/homebrew/bin/npx -y @modelcontextprotocol/server-filesystem /tmp"
    )
    expect(files).toHaveTextContent("Connected · 3 tools")
    const notes = getServerRow("notes")
    expect(notes).toHaveTextContent("URL")
    expect(notes).toHaveTextContent("https://mcp.example.test/notes")
    expect(notes).toHaveTextContent(
      "Failed: The server refused the request. Check the headers, such as Authorization."
    )
    for (const secret of SECRET_VALUES) {
      expect(section).not.toHaveTextContent(secret)
    }
    expect(listMcpRouteKeys(backend)).toEqual([LIST_ROUTE])
  })

  it("lists the saved servers without state while the backend is not running, and asks nothing of it", async () => {
    startSettingsHost()
    const { backend } = await startMcpPane(
      {},
      buildUnreachableRuntime("stopped")
    )

    expect(getPaneStatus()).toHaveTextContent(
      "Start the backend in Settings → Runtime to connect to MCP servers."
    )
    expect(getServerRow("files")).not.toHaveTextContent("Connected")
    expect(
      within(getServerRow("files")).getByRole("status")
    ).toBeEmptyDOMElement()
    expect(
      within(getServerRow("files")).getByRole("button", {
        name: "Reconnect files"
      })
    ).toBeDisabled()
    expect(
      within(getServerRow("files")).getByRole("button", { name: "Edit files" })
    ).toBeEnabled()
    expect(backend.requests).toEqual([])
  })

  it("says so when no server is saved", async () => {
    startSettingsHost()
    const { useLysStore } = await startMcpPane({
      [LIST_ROUTE]: answerList(buildMcpServerList([]))
    })

    useLysStore.setState({
      settings: { ...STORED_SETTINGS, mcp: { servers: [] } }
    })
    await waitForRenderedWork()

    expect(
      screen.getByText(
        "No MCP servers yet. Add one to give the agents its tools."
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "MCP servers" })).toBeNull()
  })

  it("adds a command server, applies the saved list, and focuses the new server", async () => {
    const host = startSettingsHost()
    const syncedList = buildMcpServerList([
      ...STORED_LIST.servers,
      buildMcpServerStatus("tools", "stdio", CONNECTING_MCP_STATE)
    ])
    const { backend, useLysStore } = await startMcpPane({
      [SYNC_ROUTE]: answerList(syncedList)
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    const form = screen.getByRole("form", { name: "New MCP server" })
    expect(within(form).getByLabelText("Name")).toHaveFocus()
    await user.type(within(form).getByLabelText("Name"), "tools")
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.type(
      within(form).getByLabelText("Arguments"),
      "--stdio{Enter}--quiet"
    )
    await user.type(
      within(form).getByLabelText("Environment"),
      "TOKEN=fixture-1111"
    )
    await user.click(within(form).getByRole("button", { name: "Save" }))
    await waitForRenderedWork()

    const added = mcpServerSettingsSchema.parse({
      name: "tools",
      transport: "stdio",
      command: "/usr/bin/tools",
      arguments: ["--stdio", "--quiet"],
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
    expect(getServerRow("tools")).toHaveTextContent("Connecting…")
    expect(
      within(getServerRow("tools")).getByRole("button", { name: "Edit tools" })
    ).toHaveFocus()
  })

  it("shows each field's first problem on Save, focuses a summary that leads to each, and saves nothing", async () => {
    const host = startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    const form = screen.getByRole("form", { name: "New MCP server" })
    await user.type(within(form).getByLabelText("Name"), "files")
    await user.type(within(form).getByLabelText("Environment"), "VERBOSE")
    await user.click(within(form).getByRole("button", { name: "Save" }))

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
      "Environment: Line 1: write each variable as NAME=value."
    ])
    const name = within(form).getByLabelText("Name")
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription(
      "up to 20 characters: lowercase letters and digits, joined by single hyphens Another MCP server already has this name."
    )
    const command = within(form).getByRole("textbox", { name: "Command" })
    expect(command).toHaveAccessibleDescription(
      "full path, such as /opt/homebrew/bin/npx Enter the command that starts the server, up to 1024 characters."
    )
    expect(within(form).getByLabelText("Arguments")).toHaveAttribute(
      "aria-invalid",
      "false"
    )

    await user.click(
      within(summary).getByRole("button", {
        name: "Command: Enter the command that starts the server, up to 1024 characters."
      })
    )

    expect(command).toHaveFocus()
    expect(within(form).getByLabelText("Name")).toHaveValue("files")
    expect(listWrittenDocuments(host.commands)).toEqual([])
  })

  it("focuses the only field with a problem on Save, without a summary", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    const form = screen.getByRole("form", { name: "New MCP server" })
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.click(within(form).getByRole("button", { name: "Save" }))

    expect(within(form).getByLabelText("Name")).toHaveFocus()
    expect(within(form).queryByRole("group", { name: /^Fix / })).toBeNull()
  })

  it("marks the required fields and states the name rule before entry", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    const form = screen.getByRole("form", { name: "New MCP server" })
    const name = within(form).getByLabelText("Name")

    expect(name).toBeRequired()
    expect(name).toHaveAccessibleDescription(
      "up to 20 characters: lowercase letters and digits, joined by single hyphens"
    )
    expect(
      within(form).getByRole("textbox", { name: "Command" })
    ).toBeRequired()
    expect(within(form).getByLabelText("Arguments")).not.toBeRequired()
    expect(within(form).getByLabelText("Environment")).not.toBeRequired()
    expect(within(form).getAllByText("required")).toHaveLength(2)

    await user.click(within(form).getByRole("radio", { name: "URL" }))

    expect(within(form).getByRole("textbox", { name: "URL" })).toBeRequired()
    expect(within(form).getByLabelText("Headers")).not.toBeRequired()
    expect(within(form).getAllByText("required")).toHaveLength(2)
  })

  it("updates a problem as the person types after the first Save", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    const form = screen.getByRole("form", { name: "New MCP server" })
    await user.click(within(form).getByRole("button", { name: "Save" }))
    await user.type(within(form).getByLabelText("Name"), "fresh")

    expect(within(form).getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "false"
    )
    expect(
      within(form).getByRole("textbox", { name: "Command" })
    ).toHaveAttribute("aria-invalid", "true")
  })

  it("edits a URL server in place, keeping its place in the list", async () => {
    const host = startSettingsHost()
    const { backend } = await startMcpPane({
      [SYNC_ROUTE]: answerList(STORED_LIST)
    })
    const user = userEvent.setup()

    await user.click(
      within(getServerRow("notes")).getByRole("button", { name: "Edit notes" })
    )
    const form = screen.getByRole("form", { name: "notes" })
    expect(within(form).getByRole("textbox", { name: "URL" })).toHaveValue(
      "https://mcp.example.test/notes"
    )
    expect(within(form).getByLabelText("Headers")).toHaveValue(
      "Authorization: Bearer fixture-0000"
    )
    expect(within(form).getByRole("radio", { name: "URL" })).toBeChecked()
    const url = within(form).getByRole("textbox", { name: "URL" })
    await user.clear(url)
    await user.type(url, "http://localhost:7000/mcp{Enter}")
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
    expect(
      within(getServerRow("notes")).getByRole("button", { name: "Edit notes" })
    ).toHaveFocus()
  })

  it("keeps what was typed for the other transport when switching back", async () => {
    startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Add server" }))
    const form = screen.getByRole("form", { name: "New MCP server" })
    await user.type(
      within(form).getByRole("textbox", { name: "Command" }),
      "/usr/bin/tools"
    )
    await user.click(within(form).getByRole("radio", { name: "URL" }))

    expect(within(form).queryByRole("textbox", { name: "Command" })).toBeNull()
    expect(within(form).getByLabelText("Headers")).toBeInTheDocument()

    await user.click(within(form).getByRole("radio", { name: "Command" }))

    expect(within(form).getByRole("textbox", { name: "Command" })).toHaveValue(
      "/usr/bin/tools"
    )
  })

  it("closes an editor on Cancel or Escape without saving, returning focus to its opener", async () => {
    const host = startSettingsHost()
    await startMcpPane()
    const user = userEvent.setup()

    await user.click(
      within(getServerRow("files")).getByRole("button", { name: "Edit files" })
    )
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
    expect(listWrittenDocuments(host.commands)).toEqual([])
  })

  it("asks before removing a server, keeps it on Escape, and removes it on Remove", async () => {
    const host = startSettingsHost()
    const { backend } = await startMcpPane({
      [SYNC_ROUTE]: answerList(buildMcpServerList([STORED_LIST.servers[1]]))
    })
    const user = userEvent.setup()

    await user.click(
      within(getServerRow("files")).getByRole("button", {
        name: "Remove files"
      })
    )
    const question = screen.getByRole("group", { name: "Remove files?" })
    expect(
      within(question).getByRole("button", { name: "Keep files" })
    ).toHaveFocus()
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("group", { name: "Remove files?" })).toBeNull()
    const remove = within(getServerRow("files")).getByRole("button", {
      name: "Remove files"
    })
    expect(remove).toHaveFocus()
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

    await user.click(
      within(getServerRow("files")).getByRole("button", { name: "Edit files" })
    )
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

    const state = within(getServerRow("notes")).getByRole("status")
    expect(state).toHaveAttribute("aria-atomic", "true")
    expect(state).toHaveTextContent(
      "notes: Failed: The server refused the request. Check the headers, such as Authorization."
    )
    await user.click(
      within(getServerRow("notes")).getByRole("button", {
        name: "Reconnect notes"
      })
    )
    await waitForRenderedWork()

    expect(listMcpRouteKeys(backend)).toEqual([
      LIST_ROUTE,
      RECONNECT_NOTES_ROUTE
    ])
    // The row's own status, there before the change, says the new state.
    expect(within(getServerRow("notes")).getByRole("status")).toBe(state)
    expect(state).toHaveTextContent("notes: Connected · 1 tool")
  })

  it("says a saved server the backend has not applied is not applied", async () => {
    startSettingsHost()
    await startMcpPane({
      [LIST_ROUTE]: answerList(buildMcpServerList([STORED_LIST.servers[0]]))
    })

    expect(getServerRow("notes")).toHaveTextContent(
      "Not applied. Reconnect applies the saved servers."
    )
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
    expect(getServerRow("files")).toHaveTextContent("Connected · 3 tools")

    await user.click(screen.getByRole("tab", { name: /^Generation\s*03$/ }))
    await user.click(screen.getByRole("tab", { name: /^MCP\s*06$/ }))
    await screen.findByText(/^Saved in settings\.json in Lys's home folder/)
    await waitForRenderedWork()

    expect(getServerRow("files")).toHaveTextContent(
      "Failed: The server closed the connection."
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
    expect(getServerRow("files")).not.toHaveTextContent("Connected")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitForRenderedWork()

    expect(getPaneStatus()).toHaveFocus()
    expect(getPaneStatus()).toHaveTextContent("")
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(getServerRow("files")).toHaveTextContent("Connected · 3 tools")
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
    const files = getServerRow("files")
    const toggle = within(files).getByRole("button", {
      name: "Skipped tools of files"
    })

    expect(files).toHaveTextContent("Connected · 2 tools · 2 skipped")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(files).not.toHaveTextContent("(no name)")

    await user.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(files).toHaveTextContent(
      "(no name)Its name is empty or too long to offer to a model."
    )
    expect(files).toHaveTextContent(
      "deepIts input schema isn't one Lys can offer to a model."
    )
    expect(files).toHaveTextContent(
      "The server lists more tools than Lys reads. Lys reads the first 128."
    )
    expect(getServerRow("notes")).not.toHaveTextContent("Skipped tools")
  })

  it("names each row's actions after its server, starting with their visible text", async () => {
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
    const files = getServerRow("files")

    for (const [name, text] of [
      ["Reconnect files", "Reconnect"],
      ["Edit files", "Edit"],
      ["Remove files", "Remove"],
      ["Skipped tools of files", "Skipped tools"]
    ]) {
      expect(within(files).getByRole("button", { name })).toHaveTextContent(
        text
      )
    }
    expect(
      within(getServerRow("notes")).getByRole("button", { name: "Edit notes" })
    ).toBeInTheDocument()

    await user.click(
      within(files).getByRole("button", { name: "Remove files" })
    )
    const question = screen.getByRole("group", { name: "Remove files?" })

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
    const failure = "Lys couldn't ask its backend to apply the MCP servers."

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

  it("disables Add server once the most servers the settings allow are saved", async () => {
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

    expect(screen.getByRole("region", { name: "servers" })).toHaveTextContent(
      "16 of 16"
    )
    expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled()
  })
})
