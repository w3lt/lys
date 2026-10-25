import type { McpServerName, McpServerSettings } from "@lys/share"
import { useEffect, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import { useLysStore } from "@/lib/store"
import {
  useMcpServerStore,
  type McpServerListState
} from "@/lib/store/mcp-servers"
import type { ToolApproval } from "@/lib/store/tool-settings"
import { useToolStore } from "@/lib/store/tools"

import { McpServerEditor, type McpEditorTarget } from "./McpServerEditor"
import {
  McpServerSection,
  McpToolOfferWarning,
  type McpServerListFocusTarget
} from "./McpServerList"
import {
  findMcpPaneRetry,
  formatMcpToolOfferWarning,
  listMcpPaneNotes,
  type McpPaneNote
} from "./mcp-presentation"

/** Focus target that leaves focus where it is. */
const NO_FOCUS_TARGET: McpServerListFocusTarget = Object.freeze({
  kind: "none"
})

/**
 * Calculates the list control that takes focus when the list returns from
 * an editor that closes without saving.
 *
 * @param editor - Editor that closes.
 * @returns A new request for the edited server's Edit button, or for Add
 * server after a new server's editor.
 */
function calculateEditorReturnTarget(
  editor: McpEditorTarget
): McpServerListFocusTarget {
  return editor.kind === "server"
    ? { kind: "server", serverName: editor.server.name }
    : { kind: "add-server" }
}

/**
 * Builds the server list after saving one server.
 *
 * @param servers - Saved servers, in list order.
 * @param server - Server to save.
 * @param editor - Editor the server comes from.
 * @returns The list with the edited server replaced in place, or the new
 * server added at the end.
 */
function buildServersWithSaved(
  servers: readonly McpServerSettings[],
  server: McpServerSettings,
  editor: McpEditorTarget
): readonly McpServerSettings[] {
  if (editor.kind === "new") return [...servers, server]
  return servers.map((saved) =>
    saved.name === editor.server.name ? server : saved
  )
}

/**
 * Lists the names of the saved servers other than the one being edited.
 *
 * @param servers - Saved servers.
 * @param editor - Editor the names are checked for.
 * @returns The names a new or renamed server may not take.
 */
function listOtherServerNames(
  servers: readonly McpServerSettings[],
  editor: McpEditorTarget
): ReadonlySet<string> {
  const editedName = editor.kind === "server" ? editor.server.name : undefined
  return new Set(
    servers.map((server) => server.name).filter((name) => name !== editedName)
  )
}

/** Properties accepted by {@link McpPaneStatus}. */
type McpPaneStatusProps = {
  /** Notes to show, in order, one of each kind; empty while nothing needs saying. */
  readonly notes: readonly McpPaneNote[]
  /**
   * Requests that the parent send again what failed; omitted when nothing
   * can be sent again, which removes the Retry button.
   */
  readonly onRetry?: () => void
}

/**
 * Says what the backend's answers and the latest save mean for the servers,
 * offering a retry when one can help.
 *
 * @remarks The parent owns the sentences and what Retry sends, and keeps the
 * component mounted while the pane is shown, so it is one polite status,
 * named MCP status, that exists before every change it announces; it takes
 * no space while it is empty. Pressing Retry moves focus to the status
 * first, because Retry leaves while its request runs.
 * @param props - Sentences and the optional parent-owned retry.
 * @returns The status lines and any Retry button.
 */
function McpPaneStatus({ notes, onRetry }: McpPaneStatusProps): ReactElement {
  const statusRef = useRef<HTMLDivElement>(null)

  /** Sends the retry, keeping focus in the status while Retry leaves. */
  function handleRetry(): void {
    statusRef.current?.focus()
    onRetry?.()
  }

  return (
    <div className="settings-view__mcp-status">
      <div
        aria-label="MCP status"
        aria-live="polite"
        ref={statusRef}
        role="status"
        tabIndex={-1}
      >
        {notes.map((note) => (
          <p className="settings-view__note" key={note.kind}>
            {note.text}
          </p>
        ))}
      </div>
      {onRetry === undefined ? null : (
        <Button onClick={handleRetry} type="button" variant="outline">
          Retry
        </Button>
      )}
    </div>
  )
}

/**
 * Warns, while servers are saved, when their tools are not offered to the
 * model, with a way to the Tools pane.
 *
 * @remarks The tool store owns whether tool calls are on, and the
 * application store owns the model state and which settings pane is shown;
 * the component owns no state. The warning shows while tool calls are off,
 * or while the loaded model is not trained for tool use; Open Tools selects
 * the Tools pane.
 * @returns The warning, or null while the tools are offered.
 */
function McpToolOfferNotice(): ReactElement | null {
  const areToolCallsOn = useToolStore((state) => state.areToolCallsOn)
  const modelRuntime = useLysStore((state) => state.modelRuntime)
  const modelInventory = useLysStore((state) => state.modelInventory)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const text = formatMcpToolOfferWarning(
    areToolCallsOn,
    calculateToolModelSupport(modelRuntime, modelInventory)
  )

  if (text === "") return null
  return (
    <McpToolOfferWarning
      onOpenTools={() => setSettingsPane("tools")}
      text={text}
    />
  )
}

/** Properties accepted by {@link McpServerListView}. */
type McpServerListViewProps = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Name of the server whose details are shown, or null when none is. */
  readonly expandedServerName: McpServerName | null
  /** Control that takes focus when the list appears. */
  readonly focusTarget: McpServerListFocusTarget
  /** Proposes showing one server's details, or none with null. */
  readonly onExpandedServerNameChange: (
    serverName: McpServerName | null
  ) => void
  /** Requests that the parent open an editor in place of the list. */
  readonly onOpenEditor: (editor: McpEditorTarget) => void
  /** Reports to the parent that the removal of a server was saved. */
  readonly onRemoveServerComplete: () => void
}

