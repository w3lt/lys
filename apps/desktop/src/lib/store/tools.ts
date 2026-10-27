import type {
  ListedBackendToolUnavailableReason,
  ChatApiRequestBody,
  ChatToolOffer,
  UnavailableBackendTool
} from "@lys/protocol"
import type { ToolAccess, ToolDefinition } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import { listBackendTools, type BackendToolList } from "@/lib/apis/http/tools"
import { listTools } from "@/lib/apis/tauri/tools"
import { useLysStore } from "@/lib/store"
import type { ToolSettings } from "@/lib/store/settings"
import type { VmoServerStatus } from "@/lib/store/vmo-runtime"
import { getToolApproval, type ToolApproval } from "@/lib/store/tool-settings"

/** Choice the person made in the Tools pane for one tool. */
export type ToolChoice = {
  /** Whether the tool is offered to the model. */
  readonly isOn: boolean
  /** When the tool runs once the model asks for it. */
  readonly approval: ToolApproval
}

/**
 * Whether a tool the person has not switched is on, by what the tool does
 * with the machine.
 *
 * @remarks A tool that only reads data on this machine starts on; a tool
 * that sends requests off the machine starts off. An MCP tool, whose access
 * depends on its server, starts on: the person added the server for its
 * tools, and every call asks first unless they choose Just run.
 */
const IS_TOOL_ON_BY_DEFAULT = Object.freeze({
  reads: true,
  network: false,
  unknown: true
} satisfies Readonly<Record<ToolAccess, boolean>>)

/** Lifecycle of the list of every tool: the desktop's and the backend's. */
export type ToolListState =
  | {
      /** No read has started. */
      readonly status: "idle"
    }
  | {
      /** A read is pending and nothing is displayed yet. */
      readonly status: "loading"
    }
  | {
      /** Both lists were read. */
      readonly status: "loaded"
      /**
       * Every tool, each name once: the desktop's tools, then the backend's,
       * each in the order its source lists them.
       */
      readonly tools: readonly ToolDefinition[]
      /**
       * Why each backend tool that cannot run now cannot, keyed by tool
       * name; such a tool is never offered and its switch is disabled.
       */
      readonly unavailableTools: ReadonlyMap<
        string,
        ListedBackendToolUnavailableReason
      >
    }
  | {
      /** The latest read of either list failed. */
      readonly status: "failed"
      /** User-presentable reason. */
      readonly error: string
    }

/** Observable state of the tool list and the session's tool-calls switch. */
type ToolStoreState = {
  /** Lifecycle of the list of every tool. */
  readonly list: ToolListState
  /**
   * Whether agents may call tools at all; on until switched off, for the
   * session only.
   */
  readonly areToolCallsOn: boolean
}

/** Actions of the Tools pane store. */
type ToolStoreActions = {
  /**
   * Reads the desktop's tools and the backend's tools.
   *
   * @returns A promise that resolves after the list or the failure is
   * committed; it never rejects.
   * @remarks A read requested while another is pending joins it. The read
   * cannot be cancelled; the store owns it, so leaving the pane does not stop
   * it.
   */
  loadTools: () => Promise<void>
  /**
   * Reads the desktop's tools and the backend's tools in a read that starts
   * after the read in flight, if any, has settled.
   *
   * @returns A promise that resolves after the list or the failure is
   * committed; it never rejects.
   * @remarks Unlike {@link loadTools}, it never settles with a read that
   * started before the call, so the list reflects what changed before it,
   * such as vmo becoming ready. A further call made while it waits joins the
   * same next read; {@link loadTools} called meanwhile joins the read in
   * flight.
   */
  loadToolsAgain: () => Promise<void>
  /**
   * Switches tool calls on or off for every agent.
   *
   * @param areToolCallsOn - Whether agents may call tools.
   */
  updateToolCallsOn: (areToolCallsOn: boolean) => void
}

/** Complete contract of the Tools pane store. */
type ToolStore = ToolStoreState & ToolStoreActions

/** Runtime dependencies of one tool store. */
type ToolStoreDependencies = {
  /** Lists the desktop's tools; rejects when the list cannot be read. */
  readonly listClientTools: () => Promise<readonly ToolDefinition[]>
  /**
   * Lists the backend's tools and which cannot run now; rejects when the
   * list cannot be read.
   */
  readonly listBackendTools: () => Promise<BackendToolList>
}

