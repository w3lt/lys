import type { McpServerList } from "@lys/protocol"
import type { McpServerName, McpServerSettings } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import {
  listMcpServers,
  reconnectMcpServer,
  syncMcpServers,
  type ReconnectMcpServerResult
} from "@/lib/apis/http/mcp"
import { useLysStore } from "@/lib/store"
import type { McpSettingsSaveOutcome } from "@/lib/store/mcp-settings"
import { useToolStore } from "@/lib/store/tools"

/** Lifecycle of the list of MCP servers the backend applied. */
export type McpServerListState =
  | {
      /** No read has started, or the backend stopped. */
      readonly status: "idle"
    }
  | {
      /** The first read is pending and nothing is displayed yet. */
      readonly status: "loading"
    }
  | {
      /** The backend answered; later reads replace it when they answer. */
      readonly status: "loaded"
      /** Outcome of the backend's last read of the `mcp` settings group. */
      readonly settings: McpServerList["settings"]
      /** Applied servers in the group's order, each with its state. */
      readonly servers: McpServerList["servers"]
    }
  | {
      /** The latest read failed. */
      readonly status: "failed"
      /** User-presentable reason. */
      readonly error: string
    }

/** Sync or reconnect whose request the backend could not be asked. */
export type McpServerActionFailure = {
  /** The action: applying the saved servers, or reconnecting one server. */
  readonly action: "sync" | "reconnect"
  /** User-presentable reason. */
  readonly error: string
}

/** Observable state of the MCP server store. */
type McpServerStoreState = {
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /**
   * Failure of the latest sync or reconnect, or null while one runs, after
   * one was answered, or before any.
   */
  readonly actionFailure: McpServerActionFailure | null
}

/** Actions of the MCP server store. */
type McpServerStoreActions = {
  /**
   * Reads the servers the backend applied, with each one's state.
   *
   * @returns A promise that resolves after the list or the failure is
   * committed; it never rejects.
   * @remarks A read requested while a sync or reconnect is pending joins
   * that action instead, whose answer is the whole list, and resolves once
   * every pending action settled; a read requested while another read is
   * pending joins that read. A list already loaded stays shown while it is
   * read again.
   */
  loadMcpServers: () => Promise<void>
  /**
   * Asks the backend to read the `mcp` settings group again and apply it.
   *
   * @returns A promise that resolves after the answered list or the failure
   * is committed; it never rejects.
   * @remarks A failure shown before is cleared when the sync starts.
   */
  syncMcpServers: () => Promise<void>
  /**
   * Asks the backend to close one server's connection and open it again.
   *
   * @param serverName - Name of the server to reconnect.
   * @returns A promise that resolves after the answered list or the failure
   * is committed; it never rejects.
   * @remarks A failure shown before is cleared when the reconnect starts.
   * When the backend has not applied a server with that name, it applies the
   * saved group instead, which opens the server if it is saved.
   */
  reconnectMcpServer: (serverName: McpServerName) => Promise<void>
  /**
   * Saves the whole list of MCP servers and, once it is saved while the
   * backend runs, asks the backend to apply it.
   *
   * @param servers - Servers in list order, each validated by the shared
   * server schema, each name once.
   * @returns The save outcome, once the save settled; it never rejects. The
   * request to apply the list is not awaited: its answer or failure is
   * committed like {@link McpServerStoreActions.syncMcpServers}'s. A backend
   * that is not running is not asked; {@link registerMcpServerRefresh} asks
   * it to apply the saved servers once it runs.
   */
  saveMcpServers: (
    servers: readonly McpServerSettings[]
  ) => Promise<McpSettingsSaveOutcome>
  /**
   * Forgets the list and any failure, as when the backend stops; an answer
   * still in flight is discarded, and a later read joins no action started
   * before.
   */
  resetMcpServers: () => void
}

/** Complete contract of the MCP server store. */
type McpServerStore = McpServerStoreState & McpServerStoreActions

/** Runtime dependencies of one MCP server store. */
type McpServerStoreDependencies = {
  /** Lists the applied servers; rejects when the list cannot be read. */
  readonly listMcpServers: () => Promise<McpServerList>
  /** Applies the saved group; rejects when the backend cannot be asked. */
  readonly syncMcpServers: () => Promise<McpServerList>
  /** Reconnects one server; rejects when the backend cannot be asked. */
  readonly reconnectMcpServer: (
    serverName: McpServerName
  ) => Promise<ReconnectMcpServerResult>
  /** Saves the MCP group through the application store; never rejects. */
  readonly saveMcpSettings: (
    servers: readonly McpServerSettings[]
  ) => Promise<McpSettingsSaveOutcome>
  /** Answers whether the backend is running now. */
  readonly isBackendRunning: () => boolean
}

