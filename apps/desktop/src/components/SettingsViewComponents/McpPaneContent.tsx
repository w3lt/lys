import {
  BUILT_IN_MCP_SERVER_NAMES,
  type EmailAccount,
  type EmailPassword,
  type McpServerName,
  type McpServerSettings
} from "@lys/share"
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement
} from "react"

import { Button } from "@/components/ui/button"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import { useLysStore, type BackendServerStatus } from "@/lib/store"
import {
  isEmailAccountSaved,
  type EmailAccountRemovalOutcome,
  type EmailAccountSaveOutcome
} from "@/lib/store/email-settings"
import {
  useMcpServerStore,
  type McpServerListState
} from "@/lib/store/mcp-servers"
import {
  isMcpSettingsSaveRunning,
  type McpSettingsSaveOutcome
} from "@/lib/store/mcp-settings"
import type { ToolApproval } from "@/lib/store/tool-settings"
import { useToolStore } from "@/lib/store/tools"

import EmailAccountCard from "./EmailAccountCard"
import { McpServerEditor, type McpEditorTarget } from "./McpServerEditor"
import {
  McpServerSection,
  McpToolOfferWarning,
  type McpServerListFocusTarget
} from "./McpServerList"
import { ToolApprovalSaveFeedback } from "./ToolApprovalSaveFeedback"
import {
  buildMcpListedServerKey,
  findMcpPaneRetry,
  formatMcpToolOfferWarning,
  isMcpListedServerOn,
  listMcpPaneNotes,
  listMcpServers,
  type McpListedServer,
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
  switch (editor.kind) {
    case "new":
      return { kind: "add-server" }
    case "server":
      return { kind: "server", serverName: editor.server.name }
  }
}

/** What the server list shows and which of its controls takes focus. */
type McpListView = {
  /**
   * Key of the server whose details are shown, by its kind and name, or
   * null when none is.
   */
  readonly expandedServerKey: string | null
  /** Control that takes focus when the list appears, or none. */
  readonly focusTarget: McpServerListFocusTarget
}

/** One change to what the server list shows. */
type McpListViewChange =
  | {
      /** The person showed one server's details, or none. */
      readonly kind: "details"
      /** Key of the server whose details to show, or null for none. */
      readonly serverKey: string | null
    }
  | {
      /** An editor closed, so the list returns. */
      readonly kind: "editor-closed"
      /** Control that takes focus; a server's Edit button also shows its details. */
      readonly target: McpServerListFocusTarget
    }
  | {
      /** The removal of a server was saved. */
      readonly kind: "server-removed"
      /** Name of the removed server. */
      readonly serverName: McpServerName
    }

/** The list before any change: no details shown, and focus left where it is. */
const INITIAL_MCP_LIST_VIEW: McpListView = Object.freeze({
  expandedServerKey: null,
  focusTarget: NO_FOCUS_TARGET
})

/**
 * Calculates whose details the list shows once an editor closed.
 *
 * @param target - Control that takes focus once the list returns.
 * @param expandedServerKey - Key of the server whose details are shown
 * now, or null when none is.
 * @returns The key of the added server whose Edit button takes focus, so
 * its details show; otherwise the key shown now.
 */
function calculateExpandedServerKeyOnReturn(
  target: McpServerListFocusTarget,
  expandedServerKey: string | null
): string | null {
  switch (target.kind) {
    case "server":
      return buildMcpListedServerKey("added", target.serverName)
    case "none":
    case "add-server":
      return expandedServerKey
    default: {
      const unhandledTarget: never = target
      return unhandledTarget
    }
  }
}

/**
 * Calculates what the server list shows after one change.
 *
 * @param view - What the list shows now.
 * @param change - What happened.
 * @returns The details the person chose, with any focus request ended,
 * because it applied when the list appeared; after an editor closes, its
 * focus target and, for an added server's Edit button, that server's
 * details; after a removal is saved, the removed added server's details
 * closed if they are still shown, and a new request for Add server, which
 * takes focus only while focus is lost.
 */