/** List state while a read is pending. */
const LOADING_TOOL_LIST: ToolListState = Object.freeze({ status: "loading" })

/**
 * Answers whether one tool is switched on.
 *
 * @param toolSwitches - Switches the person changed, keyed by tool name, as
 * the tools settings group saves them.
 * @param tool - Name and access of the tool.
 * @returns The tool's changed switch, or, when the person has not switched
 * it, on unless the tool sends requests off this machine.
 */
export function isToolOn(
  toolSwitches: ReadonlyMap<string, boolean>,
  tool: Pick<ToolDefinition, "name" | "access">
): boolean {
  return toolSwitches.get(tool.name) ?? IS_TOOL_ON_BY_DEFAULT[tool.access]
}

/**
 * Gets the choice for one tool.
 *
 * @param toolSettings - Saved switches and approvals.
 * @param tool - Name and access of the tool.
 * @returns A frozen choice: whether the tool is on, from {@link isToolOn},
 * and Just run only when its name is saved as Just run, so a tool asks first
 * by default, network tools included.
 */
export function getToolChoice(
  toolSettings: ToolSettings,
  tool: Pick<ToolDefinition, "name" | "access">
): ToolChoice {
  return Object.freeze({
    isOn: isToolOn(toolSettings.switches, tool),
    approval: getToolApproval(toolSettings.justRunToolNames, tool.name)
  })
}

/**
 * Whether the next chat request offers tools, which, and what it tells the
 * backend about the tools it does not offer.
 *
 * @remarks `unavailable` means the request would offer tools but the tool
 * list cannot be read; the request then fails instead of being sent without
 * them. The switched-off names, the switched-on tools that cannot run now,
 * and `tool-calls-off` let the backend tell the model why a tool it needs
 * cannot be used.
 */
export type ChatToolOfferResult =
  | {
      /** The request offers these tools. */
      readonly status: "offered"
      /** Switched-on tools the request offers. */
      readonly offer: ChatToolOffer
      /**
       * Listed Lys tools whose switch is off, in list order; empty when every
       * listed tool is on.
       */
      readonly switchedOffToolNames: readonly string[]
      /**
       * Switched-on backend tools that cannot run now, each with why, in
       * list order; empty when every switched-on tool can run.
       */
      readonly unavailableTools: readonly UnavailableBackendTool[]
    }
  | {
      /** The request offers no tools; the reply answers in one round. */
      readonly status: "not-offered"
      /**
       * Listed Lys tools whose switch is off, in list order; empty when the
       * list was not read or every listed tool is on.
       */
      readonly switchedOffToolNames: readonly string[]
      /**
       * Switched-on backend tools that cannot run now, each with why, in
       * list order; empty when the list was not read or none is.
       */
      readonly unavailableTools: readonly UnavailableBackendTool[]
    }
  | {
      /**
       * Tool calls are off: the request offers no tools and names none, and
       * tells the backend tool calls are off.
       */
      readonly status: "tool-calls-off"
    }
  | {
      /** The request would offer tools, but the list could not be read. */
      readonly status: "unavailable"
      /** User-presentable reason with the action that resolves it. */
      readonly error: string
    }

/**
 * Tool fields of a chat or context-measurement request, each present only
 * when it holds something.
 */
export type ChatToolFields = Pick<
  ChatApiRequestBody,
  | "tools"
  | "switchedOffToolNames"
  | "unavailableTools"
  | "areToolCallsSwitchedOff"
>

/** Switched-off names of a request that names no switched-off tool. */
const NO_SWITCHED_OFF_TOOL_NAMES: readonly string[] = Object.freeze([])

/** Unavailable tools of a request that names none. */
const NO_UNAVAILABLE_TOOLS: readonly UnavailableBackendTool[] = Object.freeze(
  []
)

/**
 * Shared outcome of a request that offers no tools and names none as
 * switched off or unable to run.
 */
export const NO_CHAT_TOOL_OFFER: ChatToolOfferResult = Object.freeze({
  status: "not-offered",
  switchedOffToolNames: NO_SWITCHED_OFF_TOOL_NAMES,
  unavailableTools: NO_UNAVAILABLE_TOOLS
})

/** Shared outcome of a request sent while tool calls are off. */
export const TOOL_CALLS_OFF_OFFER: ChatToolOfferResult = Object.freeze({
  status: "tool-calls-off"
})

