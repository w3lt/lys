import type { BackendToolUnavailableReason, ChatToolOffer } from "@lys/protocol"
import type { ToolAccess, ToolDefinition } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import { listBackendTools, type BackendToolList } from "@/lib/apis/http/tools"
import { listTools } from "@/lib/apis/tauri/tools"
import { useLysStore } from "@/lib/store"
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
 * Everything a tool's choice is read from: the switches the tool store owns
 * for this session and the approvals the application store saves.
 */
export type ToolChoices = {
  /** Tools the person switched on or off in this session, by name. */
  readonly switches: ReadonlyMap<string, boolean>
  /** Tools saved as Just run; every other tool asks first. */
  readonly justRunToolNames: ReadonlySet<string>
}

/**
 * Whether a tool the person has not switched in this session is on, by what
 * the tool does with the machine.
 *
 * @remarks A tool that only reads data on this machine starts on; a tool
 * that sends requests off the machine starts off.
 */
const IS_TOOL_ON_BY_DEFAULT = Object.freeze({
  reads: true,
  network: false
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
        BackendToolUnavailableReason
      >
    }
  | {
      /** The latest read of either list failed. */
      readonly status: "failed"
      /** User-presentable reason. */
      readonly error: string
    }

/** Observable state of the Tools pane's switches, kept for the session only. */
type ToolStoreState = {
  /** Lifecycle of the list of every tool. */
  readonly list: ToolListState
  /** Whether agents may call tools at all; on until switched off. */
  readonly areToolCallsOn: boolean
  /**
   * Whether each tool the person switched in this session is on, keyed by
   * tool name. A tool without an entry is on or off as {@link isToolOn}
   * says it starts.
   */
  readonly toolSwitches: ReadonlyMap<string, boolean>
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
   * such as vmo becoming ready. A read requested while it waits joins the
   * same next read.
   */
  reloadTools: () => Promise<void>
  /**
   * Switches tool calls on or off for every agent.
   *
   * @param areToolCallsOn - Whether agents may call tools.
   */
  updateToolCallsOn: (areToolCallsOn: boolean) => void
  /**
   * Switches one tool on or off for this session.
   *
   * @param tool - Definition of a listed tool.
   * @param isOn - Whether the tool is offered to the model.
   */
  updateToolOn: (tool: ToolDefinition, isOn: boolean) => void
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
 * @param toolSwitches - Switches the person changed in this session, keyed
 * by tool name.
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
 * @param toolChoices - Session switches and saved approvals.
 * @param tool - Name and access of the tool.
 * @returns A frozen choice: whether the tool is on, from {@link isToolOn},
 * and Just run only when its name is saved as Just run, so a tool asks first
 * by default, network tools included.
 */
export function getToolChoice(
  toolChoices: ToolChoices,
  tool: Pick<ToolDefinition, "name" | "access">
): ToolChoice {
  return Object.freeze({
    isOn: isToolOn(toolChoices.switches, tool),
    approval: getToolApproval(toolChoices.justRunToolNames, tool.name)
  })
}

/**
 * Whether the next chat request offers tools, and which.
 *
 * @remarks `unavailable` means the request would offer tools but the tool
 * list cannot be read; the request then fails instead of being sent without
 * them.
 */
export type ChatToolOfferResult =
  | {
      /** The request offers these tools. */
      readonly status: "offered"
      /** Switched-on tools the request offers. */
      readonly offer: ChatToolOffer
    }
  | {
      /** The request offers no tools; the reply answers in one round. */
      readonly status: "not-offered"
    }
  | {
      /** The request would offer tools, but the list could not be read. */
      readonly status: "unavailable"
      /** User-presentable reason with the action that resolves it. */
      readonly error: string
    }

/** Shared outcome of a request that offers no tools. */
export const NO_CHAT_TOOL_OFFER: ChatToolOfferResult = Object.freeze({
  status: "not-offered"
})

/** Tool settings a chat request's offer is built from. */
export type BuildChatToolOfferInput = {
  /** Lifecycle of the tool list, read before building. */
  readonly list: ToolListState
  /** Switches the person changed, keyed by tool name. */
  readonly toolSwitches: ReadonlyMap<string, boolean>
}

/** Action that lets the person chat when the tool list cannot be read. */
const TOOL_LIST_RECOVERY_ACTION =
  "Turn tool calls off in Settings → Tools to chat without them."

/**
 * Builds the tool offer of one chat request from a read tool list.
 *
 * @param input - Tool list and the person's choices. The caller has already
 * checked that tool calls are on and that the loaded model was trained for
 * tool use.
 * @returns `offered` with the definitions of the switched-on desktop tools
 * and the names of the switched-on backend tools that can run now, each in
 * list order; `not-offered` when no such tool is on; or `unavailable` when
 * the list was not read. A backend tool that cannot run now is never
 * offered, whatever its switch says.
 */
export function buildChatToolOffer({
  list,
  toolSwitches
}: BuildChatToolOfferInput): ChatToolOfferResult {
  if (list.status !== "loaded") {
    const reason =
      list.status === "failed" ? list.error : "Lys couldn't read its tool list."

    return Object.freeze({
      status: "unavailable",
      error: `${reason} ${TOOL_LIST_RECOVERY_ACTION}`
    })
  }

  const onTools = list.tools.filter(
    (tool) =>
      isToolOn(toolSwitches, tool) && !list.unavailableTools.has(tool.name)
  )
  if (onTools.length === 0) return NO_CHAT_TOOL_OFFER

  const definitions = Object.freeze(
    onTools.filter((tool) => tool.runner === "client")
  )
  const backendToolNames = onTools
    .filter((tool) => tool.runner === "backend")
    .map((tool) => tool.name)
  const offer: ChatToolOffer = Object.freeze(
    backendToolNames.length === 0
      ? { definitions }
      : { definitions, backendToolNames: Object.freeze(backendToolNames) }
  )

  return Object.freeze({ status: "offered", offer })
}

/**
 * Builds the tool switches with one tool's switch replaced.
 *
 * @param toolSwitches - Current switches, left unchanged.
 * @param toolName - Name of the tool whose switch is replaced.
 * @param isOn - Whether the tool is offered to the model.
 * @returns A new map holding every current switch and the replacement.
 */
function buildToolSwitches(
  toolSwitches: ReadonlyMap<string, boolean>,
  toolName: string,
  isOn: boolean
): ReadonlyMap<string, boolean> {
  const nextToolSwitches = new Map(toolSwitches)
  nextToolSwitches.set(toolName, isOn)

  return nextToolSwitches
}

/**
 * Builds the list of every tool from the desktop's and the backend's lists.
 *
 * @param clientTools - The desktop's tools, each name once.
 * @param backendTools - The backend's tools, each name once.
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
 * session-only switches.
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
    async function reloadTools(): Promise<void> {
      // A pending read never rejects; it commits its failure instead.
      if (pendingListRead !== undefined) await pendingListRead
      await loadTools()
    }

    /**
     * Switches one tool on or off for this session.
     *
     * @param tool - Definition of a listed tool.
     * @param isOn - Whether the tool is offered to the model.
     */
    function updateToolOn(tool: ToolDefinition, isOn: boolean): void {
      set((state) => ({
        toolSwitches: buildToolSwitches(state.toolSwitches, tool.name, isOn)
      }))
    }

    return {
      list: Object.freeze({ status: "idle" }),
      areToolCallsOn: true,
      toolSwitches: new Map(),
      loadTools,
      reloadTools,
      updateToolCallsOn: (areToolCallsOn) => set({ areToolCallsOn }),
      updateToolOn
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
 * starts, and the person's switches: tool calls on or off and each tool on
 * or off. The switches last for the session only; nothing here is saved.
 * Each tool's approval belongs to the application store, which saves it in
 * the settings file, where the backend's tool approval service reads it. The
 * chat view offers the switched-on tools to a model trained for tool use.
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

/**
 * Starts reading the tool list again whenever vmo's state may change whether
 * the backend offers `read_page`.
 *
 * @returns The unsubscribe, which stops the refresh; calling it again does
 * nothing.
 * @remarks Subscribes to the application store. When vmo's status changes
 * to running, stopped, or unresponsive while the backend runs,
 * {@link ToolStoreActions.reloadTools} reads the list again, so the Tools
 * pane locks or unlocks `read_page` without waiting for a refused turn. The
 * application shell registers it once while it is mounted; nothing subscribes
 * when this module is evaluated.
 */
export function registerVmoToolListRefresh(): () => void {
  return useLysStore.subscribe((state, previousState) => {
    const vmoStatus = state.vmoServerInfo.status
    if (vmoStatus === previousState.vmoServerInfo.status) return
    if (!VMO_STATUSES_CHANGING_TOOLS.has(vmoStatus)) return
    if (state.backendServerInfo.status !== "running") return
    void useToolStore.getState().reloadTools()
  })
}
