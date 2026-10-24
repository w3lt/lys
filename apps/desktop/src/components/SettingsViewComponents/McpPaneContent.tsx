import type { McpServerName, McpServerSettings } from "@lys/share"
import { useEffect, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { useLysStore } from "@/lib/store"
import {
  useMcpServerStore,
  type McpServerListState
} from "@/lib/store/mcp-servers"

import { McpServerEditor } from "./McpServerEditor"
import {
  McpServerSection,
  type McpServerListFocusTarget
} from "./McpServerList"
import {
  findMcpPaneRetry,
  listMcpPaneNotes,
  type McpPaneNote
} from "./mcp-presentation"

/** Server the editor is open for. */
type McpEditorTarget =
  | {
      /** The editor is open for a new server. */
      readonly kind: "new"
    }
  | {
      /** The editor is open for one saved server. */
      readonly kind: "server"
      /** Saved name of that server. */
      readonly serverName: McpServerName
    }

/** Editor target of a new server. */
const NEW_SERVER_EDITOR: McpEditorTarget = Object.freeze({ kind: "new" })

/** Focus target that leaves focus where it is. */
const NO_FOCUS_TARGET: McpServerListFocusTarget = Object.freeze({
  kind: "none"
})

/**
 * Calculates the list control that takes focus when the list returns from
 * an editor.
 *
 * @param editor - Editor that closes.
 * @returns A new request for the edited server's Edit button, or for Add
 * server after a new server's editor.
 */
function calculateEditorReturnTarget(
  editor: McpEditorTarget
): McpServerListFocusTarget {
  return editor.kind === "server"
    ? { kind: "server", serverName: editor.serverName }
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
    saved.name === editor.serverName ? server : saved
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
  const editedName = editor.kind === "server" ? editor.serverName : undefined
  return new Set(
    servers.map((server) => server.name).filter((name) => name !== editedName)
  )
}

/**
 * Finds the saved server an editor is open for.
 *
 * @param servers - Saved servers.
 * @param editor - Open editor.
 * @returns The saved server, or undefined for a new server.
 */
function findEditedServer(
  servers: readonly McpServerSettings[],
  editor: McpEditorTarget
): McpServerSettings | undefined {
  if (editor.kind === "new") return undefined
  return servers.find((server) => server.name === editor.serverName)
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

/** Properties accepted by {@link McpServerListView}. */
type McpServerListViewProps = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Control that takes focus when the list appears. */
  readonly focusTarget: McpServerListFocusTarget
  /** Requests that the parent open an editor in place of the list. */
  readonly onOpenEditor: (editor: McpEditorTarget) => void
  /** Requests that the parent move focus to another list control. */
  readonly onFocusTargetChange: (target: McpServerListFocusTarget) => void
}

/**
 * Presents the saved servers with their states and actions.
 *
 * @remarks The application store owns the saved servers and their save; the
 * MCP server store owns the reconnect and the save that applies the list.
 * The parent owns the list's states, which editor opens, and the focus
 * target. A server is removed once its removal is saved, and Add server then
 * takes focus through a new request, so it does after each removal.
 * @param props - Backend status, the list, focus, and the parent-owned
 * editor and focus changes.
 * @returns The section of the saved servers.
 */
function McpServerListView({
  isBackendRunning,
  list,
  focusTarget,
  onOpenEditor,
  onFocusTargetChange
}: McpServerListViewProps): ReactElement {
  const servers = useLysStore((state) => state.settings.mcp.servers)
  const isSaving = useLysStore(
    (state) => state.mcpSettingsSave.status === "saving"
  )
  const reconnectMcpServer = useMcpServerStore(
    (state) => state.reconnectMcpServer
  )
  const saveMcpServers = useMcpServerStore((state) => state.saveMcpServers)

  /**
   * Removes one server and, once saved, moves focus to Add server.
   *
   * @param serverName - Name of the server to remove.
   */
  async function handleRemoveServer(serverName: McpServerName): Promise<void> {
    const outcome = await saveMcpServers(
      servers.filter((server) => server.name !== serverName)
    )
    if (outcome === "saved") onFocusTargetChange({ kind: "add-server" })
  }

  return (
    <McpServerSection
      focusTarget={focusTarget}
      isBackendRunning={isBackendRunning}
      isSaving={isSaving}
      list={list}
      onAddServer={() => onOpenEditor(NEW_SERVER_EDITOR)}
      onEditServer={(serverName) =>
        onOpenEditor({ kind: "server", serverName })
      }
      onReconnectServer={(serverName) => void reconnectMcpServer(serverName)}
      onRemoveServer={(serverName) => void handleRemoveServer(serverName)}
      servers={servers}
    />
  )
}

/** Properties accepted by {@link McpServerEditorView}. */
type McpServerEditorViewProps = {
  /** Server the editor is open for. */
  readonly editor: McpEditorTarget
  /** Requests that the parent close the editor without saving. */
  readonly onClose: () => void
  /** Reports to the parent that the server was saved under a name. */
  readonly onSaved: (serverName: McpServerName) => void
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
  onSaved
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
    if (outcome === "saved") onSaved(server.name)
  }

  return (
    <McpServerEditor
      onClose={onClose}
      onSaveServer={(server) => void handleSaveServer(server)}
      otherServerNames={listOtherServerNames(servers, editor)}
      saveState={saveState}
      server={findEditedServer(servers, editor)}
    />
  )
}