/**
 * Presents the saved servers with their states, tools, and actions.
 *
 * @remarks The application store owns the saved servers, their save, and
 * the tool switches and approvals, which it saves as each changes; the MCP
 * server store owns the reconnect and the save that applies the list; the
 * tool store owns the list of tools. The parent owns the list's states,
 * which server's details are shown, which editor opens, and the focus
 * target. A server's approval sets every listed tool of the server. A
 * server is removed once its removal is saved, which the parent is told.
 * @param props - Backend status, the list, expansion, focus, and the
 * parent-owned changes.
 * @returns The warning, when one is due, and the section of the saved
 * servers.
 */
function McpServerListView({
  isBackendRunning,
  list,
  expandedServerName,
  focusTarget,
  onExpandedServerNameChange,
  onOpenEditor,
  onRemoveServerComplete
}: McpServerListViewProps): ReactElement {
  const servers = useLysStore((state) => state.settings.mcp.servers)
  const isSaving = useLysStore(
    (state) => state.mcpSettingsSave.status === "saving"
  )
  const toolSettings = useLysStore((state) => state.settings.tools)
  const updateToolOn = useLysStore((state) => state.updateToolOn)
  const updateToolApproval = useLysStore((state) => state.updateToolApproval)
  const toolList = useToolStore((state) => state.list)
  const reconnectMcpServer = useMcpServerStore(
    (state) => state.reconnectMcpServer
  )
  const saveMcpServers = useMcpServerStore((state) => state.saveMcpServers)

  /**
   * Removes one server and, once saved, tells the parent.
   *
   * @param serverName - Name of the server to remove.
   */
  async function handleRemoveServer(serverName: McpServerName): Promise<void> {
    const outcome = await saveMcpServers(
      servers.filter((server) => server.name !== serverName)
    )
    if (outcome === "saved") onRemoveServerComplete()
  }

  /**
   * Proposes one approval for several tools, which the store saves.
   *
   * @param toolNames - Names of the tools.
   * @param approval - Approval for each of them.
   */
  function handleToolApprovalChange(
    toolNames: readonly string[],
    approval: ToolApproval
  ): void {
    for (const toolName of toolNames) updateToolApproval(toolName, approval)
  }

  return (
    <>
      {servers.length === 0 ? null : <McpToolOfferNotice />}
      <McpServerSection
        expandedServerName={expandedServerName}
        focusTarget={focusTarget}
        isBackendRunning={isBackendRunning}
        isSaving={isSaving}
        list={list}
        onAddServer={(transport) => onOpenEditor({ kind: "new", transport })}
        onEditServer={(server) => onOpenEditor({ kind: "server", server })}
        onExpandedServerNameChange={onExpandedServerNameChange}
        onReconnectServer={(serverName) => void reconnectMcpServer(serverName)}
        onRemoveServer={(serverName) => void handleRemoveServer(serverName)}
        onToolApprovalChange={handleToolApprovalChange}
        onToolOnChange={updateToolOn}
        servers={servers}
        toolList={toolList}
        toolSettings={toolSettings}
      />
    </>
  )
}