/** List state before any read and after the backend stops. */
const IDLE_MCP_SERVER_LIST: McpServerListState = Object.freeze({
  status: "idle"
})

/** List state while the first read is pending. */
const LOADING_MCP_SERVER_LIST: McpServerListState = Object.freeze({
  status: "loading"
})

/** Failure when the backend could not be asked to apply the group. */
const SYNC_FAILURE: McpServerActionFailure = Object.freeze({
  action: "sync",
  error: "Lys couldn't ask its backend to apply the MCP servers."
})

/** Time between two reads of the list while a server connects. */
const MCP_SERVER_POLL_INTERVAL_MS = 1000

/**
 * Builds the loaded list state from the backend's answer.
 *
 * @param list - Validated, frozen list.
 * @returns A frozen loaded state holding the list's settings outcome and
 * servers.
 */
function buildLoadedMcpServerList(list: McpServerList): McpServerListState {
  return Object.freeze({
    status: "loaded",
    settings: list.settings,
    servers: list.servers
  })
}

/**
 * Formats why the list could not be read.
 *
 * @param error - Value the read rejected with.
 * @returns A sentence for the pane's status line, with the reason when the
 * rejection carries one.
 */
function formatMcpServerListError(error: unknown): string {
  return error instanceof Error && error.message
    ? `Lys couldn't read the state of the MCP servers: ${error.message}`
    : "Lys couldn't read the state of the MCP servers."
}

/**
 * Creates one independently owned MCP server store.
 *
 * @param dependencies - Backend requests, each bound to the backend origin
 * when it is sent.
 * @returns A Zustand hook and store API owning the list of applied servers
 * and the failure of the latest action.
 * @remarks Every read and action is numbered when it starts. An answer is
 * committed only when no answer of a later request was committed, so a late
 * answer never replaces a newer list; a reset discards every answer in
 * flight. A read requested while a sync or reconnect runs joins it instead
 * of sending a read the backend could answer before it applied the action.
 */