/**
 * Presents the MCP pane: the saved MCP servers with each one's state, and
 * the editor that adds or changes one.
 *
 * @remarks The application store owns the saved servers, their save, and
 * the backend's status; the MCP server store owns the backend's states of
 * the servers. The pane owns which server the editor is open for, at most
 * one, which replaces the list while open, and which list control takes
 * focus when the list returns. The servers are listed from the settings
 * whether or not the backend runs, and can be edited either way. Each time
 * the pane appears while the backend runs, or the backend starts while it is
 * shown, it reads the states; while a server connects, the application
 * shell reads them again every second. A connection that ends while the
 * pane stays open shows once the states are read again. A status line stays
 * mounted above the list; while the editor is open, the editor shows a
 * failed save itself. Each editor is a separate instance, keyed by the
 * server's name; the new server's editor is keyed `:new`, which no name can
 * take. The pane accepts no props and is loaded lazily by the settings view.
 * @returns The MCP pane body.
 */
export default function McpPane(): ReactElement {
  const isBackendRunning = useLysStore(
    (state) => state.backendServerInfo.status === "running"
  )
  const saveState = useLysStore((state) => state.mcpSettingsSave)
  const list = useMcpServerStore((state) => state.list)
  const actionFailure = useMcpServerStore((state) => state.actionFailure)
  const loadMcpServers = useMcpServerStore((state) => state.loadMcpServers)
  const syncMcpServers = useMcpServerStore((state) => state.syncMcpServers)
  const [editor, setEditor] = useState<McpEditorTarget | null>(null)
  const [focusTarget, setFocusTarget] = useState(NO_FOCUS_TARGET)
  const facts = { isBackendRunning, list, actionFailure, saveState }
  const notes = listMcpPaneNotes({ ...facts, isEditing: editor !== null })
  const retry = findMcpPaneRetry({ ...facts, isEditing: editor !== null })

  // Read the states each time the pane opens while the backend runs, so a
  // connection that ended since the last read shows.
  useEffect(() => {
    if (isBackendRunning) void loadMcpServers()
  }, [isBackendRunning, loadMcpServers])

  /** Sends again what failed: the sync, or else the read. */
  function handleRetry(): void {
    if (retry === "sync") void syncMcpServers()
    else void loadMcpServers()
  }

  /**
   * Closes the editor and moves focus to a list control.
   *
   * @param target - Control that takes focus when the list returns.
   */
  function closeEditor(target: McpServerListFocusTarget): void {
    setFocusTarget(target)
    setEditor(null)
  }

  return (
    <div className="settings-view__mcp-pane">
      <McpPaneStatus
        notes={notes}
        onRetry={retry === undefined ? undefined : handleRetry}
      />
      {editor === null ? (
        <McpServerListView
          focusTarget={focusTarget}
          isBackendRunning={isBackendRunning}
          list={list}
          onFocusTargetChange={setFocusTarget}
          onOpenEditor={setEditor}
        />
      ) : (
        <McpServerEditorView
          editor={editor}
          key={editor.kind === "server" ? editor.serverName : ":new"}
          onClose={() => closeEditor(calculateEditorReturnTarget(editor))}
          onSaved={(serverName) => closeEditor({ kind: "server", serverName })}
        />
      )}
    </div>
  )
}