/** Tool settings a chat request's offer is built from. */
export type BuildChatToolOfferInput = {
  /** Lifecycle of the tool list, read before building. */
  readonly list: ToolListState
  /** Whether agents may call tools at all. */
  readonly areToolCallsOn: boolean
  /** Switches the person changed, keyed by tool name. */
  readonly toolSwitches: ReadonlyMap<string, boolean>
}

/** Action that lets the person chat when the tool list cannot be read. */
const TOOL_LIST_RECOVERY_ACTION =
  "Turn tool calls off in Settings → Tools to chat without them."

/**
 * Builds the tool offer of one chat request, and the tools it names as
 * switched off or unable to run, from the tool list.
 *
 * @param input - Tool list, the tool-calls switch, and each tool's switch.
 * The caller has already checked that the loaded model was trained for tool
 * use.
 * @returns {@link TOOL_CALLS_OFF_OFFER} when tool calls are off, whatever
 * the list's state; `unavailable` when they are on and the list was not
 * read; otherwise `offered` with the definitions of the switched-on desktop
 * tools and the names of the switched-on backend and MCP tools that can run
 * now, each in list order, or `not-offered` when no such tool is on. Both
 * name every listed Lys tool whose switch is off, and every switched-on
 * backend tool that cannot run now with the list's reason, each in list
 * order. MCP tools are never named in either list: one server may list more
 * tools than a request may name, and the list never says one cannot run.
 * Each tool is sorted once.
 */
export function buildChatToolOffer(
  input: BuildChatToolOfferInput
): ChatToolOfferResult {
  if (!input.areToolCallsOn) return TOOL_CALLS_OFF_OFFER
  const { list } = input
  if (list.status !== "loaded") {
    const reason =
      list.status === "failed" ? list.error : "Lys couldn't read its tool list."

    return Object.freeze({
      status: "unavailable",
      error: `${reason} ${TOOL_LIST_RECOVERY_ACTION}`
    })
  }

  const { onTools, ...unoffered } = buildToolOfferPartition(
    list,
    input.toolSwitches
  )
  if (onTools.length === 0) {
    return Object.freeze({ status: "not-offered", ...unoffered })
  }

  const offer = buildToolOffer(onTools)
  return Object.freeze({ status: "offered", offer, ...unoffered })
}

/**
 * The listed tools split by how one chat request treats them.
 *
 * @remarks Every listed tool is in at most one list, each in list order. An
 * MCP tool is either offered or in neither named list.
 */
type ToolOfferPartition = {
  /** Switched-on tools that can run now, which the request offers. */
  readonly onTools: readonly ToolDefinition[]
  /** Frozen names of the listed Lys tools whose switch is off. */
  readonly switchedOffToolNames: readonly string[]
  /**
   * Frozen switched-on backend tools that cannot run now, each with the
   * list's reason.
   */
  readonly unavailableTools: readonly UnavailableBackendTool[]
}

/**
 * Builds the partition of the listed tools by whether a request offers
 * each one or names it as unoffered.
 *
 * @param list - The loaded tool list.
 * @param toolSwitches - Saved switch choices, keyed by tool name.
 * @returns The partition of the listed tools: the switched-on tools that can
 * run now, the names of the Lys tools whose switch is off, and the
 * switched-on backend tools that cannot run now.
 */
function buildToolOfferPartition(
  list: Extract<ToolListState, { status: "loaded" }>,
  toolSwitches: ReadonlyMap<string, boolean>
): ToolOfferPartition {
  const switchedOffToolNames: string[] = []
  const unavailableTools: UnavailableBackendTool[] = []
  const onTools: ToolDefinition[] = []
  for (const tool of list.tools) {
    const reason = list.unavailableTools.get(tool.name)
    const isNamedUnoffered = tool.runner !== "mcp"
    if (!isToolOn(toolSwitches, tool)) {
      if (isNamedUnoffered) switchedOffToolNames.push(tool.name)
    } else if (reason === undefined) onTools.push(tool)
    else if (isNamedUnoffered)
      unavailableTools.push(Object.freeze({ name: tool.name, reason }))
  }
  return {
    onTools,
    switchedOffToolNames: Object.freeze(switchedOffToolNames),
    unavailableTools: Object.freeze(unavailableTools)
  }
}

/**
 * Builds the tool fields of a request built from one offer.
 *
 * @param toolOffer - Offer of the request.
 * @returns A new object: `areToolCallsSwitchedOff` alone for a
 * `tool-calls-off` offer; otherwise `tools` only when the offer offers
 * tools, `switchedOffToolNames` only when it names a switched-off tool, and
 * `unavailableTools` only when it names one that cannot run; empty for an
 * `unavailable` offer.
 */