function calculateMcpListView(
  view: McpListView,
  change: McpListViewChange
): McpListView {
  switch (change.kind) {
    case "details":
      return {
        expandedServerKey: change.serverKey,
        focusTarget: NO_FOCUS_TARGET
      }
    case "editor-closed":
      return {
        expandedServerKey: calculateExpandedServerKeyOnReturn(
          change.target,
          view.expandedServerKey
        ),
        focusTarget: change.target
      }
    case "server-removed": {
      const focusTarget: McpServerListFocusTarget = { kind: "add-server" }
      return {
        expandedServerKey:
          view.expandedServerKey ===
          buildMcpListedServerKey("added", change.serverName)
            ? null
            : view.expandedServerKey,
        focusTarget
      }
    }
  }
}

/**
 * Builds the server list after saving one server.
 *
 * @param servers - Saved servers, in list order.
 * @param server - Server to save, as the editor built it: switched on.
 * @param editor - Editor the server comes from.
 * @returns The list with the edited server replaced in place, keeping its
 * saved switch, or the new server added at the end.
 */
function buildServersWithSaved(
  servers: readonly McpServerSettings[],
  server: McpServerSettings,
  editor: McpEditorTarget
): readonly McpServerSettings[] {
  switch (editor.kind) {
    case "new":
      return [...servers, server]
    case "server":
      return servers.map((saved) =>
        saved.name === editor.server.name
          ? { ...server, enabled: saved.enabled }
          : saved
      )
  }
}

/**
 * Builds the server list after switching one added server on or off.
 *
 * @param servers - Saved servers, in list order.
 * @param serverName - Name of the server.
 * @param isOn - Whether the backend connects it.
 * @returns The list with that server's switch replaced in place.
 */
function buildServersWithSwitch(
  servers: readonly McpServerSettings[],
  serverName: McpServerName,
  isOn: boolean
): readonly McpServerSettings[] {
  return servers.map((saved) =>
    saved.name === serverName ? { ...saved, enabled: isOn } : saved
  )
}

/**
 * Lists the names a server being edited may not take: those of the
 * servers Lys ships, and of the saved servers other than the one being
 * edited.
 *
 * @param servers - Saved servers.
 * @param editor - Editor the names are checked for.
 * @returns The names a new or renamed server may not take; a saved server
 * that has a built-in server's name must be renamed to be saved again.
 */