function createMcpServerStore(
  dependencies: McpServerStoreDependencies
): UseBoundStore<StoreApi<McpServerStore>> {
  /** List read in flight; a read requested meanwhile joins it. */
  let pendingListRead: Promise<void> | undefined
  /** Syncs and reconnects in flight; a read requested meanwhile joins them. */
  const pendingActions = new Set<Promise<void>>()
  /** Number of the latest request started. */
  let latestStartedRequest = 0
  /** Number of the latest request whose answer was committed. */
  let latestCommittedRequest = 0

  /**
   * Numbers a request that starts now.
   *
   * @returns The request's number, higher than every earlier one.
   */
  function startRequest(): number {
    latestStartedRequest += 1
    return latestStartedRequest
  }

  /**
   * Answers whether a request's answer may still be committed.
   *
   * @param request - Number of the request.
   * @returns True while no later request's answer was committed and no
   * reset happened since it started.
   */
  function isRequestCurrent(request: number): boolean {
    return request > latestCommittedRequest
  }

  /**
   * Records a sync or reconnect as pending until it settles.
   *
   * @param action - Action that started; it never rejects.
   * @returns The same action.
   */
  function trackAction(action: Promise<void>): Promise<void> {
    pendingActions.add(action)
    void action.finally(() => pendingActions.delete(action))
    return action
  }

  /**
   * Waits for every sync and reconnect pending now.
   *
   * @returns A promise that resolves once they all settled.
   */
  async function joinPendingActions(): Promise<void> {
    await Promise.all(pendingActions)
  }

  /**
   * Creates the state and actions that own this store's lifecycle.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @param get - Zustand capability that reads the current state.
   * @returns Initial state and its actions.
   */
  function createMcpServerStoreState(
    set: StoreApi<McpServerStore>["setState"],
    get: StoreApi<McpServerStore>["getState"]
  ): McpServerStore {
    /**
     * Commits a list answered for a current request.
     *
     * @param request - Number of the request that answered.
     * @param list - List state to show.
     */
    function commitList(request: number, list: McpServerListState): void {
      if (!isRequestCurrent(request)) return
      latestCommittedRequest = request
      set({ list })
    }

    /**
     * Shows why an action could not be asked, unless a later answer was
     * committed or the store was reset since it started.
     *
     * @param request - Number of the action.
     * @param actionFailure - The action and the user-presentable reason.
     */
    function commitActionFailure(
      request: number,
      actionFailure: McpServerActionFailure
    ): void {
      if (isRequestCurrent(request)) set({ actionFailure })
    }

    /**
     * Numbers an action that starts now and clears the failure shown, so the
     * action's own outcome is shown, even when it is the same failure.
     *
     * @returns The action's number.
     */
    function startAction(): number {
      set({ actionFailure: null })
      return startRequest()
    }

    /**
     * Reads the list and commits it or the failure.
     *
     * @returns A promise that resolves after the outcome is committed.
     */
    async function readMcpServerList(): Promise<void> {
      const request = startRequest()
      if (get().list.status !== "loaded") set({ list: LOADING_MCP_SERVER_LIST })
      try {
        const list = await dependencies.listMcpServers()
        commitList(request, buildLoadedMcpServerList(list))
      } catch (error) {
        const failed: McpServerListState = Object.freeze({
          status: "failed",
          error: formatMcpServerListError(error)
        })
        commitList(request, failed)
      }
    }

    /** Implements {@link McpServerStoreActions.loadMcpServers}. */
    function loadMcpServers(): Promise<void> {
      if (pendingActions.size > 0) return joinPendingActions()
      if (pendingListRead !== undefined) return pendingListRead
      const read = readMcpServerList().finally(() => {
        if (pendingListRead === read) pendingListRead = undefined
      })
      pendingListRead = read
      return read
    }

    /**
     * Asks the backend to apply the saved group and commits its answer.
     *
     * @returns A promise that resolves after the outcome is committed.
     */
    async function applyMcpServers(): Promise<void> {
      const request = startAction()
      try {
        const list = await dependencies.syncMcpServers()
        commitList(request, buildLoadedMcpServerList(list))
      } catch {
        commitActionFailure(request, SYNC_FAILURE)
      }
    }

    /** Implements {@link McpServerStoreActions.syncMcpServers}. */
    function sendMcpServerSync(): Promise<void> {
      return trackAction(applyMcpServers())
    }

    /**
     * Asks the backend to reconnect one server and commits its answer, or
     * applies the saved group when the backend has not applied the server.
     *
     * @param serverName - Name of the server to reconnect.
     * @returns A promise that resolves after the outcome is committed.
     */
    async function reopenMcpServer(serverName: McpServerName): Promise<void> {
      const request = startAction()
      let result: ReconnectMcpServerResult
      try {
        result = await dependencies.reconnectMcpServer(serverName)
      } catch {
        const error = `Lys couldn't ask its backend to reconnect ${serverName}.`
        commitActionFailure(request, { action: "reconnect", error })
        return
      }
      if (result.status === "not-found") {
        await sendMcpServerSync()
        return
      }
      commitList(request, buildLoadedMcpServerList(result.list))
    }

    /**
     * Implements {@link McpServerStoreActions.reconnectMcpServer}.
     *
     * @param serverName - Name of the server to reconnect.
     * @returns A promise that resolves after the outcome is committed.
     */
    function sendMcpServerReconnect(serverName: McpServerName): Promise<void> {
      return trackAction(reopenMcpServer(serverName))
    }

    /**
     * Implements {@link McpServerStoreActions.saveMcpServers}.
     *
     * @param servers - Servers to save.
     * @returns The save outcome.
     */
    async function saveMcpServers(
      servers: readonly McpServerSettings[]
    ): Promise<McpSettingsSaveOutcome> {
      const outcome = await dependencies.saveMcpSettings(servers)
      if (outcome === "saved" && dependencies.isBackendRunning()) {
        void sendMcpServerSync()
      }
      return outcome
    }

    /** Implements {@link McpServerStoreActions.resetMcpServers}. */
    function resetMcpServers(): void {
      latestCommittedRequest = latestStartedRequest
      pendingListRead = undefined
      pendingActions.clear()
      set({ list: IDLE_MCP_SERVER_LIST, actionFailure: null })
    }

    return {
      list: IDLE_MCP_SERVER_LIST,
      actionFailure: null,
      loadMcpServers,
      syncMcpServers: sendMcpServerSync,
      reconnectMcpServer: sendMcpServerReconnect,
      saveMcpServers,
      resetMcpServers
    }
  }

  return create<McpServerStore>(createMcpServerStoreState)
}

/**
 * MCP server store used by the MCP settings pane and the application
 * shell's refresh.
 *
 * @remarks This singleton owns the list of servers the backend applied,
 * read from the backend origin the application store names when each
 * request starts, and the failure of the latest sync or reconnect. It holds
 * no server settings: the application store owns and saves them, and this
 * store asks the backend to apply them once they are saved.
 */
export const useMcpServerStore: UseBoundStore<StoreApi<McpServerStore>> =
  createMcpServerStore({
    listMcpServers: () =>
      listMcpServers({ backendUrl: useLysStore.getState().backendUrl }),
    syncMcpServers: () =>
      syncMcpServers({ backendUrl: useLysStore.getState().backendUrl }),
    reconnectMcpServer: (serverName) =>
      reconnectMcpServer(
        { backendUrl: useLysStore.getState().backendUrl },
        serverName
      ),
    saveMcpSettings: (servers) =>
      useLysStore.getState().saveMcpServers(servers),
    isBackendRunning: () =>
      useLysStore.getState().backendServerInfo.status === "running"
  })