export function buildChatToolFields(
  toolOffer: ChatToolOfferResult
): ChatToolFields {
  switch (toolOffer.status) {
    case "unavailable":
      return {}
    case "tool-calls-off":
      return { areToolCallsSwitchedOff: true }
    case "offered":
    case "not-offered": {
      const { switchedOffToolNames, unavailableTools } = toolOffer
      return {
        ...(toolOffer.status === "offered" ? { tools: toolOffer.offer } : {}),
        ...(switchedOffToolNames.length === 0 ? {} : { switchedOffToolNames }),
        ...(unavailableTools.length === 0 ? {} : { unavailableTools })
      }
    }
  }
}

/**
 * Builds the offer of the tools a request offers.
 *
 * @param onTools - Switched-on tools that can run now, at least one, in
 * list order.
 * @returns A frozen offer: the desktop tools' definitions, and the names of
 * the tools from the backend's list, its own and its MCP servers', when
 * there is any, each in list order.
 */
function buildToolOffer(onTools: readonly ToolDefinition[]): ChatToolOffer {
  const definitions = Object.freeze(
    onTools.filter((tool) => tool.runner === "client")
  )
  const backendToolNames = onTools
    .filter((tool) => tool.runner !== "client")
    .map((tool) => tool.name)

  return Object.freeze(
    backendToolNames.length === 0
      ? { definitions }
      : { definitions, backendToolNames: Object.freeze(backendToolNames) }
  )
}

/**
 * Builds the list of every tool from the desktop's and the backend's lists.
 *
 * @param clientTools - The desktop's tools, each name once.
 * @param backendTools - The backend's tools, its own and then its MCP
 * servers', each name once.
 * @returns A frozen list: the desktop's tools, then the backend's.
 * @throws If a desktop tool and a backend tool share a name, because a chat
 * request could not offer both.
 */
function buildToolList(
  clientTools: readonly ToolDefinition[],
  backendTools: readonly ToolDefinition[]
): readonly ToolDefinition[] {
  const clientToolNames = new Set(clientTools.map((tool) => tool.name))
  const sharedName = backendTools.find((tool) =>
    clientToolNames.has(tool.name)
  )?.name
  if (sharedName !== undefined) {
    throw new Error(
      `the app and the backend both have a tool named ${sharedName}.`
    )
  }

  return Object.freeze([...clientTools, ...backendTools])
}

/**
 * Formats why the tools could not be read.
 *
 * @param error - Value either list read rejected with.
 * @returns A sentence for the pane's status line, with the reason when the
 * rejection carries one.
 */
function formatToolListError(error: unknown): string {
  return error instanceof Error && error.message
    ? `Lys couldn't read its tool list: ${error.message}`
    : "Lys couldn't read its tool list."
}

/**
 * Creates one independently owned tool store.
 *
 * @param dependencies - Readers of the desktop's and the backend's tool
 * lists.
 * @returns A Zustand hook and store API owning the Tools pane's list and its
 * session-only tool-calls switch.
 */
function createToolStore(
  dependencies: ToolStoreDependencies
): UseBoundStore<StoreApi<ToolStore>> {
  /** List read in flight; a read requested meanwhile joins it. */
  let pendingListRead: Promise<void> | undefined

  /**
   * Resets the list read in flight to none, discarding the settled read so the
   * next request starts a new one.
   */
  function resetPendingListRead(): void {
    pendingListRead = undefined
  }

  /**
   * Creates the state and actions that own this store's lifecycle.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @returns Initial tool state and its actions.
   */
  function createToolStoreState(
    set: StoreApi<ToolStore>["setState"]
  ): ToolStore {
    /**
     * Reads both tool lists and commits the merged list or the failure.
     *
     * @returns A promise that resolves after the outcome is committed.
     */
    async function readToolList(): Promise<void> {
      set({ list: LOADING_TOOL_LIST })
      try {
        const [clientTools, backendTools] = await Promise.all([
          dependencies.listClientTools(),
          dependencies.listBackendTools()
        ])
        const tools = buildToolList(clientTools, backendTools.tools)
        set({
          list: Object.freeze({
            status: "loaded",
            tools,
            unavailableTools: backendTools.unavailableTools
          })
        })
      } catch (error) {
        const message = formatToolListError(error)
        set({ list: Object.freeze({ status: "failed", error: message }) })
      }
    }

    /**
     * Reads both tool lists, joining a read already in flight.
     *
     * @returns A promise that resolves after the list or the failure is
     * committed.
     */
    function loadTools(): Promise<void> {
      pendingListRead ??= readToolList().finally(resetPendingListRead)

      return pendingListRead
    }

    /**
     * Reads both tool lists in a read that starts after the read in flight.
     *
     * @returns A promise that resolves after the list or the failure is
     * committed.
     */
    async function loadToolsAgain(): Promise<void> {
      // A pending read never rejects; it commits its failure instead.
      if (pendingListRead !== undefined) await pendingListRead
      await loadTools()
    }

    return {
      list: Object.freeze({ status: "idle" }),
      areToolCallsOn: true,
      loadTools,
      loadToolsAgain,
      updateToolCallsOn: (areToolCallsOn) => set({ areToolCallsOn })
    }
  }

  return create<ToolStore>(createToolStoreState)
}