/** Properties accepted by {@link McpServerEditorView}. */
type McpServerEditorViewProps = {
  /** What the editor is open for. */
  readonly editor: McpEditorTarget
  /** Requests that the parent close the editor without saving. */
  readonly onClose: () => void
  /** Reports to the parent that the server was saved under a name. */
  readonly onSaveServerComplete: (serverName: McpServerName) => void
}

/**
 * Presents the editor of one server and saves what it holds.
 *
 * @remarks The application store owns the saved servers and their save; the
 * MCP server store owns the save that applies the list. The parent owns
 * which server is open and closes the editor. An edited server keeps its
 * place in the list; a new one is added at the end. The draft is checked
 * against the names of the other saved servers.
 * @param props - Open editor and the parent-owned close and save report.
 * @returns The server's editor.
 */
function McpServerEditorView({
  editor,
  onClose,
  onSaveServerComplete
}: McpServerEditorViewProps): ReactElement {
  const servers = useLysStore((state) => state.settings.mcp.servers)
  const saveState = useLysStore((state) => state.mcpSettingsSave)
  const saveMcpServers = useMcpServerStore((state) => state.saveMcpServers)

  /**
   * Saves the edited server and reports it once saved.
   *
   * @param server - Valid server from the editor.
   */
  async function handleSaveServer(server: McpServerSettings): Promise<void> {
    const outcome = await saveMcpServers(
      buildServersWithSaved(servers, server, editor)
    )
    if (outcome === "saved") onSaveServerComplete(server.name)
  }

  return (
    <McpServerEditor
      onClose={onClose}
      onSaveServer={(server) => void handleSaveServer(server)}
      otherServerNames={listOtherServerNames(servers, editor)}
      saveState={saveState}
      target={editor}
    />
  )
}

/** Properties accepted by {@link McpPaneStatusView}. */
type McpPaneStatusViewProps = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Whether the editor is open, which shows a failed save itself. */
  readonly isEditing: boolean
}

/**
 * Says what the backend's answers and the latest save mean for the
 * servers, and sends again what failed when asked.
 *
 * @remarks The application store owns the latest save; the MCP server store
 * owns the latest sync or reconnect failure, the read, and the sync. The
 * parent owns the list, the backend's status, and whether the editor is
 * open. Retry sends the sync when that failed, or else the read.
 * @param props - Backend status, the list, and whether the editor is open.
 * @returns The pane's status.
 */
function McpPaneStatusView({
  isBackendRunning,
  list,
  isEditing
}: McpPaneStatusViewProps): ReactElement {
  const saveState = useLysStore((state) => state.mcpSettingsSave)
  const actionFailure = useMcpServerStore((state) => state.actionFailure)
  const loadMcpServers = useMcpServerStore((state) => state.loadMcpServers)
  const syncMcpServers = useMcpServerStore((state) => state.syncMcpServers)
  const facts = { isBackendRunning, list, actionFailure, saveState, isEditing }
  const retry = findMcpPaneRetry(facts)

  /** Sends again what failed: the sync, or else the read. */
  function handleRetry(): void {
    if (retry === "sync") void syncMcpServers()
    else void loadMcpServers()
  }

  return (
    <McpPaneStatus
      notes={listMcpPaneNotes(facts)}
      onRetry={retry === undefined ? undefined : handleRetry}
    />
  )
}