function listOtherServerNames(
  servers: readonly McpServerSettings[],
  editor: McpEditorTarget
): ReadonlySet<string> {
  const names = servers.map((server) => server.name)
  const otherNames =
    editor.kind === "new"
      ? names
      : names.filter((name) => name !== editor.server.name)
  return new Set([...BUILT_IN_MCP_SERVER_NAMES, ...otherNames])
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
 * Warns, while a server is switched on, when its tools are not offered to
 * the model, with a way to the Tools pane.
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

/** Saves the server list proposes, made through the stores. */
type McpServerListSaves = {
  /** Removes one added server and, once the removal is saved, tells the parent. */
  readonly handleRemoveServer: (serverName: McpServerName) => Promise<void>
  /** Saves one server's switch into the group, which the store applies. */
  readonly handleServerOnChange: (
    server: McpListedServer,
    isOn: boolean
  ) => void
  /** Proposes one approval for several tools, which the store saves. */
  readonly handleToolApprovalChange: (
    toolNames: readonly string[],
    approval: ToolApproval
  ) => void
}

/**
 * Answers whether a save of the MCP group saved it.
 *
 * @param outcome - Outcome of the save.
 * @returns True once the settings file holds the group.
 */
function isMcpSettingsSaved(outcome: McpSettingsSaveOutcome): boolean {
  switch (outcome) {
    case "saved":
      return true
    case "failed":
    case "busy":
      return false
    default: {
      const unhandledOutcome: never = outcome
      return unhandledOutcome
    }
  }
}

/**
 * Owns the saves the server list proposes: removing an added server,
 * switching a server on or off, and one approval for several tools.
 *
 * @remarks The application store owns the `mcp` group and the tool
 * approvals, which it saves as each changes; the MCP server store owns the
 * saves that apply the group. Each save starts from the group the render
 * that built its handler read. The handlers are rebuilt on every render.
 * @param onRemoveServerComplete - Told the server's name once a removal was
 * saved; read from the render whose handler started the removal.
 * @returns The handlers.
 */
function useMcpServerListSaves(
  onRemoveServerComplete: (serverName: McpServerName) => void
): McpServerListSaves {
  const mcp = useLysStore((state) => state.settings.mcp)
  const updateToolApproval = useLysStore((state) => state.updateToolApproval)
  const saveMcpServers = useMcpServerStore((state) => state.saveMcpServers)
  const saveBuiltInMcpServerSwitch = useMcpServerStore(
    (state) => state.saveBuiltInMcpServerSwitch
  )

  /**
   * Removes one added server and, once saved, tells the parent.
   *
   * @param serverName - Name of the server to remove.
   */
  async function handleRemoveServer(serverName: McpServerName): Promise<void> {
    const outcome = await saveMcpServers(
      mcp.servers.filter((server) => server.name !== serverName)
    )
    if (isMcpSettingsSaved(outcome)) onRemoveServerComplete(serverName)
  }

  /**
   * Saves one server's switch into the group, which the store applies.
   *
   * @param server - Listed server.
   * @param isOn - Whether the backend connects it.
   */
  function handleServerOnChange(server: McpListedServer, isOn: boolean): void {
    if (server.kind === "added") {
      void saveMcpServers(
        buildServersWithSwitch(mcp.servers, server.settings.name, isOn)
      )
    } else {
      void saveBuiltInMcpServerSwitch(server.name, isOn)
    }
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

  return { handleRemoveServer, handleServerOnChange, handleToolApprovalChange }
}

/** Properties accepted by {@link McpServerListView}. */
type McpServerListViewProps = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /**
   * Key of the server whose details are shown, by its kind and name, or
   * null when none is.
   */
  readonly expandedServerKey: string | null
  /** Control that takes focus when the list appears. */
  readonly focusTarget: McpServerListFocusTarget
  /** Proposes showing one server's details, by its key, or none with null. */
  readonly onExpandedServerKeyChange: (serverKey: string | null) => void
  /** Requests that the parent open an editor in place of the list. */
  readonly onOpenEditor: (editor: McpEditorTarget) => void
  /** Reports to the parent that the removal of a server was saved. */
  readonly onRemoveServerComplete: (serverName: McpServerName) => void
}

/**
 * Presents the servers Lys ships and the added servers with their states,
 * switches, tools, and actions.
 *
 * @remarks The application store owns the `mcp` and `email` groups, their
 * saves, and the tool switches and approvals, which it saves as each
 * changes; the MCP server store owns the reconnect and the saves that apply
 * the group; the tool store owns the list of tools. The parent owns the
 * list's states, which server's details are shown, which editor opens, and
 * the focus target. The view saves what the list proposes through
 * {@link useMcpServerListSaves}: a server's switch is saved into the group,
 * an added server's own switch or the switch of a server Lys ships; a
 * server's approval sets every listed tool of the server; and a server is
 * removed once its removal is saved, which the parent is told with the
 * server's name. The email server's panel is the account card.
 * @param props - Backend status, the list, expansion, focus, and the
 * parent-owned changes.
 * @returns The warning, when one is due, and the section of the servers.
 */
function McpServerListView({
  isBackendRunning,
  list,
  expandedServerKey,
  focusTarget,
  onExpandedServerKeyChange,
  onOpenEditor,
  onRemoveServerComplete
}: McpServerListViewProps): ReactElement {
  const mcp = useLysStore((state) => state.settings.mcp)
  const email = useLysStore((state) => state.settings.email)
  const isSaving = useLysStore((state) =>
    isMcpSettingsSaveRunning(state.mcpSettingsSave)
  )
  const toolSettings = useLysStore((state) => state.settings.tools)
  const updateToolOn = useLysStore((state) => state.updateToolOn)
  const toolList = useToolStore((state) => state.list)
  const sendMcpServerReconnect = useMcpServerStore(
    (state) => state.sendMcpServerReconnect
  )
  const saves = useMcpServerListSaves(onRemoveServerComplete)
  const servers = listMcpServers({ mcp, email })

  return (
    <>
      {servers.some(isMcpListedServerOn) ? <McpToolOfferNotice /> : null}
      <McpServerSection
        builtInPanels={{ email: <EmailAccountCardView /> }}
        expandedServerKey={expandedServerKey}
        focusTarget={focusTarget}
        isBackendRunning={isBackendRunning}
        isSaving={isSaving}
        list={list}
        onAddServer={(transport) => onOpenEditor({ kind: "new", transport })}
        onEditServer={(server) => onOpenEditor({ kind: "server", server })}
        onExpandedServerKeyChange={onExpandedServerKeyChange}
        onReconnectServer={(serverName) =>
          void sendMcpServerReconnect(serverName)
        }
        onRemoveServer={(serverName) =>
          void saves.handleRemoveServer(serverName)
        }
        onServerOnChange={saves.handleServerOnChange}
        onToolApprovalChange={saves.handleToolApprovalChange}
        onToolOnChange={updateToolOn}
        servers={servers}
        toolList={toolList}
        toolSettings={toolSettings}
      />
    </>
  )
}

/**
 * Answers whether the backend answers requests.
 *
 * @param status - The backend's lifecycle state.
 * @returns True while it runs.
 */
function isBackendServerRunning(status: BackendServerStatus): boolean {
  switch (status) {
    case "running":
      return true
    case "starting":
    case "stopping":
    case "stopped":
    case "unresponsive":
      return false
    default: {
      const unhandledStatus: never = status
      return unhandledStatus
    }
  }
}

/**
 * Presents the email account card and saves, checks, and removes the
 * account.
 *
 * @remarks The application store owns the saved account and password, the
 * save, the check, the removal, the email server's switch, and the
 * backend's status; the MCP server store owns the switch's save and the
 * sync that applies the group. Saving signs in through the backend first,
 * which the store does; once the account is saved while the email server
 * is on, the backend is asked to apply the group, so the server starts
 * again with the account. The store's removal switches the email server
 * off first, because the server cannot run without an account, through the
 * MCP server store's switch save, which has the backend apply it, and
 * removes nothing when that save fails.
 * @returns The account card.
 */
function EmailAccountCardView(): ReactElement {
  const savedAccount = useLysStore((state) => state.settings.email.account)
  const savedPassword = useLysStore(
    (state) => state.settings.secrets.emailPassword
  )
  const saveState = useLysStore((state) => state.emailAccountSave)
  const checkState = useLysStore((state) => state.emailAccountCheck)
  const isBackendRunning = useLysStore((state) =>
    isBackendServerRunning(state.backendServerInfo.status)
  )
  const saveEmailAccount = useLysStore((state) => state.saveEmailAccount)
  const deleteEmailAccount = useLysStore((state) => state.deleteEmailAccount)
  const saveBuiltInMcpServerSwitch = useMcpServerStore(
    (state) => state.saveBuiltInMcpServerSwitch
  )
  const sendMcpServerSync = useMcpServerStore(
    (state) => state.sendMcpServerSync
  )

  /**
   * Saves the account and, once saved while the email server is on, asks
   * the backend to apply the group.
   *
   * @param account - Valid account.
   * @param password - Its password.
   * @returns The save outcome.
   * @remarks The switch is read once the save settled, not when the save
   * started: the person can switch the server on while the check runs, and
   * that switch's sync starts the server with the account saved before.
   */
  async function handleSaveEmailAccount(
    account: EmailAccount,
    password: EmailPassword
  ): Promise<EmailAccountSaveOutcome> {
    const outcome = await saveEmailAccount(account, password)
    const isOnAfterSave =
      useLysStore.getState().settings.mcp.builtIn.email.enabled
    if (isEmailAccountSaved(outcome) && isOnAfterSave) void sendMcpServerSync()
    return outcome
  }

  /**
   * Removes the account, switching the email server off first while it is
   * on.
   *
   * @returns The removal outcome: `failed` when the switch or the removal
   * could not be saved, in which case the account stays.
   */
  function handleRemoveEmailAccount(): Promise<EmailAccountRemovalOutcome> {
    return deleteEmailAccount(() => saveBuiltInMcpServerSwitch("email", false))
  }

  return (
    <EmailAccountCard
      checkState={checkState}
      isBackendRunning={isBackendRunning}
      onRemoveEmailAccount={handleRemoveEmailAccount}
      onSaveEmailAccount={handleSaveEmailAccount}
      savedAccount={savedAccount}
      savedPassword={savedPassword}
      saveState={saveState}
    />
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
  const sendMcpServerSync = useMcpServerStore(
    (state) => state.sendMcpServerSync
  )
  const facts = { isBackendRunning, list, actionFailure, saveState, isEditing }
  const retry = findMcpPaneRetry(facts)

  /** Sends again what failed: the sync, or else the read. */
  function handleRetry(): void {
    if (retry === "sync") void sendMcpServerSync()
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
 * Builds the key that tells one editor instance from another.
 *
 * @param editor - What the editor is open for.
 * @returns The saved server's name, or `:new` for a new server, which no
 * name can take.
 */
function buildMcpEditorKey(editor: McpEditorTarget): string {
  switch (editor.kind) {
    case "server":
      return editor.server.name
    case "new":
      return ":new"
    default: {
      const unhandledEditor: never = editor
      return unhandledEditor
    }
  }
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
 * show and its Edit button takes focus; the request ends with the next
 * change of the shown details, so showing them again later moves no focus.
 * Closing a new server's editor moves focus to Add server. Once a removal is
 * saved, the removed server's details close if they are still shown, and
 * focus moves to Add server only if it was lost with the removed row, so a
 * server the person turned to meanwhile keeps its details and focus. The
 * status of the tool choices' save stays mounted below the list and the
 * editor, because the pane changes tool choices. The servers are listed from
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
  const isBackendRunning = useLysStore((state) =>
    isBackendServerRunning(state.backendServerInfo.status)
  )
  const list = useMcpServerStore((state) => state.list)
  const [editor, setEditor] = useState<McpEditorTarget | null>(null)
  const [listView, updateListView] = useReducer(
    calculateMcpListView,
    INITIAL_MCP_LIST_VIEW
  )

  useMcpPaneReads(isBackendRunning)

  /**
   * Closes the editor, shows a server's details, and moves focus to a list
   * control.
   *
   * @param target - Control that takes focus when the list returns; a
   * server's Edit button also shows that server's details.
   */
  function closeEditor(target: McpServerListFocusTarget): void {
    updateListView({ kind: "editor-closed", target })
    setEditor(null)
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
          expandedServerKey={listView.expandedServerKey}
          focusTarget={listView.focusTarget}
          isBackendRunning={isBackendRunning}
          list={list}
          onExpandedServerKeyChange={(serverKey) =>
            updateListView({ kind: "details", serverKey })
          }
          onOpenEditor={setEditor}
          onRemoveServerComplete={(serverName) =>
            updateListView({ kind: "server-removed", serverName })
          }
        />
      ) : (
        <McpServerEditorView
          editor={editor}
          key={buildMcpEditorKey(editor)}
          onClose={() => closeEditor(calculateEditorReturnTarget(editor))}
          onSaveServerComplete={(serverName) =>
            closeEditor({ kind: "server", serverName })
          }
        />
      )}
      <ToolApprovalSaveFeedback />
    </div>
  )
}