/**
 * Tool store used by the Tools settings pane, the chat view, and the
 * tool-call store.
 *
 * @remarks This singleton owns the list of every tool, read from the desktop
 * and from the backend origin the application store names when each read
 * starts, and whether tool calls are on, which lasts for the session only;
 * nothing here is saved. Each tool's switch and approval belong to the
 * application store, which saves them in the settings file, where the
 * backend's tool approval service reads the approvals. The chat view offers
 * the switched-on tools that can run to a model trained for tool use, and
 * names the switched-off ones and the switched-on ones that cannot run, or
 * says tool calls are off.
 */
export const useToolStore: UseBoundStore<StoreApi<ToolStore>> = createToolStore(
  {
    listClientTools: listTools,
    listBackendTools: () =>
      listBackendTools({ backendUrl: useLysStore.getState().backendUrl })
  }
)

/**
 * vmo states after which the backend may list `read_page` differently: vmo
 * started answering, stopped, or stopped answering.
 */
const VMO_STATUSES_CHANGING_TOOLS: ReadonlySet<VmoServerStatus> = new Set([
  "running",
  "stopped",
  "unresponsive"
])

/** Application state the tool-list refresh observes. */
type ToolListRefreshState = Pick<
  ReturnType<typeof useLysStore.getState>,
  "backendServerInfo" | "vmoServerInfo"
>

/**
 * Answers whether an application state change can change the tools the
 * running backend lists.
 *
 * @param state - Application state after the change.
 * @param previousState - Application state before the change.
 * @returns True when the backend started running, or when vmo started
 * running, stopped, or stopped answering while the backend runs.
 */
function canChangeBackendToolList(
  state: ToolListRefreshState,
  previousState: ToolListRefreshState
): boolean {
  if (state.backendServerInfo.status !== "running") return false
  if (previousState.backendServerInfo.status !== "running") return true
  const vmoStatus = state.vmoServerInfo.status
  return (
    vmoStatus !== previousState.vmoServerInfo.status &&
    VMO_STATUSES_CHANGING_TOOLS.has(vmoStatus)
  )
}

/**
 * Reads a tool list already read again after an application state change
 * that can change the tools the running backend lists.
 *
 * @param state - Application state after the change.
 * @param previousState - Application state before the change.
 * @remarks A list never read is left alone. The read is not awaited: it
 * never rejects and commits its own outcome to the list.
 */
function handleApplicationStateChange(
  state: ToolListRefreshState,
  previousState: ToolListRefreshState
): void {
  if (!canChangeBackendToolList(state, previousState)) return
  const toolStore = useToolStore.getState()
  if (toolStore.list.status === "idle") return
  void toolStore.loadToolsAgain()
}

/**
 * Starts reading a tool list already read again whenever the backend's
 * answer may have changed.
 *
 * @returns The unsubscribe, which stops the refresh; calling it again does
 * nothing.
 * @remarks Subscribes to the application store. When the backend starts
 * running, or vmo starts running, stops, or stops answering while the
 * backend runs, {@link ToolStoreActions.loadToolsAgain} reads the list
 * again, so the Tools pane locks or unlocks `read_page` without waiting for
 * a refused turn. A list never read is left alone: whoever needs it first
 * reads it then. The application shell registers it once while it is
 * mounted; nothing subscribes when this module is evaluated.
 */
export function registerToolListRefresh(): () => void {
  return useLysStore.subscribe(handleApplicationStateChange)
}