/**
 * Reads the servers' states each time the pane appears while the backend
 * runs, or the backend starts while it is shown, and the tools when they
 * were never read.
 *
 * @remarks The MCP server store and the tool store own their reads, which
 * continue if the pane is left; the tool store keeps the tools in step with
 * the MCP servers once read. Reading the states again on each appearance
 * shows a connection that ended since the last read. While the backend is
 * stopped, nothing is read. The hook returns nothing; the stores publish
 * what the reads find.
 * @param isBackendRunning - Whether the backend is running; reactive.
 */
function useMcpPaneReads(isBackendRunning: boolean): void {
  const loadMcpServers = useMcpServerStore((state) => state.loadMcpServers)
  const isToolListIdle = useToolStore((state) => state.list.status === "idle")
  const loadTools = useToolStore((state) => state.loadTools)

  useEffect(() => {
    if (isBackendRunning) void loadMcpServers()
  }, [isBackendRunning, loadMcpServers])

  useEffect(() => {
    if (isBackendRunning && isToolListIdle) void loadTools()
  }, [isBackendRunning, isToolListIdle, loadTools])
}

/**
 * Presents the MCP pane: the saved MCP servers with each one's state and
 * tools, and the editor that adds or changes one.
 *
 * @remarks The application store owns the saved servers, their save, and
 * the backend's status; the MCP server store owns the backend's states of
 * the servers. The pane owns which server the editor is open for, at most
 * one, which replaces the list while open, which server's details are
 * shown, and which list control takes focus when the list returns. After a
 * save, or after closing a saved server's editor, that server's details
 * show and its Edit button takes focus; closing a new server's editor, or
 * removing a server, moves focus to Add server. The servers are listed from
 * the settings whether or not the backend runs, and can be edited either
 * way. Each time the pane appears while the backend runs, or the backend
 * starts while it is shown, it reads the states, and it reads the tools
 * once; while a server connects, the application shell reads the states
 * again every second. A status line stays mounted above the list; while the
 * editor is open, the editor shows a failed save itself. Each editor is a
 * separate instance, keyed by the server's name; a new server's editor is
 * keyed `:new`, which no name can take. The pane accepts no props and is
 * loaded lazily by the settings view.
 * @returns The MCP pane body.
 */
export default function McpPane(): ReactElement {
  const isBackendRunning = useLysStore(
    (state) => state.backendServerInfo.status === "running"
  )
  const list = useMcpServerStore((state) => state.list)
  const [editor, setEditor] = useState<McpEditorTarget | null>(null)
  const [expandedServerName, setExpandedServerName] =
    useState<McpServerName | null>(null)
  const [focusTarget, setFocusTarget] = useState(NO_FOCUS_TARGET)

  useMcpPaneReads(isBackendRunning)

  /**
   * Closes the editor, shows a server's details, and moves focus to a list
   * control.
   *
   * @param target - Control that takes focus when the list returns; a
   * server's Edit button also shows that server's details.
   */
  function closeEditor(target: McpServerListFocusTarget): void {
    if (target.kind === "server") setExpandedServerName(target.serverName)
    setFocusTarget(target)
    setEditor(null)
  }

  /** Collapses the removed server's details and moves focus to Add server. */
  function handleRemoveServerComplete(): void {
    setExpandedServerName(null)
    setFocusTarget({ kind: "add-server" })
  }

  return (
    <div className="settings-view__mcp-pane">
      <McpPaneStatusView
        isBackendRunning={isBackendRunning}
        isEditing={editor !== null}
        list={list}
      />
      {editor === null ? (
        <McpServerListView
          expandedServerName={expandedServerName}
          focusTarget={focusTarget}
          isBackendRunning={isBackendRunning}
          list={list}
          onExpandedServerNameChange={setExpandedServerName}
          onOpenEditor={setEditor}
          onRemoveServerComplete={handleRemoveServerComplete}
        />
      ) : (
        <McpServerEditorView
          editor={editor}
          key={editor.kind === "server" ? editor.server.name : ":new"}
          onClose={() => closeEditor(calculateEditorReturnTarget(editor))}
          onSaveServerComplete={(serverName) =>
            closeEditor({ kind: "server", serverName })
          }
        />
      )}
    </div>
  )
}
