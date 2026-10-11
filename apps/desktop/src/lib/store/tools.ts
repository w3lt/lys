import type { ChatToolOffer } from "@lys/protocol"
import type { ToolAccess, ToolDefinition } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import { listBackendTools } from "@/lib/apis/http/tools"
import { listTools } from "@/lib/apis/tauri/tools"
import { useLysStore } from "@/lib/store"

/** Every approval the Tools pane offers for a tool, in display order. */
export const TOOL_APPROVALS = Object.freeze(["ask", "run"] as const)

/**
 * When a tool runs once the model asks for it: `ask` waits for the person to
 * say yes, and `run` runs it at once.
 *
 * @remarks The tool-call store applies it when each call arrives.
 */
export type ToolApproval = (typeof TOOL_APPROVALS)[number]

/** Choice the person made in the Tools pane for one tool. */
export type ToolChoice = {
  /** Whether the tool is offered to the model. */
  readonly isOn: boolean
  /** When the tool runs once the model asks for it. */
  readonly approval: ToolApproval
}

/**
 * Choice of a tool the person has not changed in this session, by what the
 * tool does with the machine.
 *
 * @remarks A tool that only reads data on this machine starts on; a tool
 * that sends requests off the machine starts off. Every tool asks first until
 * the person picks Just run, which lasts for this session only.
 */
const DEFAULT_TOOL_CHOICES = Object.freeze({
  reads: Object.freeze({ isOn: true, approval: "ask" }),
  network: Object.freeze({ isOn: false, approval: "ask" })
} satisfies Readonly<Record<ToolAccess, ToolChoice>>)

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
    }
  | {
      /** The latest read of either list failed. */
      readonly status: "failed"
      /** User-presentable reason. */
      readonly error: string
    }

/** Observable state of the Tools pane, kept for the session only. */
type ToolStoreState = {
  /** Lifecycle of the list of every tool. */
  readonly list: ToolListState
  /** Whether agents may call tools at all; on until switched off. */
  readonly areToolCallsOn: boolean
  /**
   * Choices the person changed, keyed by tool name. A tool without an entry
   * uses the default choice that {@link getToolChoice} returns.
   */
  readonly toolChoices: ReadonlyMap<string, ToolChoice>
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
   * Switches tool calls on or off for every agent.
   *
   * @param areToolCallsOn - Whether agents may call tools.
   */
  updateToolCallsOn: (areToolCallsOn: boolean) => void
  /**
   * Switches one tool on or off, keeping its approval.
   *
   * @param tool - Definition of a listed tool.
   * @param isOn - Whether the tool is offered to the model.
   */
  updateToolOn: (tool: ToolDefinition, isOn: boolean) => void
  /**
   * Replaces when one tool runs, keeping whether it is on.
   *
   * @param tool - Definition of a listed tool.
   * @param approval - When the tool runs once the model asks for it.
   */
  updateToolApproval: (tool: ToolDefinition, approval: ToolApproval) => void
}

/** Complete contract of the Tools pane store. */
type ToolStore = ToolStoreState & ToolStoreActions

/** Runtime dependencies of one tool store. */
type ToolStoreDependencies = {
  /** Lists the desktop's tools; rejects when the list cannot be read. */
  readonly listClientTools: () => Promise<readonly ToolDefinition[]>
  /** Lists the backend's tools; rejects when the list cannot be read. */
  readonly listBackendTools: () => Promise<readonly ToolDefinition[]>
}

/** List state while a read is pending. */
const LOADING_TOOL_LIST: ToolListState = Object.freeze({ status: "loading" })

/**
 * Gets the choice for one tool.
 *
 * @param toolChoices - Choices the person changed in this session, keyed by
 * tool name.
 * @param tool - Name and access of the tool.
 * @returns The tool's changed choice, or, when the person has not changed
 * it, the default for its access: asking first, and on unless the tool sends
 * requests off this machine.
 */
export function getToolChoice(
  toolChoices: ReadonlyMap<string, ToolChoice>,
  tool: Pick<ToolDefinition, "name" | "access">
): ToolChoice {
  return toolChoices.get(tool.name) ?? DEFAULT_TOOL_CHOICES[tool.access]
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
  /** Choices the person changed, keyed by tool name. */
  readonly toolChoices: ReadonlyMap<string, ToolChoice>
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
 * and the names of the switched-on backend tools, each in list order;
 * `not-offered` when no tool is on; or `unavailable` when the list was not
 * read.
 */
export function buildChatToolOffer({
  list,
  toolChoices
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
    (tool) => getToolChoice(toolChoices, tool).isOn
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
 * Builds the tool choices with one tool's choice replaced.
 *
 * @param toolChoices - Current choices, left unchanged.
 * @param toolName - Name of the tool whose choice is replaced.
 * @param choice - Complete replacement choice.
 * @returns A new map holding every current choice and the replacement.
 */
function buildToolChoices(
  toolChoices: ReadonlyMap<string, ToolChoice>,
  toolName: string,
  choice: ToolChoice
): ReadonlyMap<string, ToolChoice> {
  const nextToolChoices = new Map(toolChoices)
  nextToolChoices.set(toolName, choice)

  return nextToolChoices
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
 * session-only choices.
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
        const tools = buildToolList(clientTools, backendTools)
        set({ list: Object.freeze({ status: "loaded", tools }) })
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
     * Switches one tool on or off, keeping its approval.
     *
     * @param tool - Definition of a listed tool.
     * @param isOn - Whether the tool is offered to the model.
     */
    function updateToolOn(tool: ToolDefinition, isOn: boolean): void {
      set((state) => {
        const { approval } = getToolChoice(state.toolChoices, tool)
        const choice = Object.freeze({ isOn, approval } satisfies ToolChoice)

        return {
          toolChoices: buildToolChoices(state.toolChoices, tool.name, choice)
        }
      })
    }

    /**
     * Replaces when one tool runs, keeping whether it is on.
     *
     * @param tool - Definition of a listed tool.
     * @param approval - When the tool runs once the model asks for it.
     */
    function updateToolApproval(
      tool: ToolDefinition,
      approval: ToolApproval
    ): void {
      set((state) => {
        const { isOn } = getToolChoice(state.toolChoices, tool)
        const choice = Object.freeze({ isOn, approval } satisfies ToolChoice)

        return {
          toolChoices: buildToolChoices(state.toolChoices, tool.name, choice)
        }
      })
    }

    return {
      list: Object.freeze({ status: "idle" }),
      areToolCallsOn: true,
      toolChoices: new Map(),
      loadTools,
      updateToolCallsOn: (areToolCallsOn) => set({ areToolCallsOn }),
      updateToolOn,
      updateToolApproval
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
 * starts, and the person's choices: tool calls on or off and each tool's
 * switch and approval. The chat view offers the switched-on tools to a model
 * trained for tool use, and the tool-call store applies each tool's approval.
 * The choices last for the session only; nothing is saved.
 */
export const useToolStore: UseBoundStore<StoreApi<ToolStore>> = createToolStore(
  {
    listClientTools: listTools,
    listBackendTools: () =>
      listBackendTools({ backendUrl: useLysStore.getState().backendUrl })
  }
)