/** Application state the MCP server refresh observes. */
type McpServerRefreshState = Pick<
  ReturnType<typeof useLysStore.getState>,
  "backendServerInfo"
>

/**
 * Asks the backend to apply the saved servers when it starts running, which
 * also shows their states, and forgets the list when it stops running.
 *
 * @remarks The backend applies the `mcp` group itself when it starts; the
 * sync also applies a save made while the desktop did not yet see it
 * running. Unchanged servers keep their connection.
 * @param state - Application state after the change.
 * @param previousState - Application state before the change.
 */
function handleBackendStatusChange(
  state: McpServerRefreshState,
  previousState: McpServerRefreshState
): void {
  const isRunning = state.backendServerInfo.status === "running"
  const wasRunning = previousState.backendServerInfo.status === "running"
  if (isRunning === wasRunning) return
  const serverStore = useMcpServerStore.getState()
  if (isRunning) void serverStore.syncMcpServers()
  else serverStore.resetMcpServers()
}

/**
 * Builds a key that changes whenever the tools the connected servers add to
 * the backend's tool list may change.
 *
 * @param list - Loaded list of applied servers.
 * @returns Each connected server's name and tool count, in list order.
 */
function buildConnectedToolsKey(
  list: Extract<McpServerListState, { readonly status: "loaded" }>
): string {
  return list.servers
    .flatMap((server) =>
      server.state.status === "connected"
        ? [`${server.name}:${server.state.toolCount}`]
        : []
    )
    .join(" ")
}

/**
 * Answers whether a list holds a server that is still connecting.
 *
 * @param list - List state.
 * @returns True when the list is loaded and a server is `connecting`.
 */
function isAnyMcpServerConnecting(list: McpServerListState): boolean {
  return (
    list.status === "loaded" &&
    list.servers.some((server) => server.state.status === "connecting")
  )
}

/**
 * Reads a tool list already read again; a list never read is left alone.
 *
 * @remarks The read is not awaited: it never rejects and commits its own
 * outcome to the tool list.
 */
function loadReadToolListAgain(): void {
  const toolStore = useToolStore.getState()
  if (toolStore.list.status !== "idle") void toolStore.loadToolsAgain()
}

/**
 * Starts keeping the MCP server list and the tool list in step with the
 * backend's MCP servers.
 *
 * @returns The unsubscribe, which stops following both stores and clears the
 * next scheduled read of the list; a read or action already in flight still
 * commits its answer. Calling it again does nothing.
 * @remarks Subscribes to the application store and the MCP server store.
 * When the backend starts running, it is asked to apply the saved servers,
 * whose answer is the list; when it stops running, the list is forgotten.
 * While a loaded list holds a server that is
 * connecting, the list is read again one second after each answer. When
 * the connected servers or their tool counts change, a tool list already
 * read is read again, so the Tools pane and the next chat request see the
 * servers' tools. When the backend already runs at registration, the list
 * is read at once. The application shell registers it once while it is mounted;
 * nothing subscribes when this module is evaluated.
 */
export function registerMcpServerRefresh(): () => void {
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let connectedToolsKey = ""

  /** Cancels the next read of the list, if one is scheduled. */
  function stopPolling(): void {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }

  /** Reads the list once the poll interval has passed. */
  function handlePollTimeout(): void {
    pollTimer = undefined
    void useMcpServerStore.getState().loadMcpServers()
  }

  /**
   * Reads the tool list again when the connected servers' tools changed.
   *
   * @param list - List state after the change.
   */
  function updateToolList(list: McpServerListState): void {
    if (list.status === "idle") connectedToolsKey = ""
    if (list.status !== "loaded") return
    const toolsKey = buildConnectedToolsKey(list)
    if (toolsKey === connectedToolsKey) return
    connectedToolsKey = toolsKey
    loadReadToolListAgain()
  }

  /**
   * Follows a change of the MCP server store.
   *
   * @param state - MCP server store state after the change.
   */
  function handleServerStoreChange(state: McpServerStore): void {
    updateToolList(state.list)
    if (!isAnyMcpServerConnecting(state.list)) stopPolling()
    else
      pollTimer ??= setTimeout(handlePollTimeout, MCP_SERVER_POLL_INTERVAL_MS)
  }

  const unsubscribeApplication = useLysStore.subscribe(
    handleBackendStatusChange
  )
  const unsubscribeServers = useMcpServerStore.subscribe(
    handleServerStoreChange
  )
  if (useLysStore.getState().backendServerInfo.status === "running") {
    void useMcpServerStore.getState().loadMcpServers()
  }

  return () => {
    unsubscribeApplication()
    unsubscribeServers()
    stopPolling()
  }
}
