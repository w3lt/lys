import type { ListToolsResult } from "@lys/protocol"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import { listTools } from "@/lib/apis/tauri/tools"

/** Every number of calls per reply the Tools pane offers, smallest first. */
export const CALLS_PER_REPLY_OPTIONS = Object.freeze([4, 8, 16] as const)

/**
 * Number of tool calls a reply may make before it has to answer.
 *
 * @remarks The Tools pane mocks the choice: nothing enforces it yet.
 */
export type CallsPerReply = (typeof CALLS_PER_REPLY_OPTIONS)[number]

/** Calls per reply until the person picks another number in this session. */
const DEFAULT_CALLS_PER_REPLY: CallsPerReply = 8

/** Every approval the Tools pane offers for a tool, in display order. */
export const TOOL_APPROVALS = Object.freeze(["ask", "run"] as const)

/**
 * When a tool runs once the model asks for it: `ask` waits for the person to
 * say yes, and `run` runs it at once.
 *
 * @remarks The Tools pane mocks the choice: nothing asks before a tool runs
 * yet.
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
 * Choice of a tool the person has not changed in this session: on, and run
 * at once.
 *
 * @remarks Every current tool only reads data on this machine, and such
 * tools start on; a tool that sends data off the machine would start off.
 */
const DEFAULT_TOOL_CHOICE: ToolChoice = Object.freeze({
  isOn: true,
  approval: "run"
})

/** Lifecycle of the list of client tools read from the desktop. */
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
      /** The list was read. */
      readonly status: "loaded"
      /** Every client tool, in the order Settings lists them. */
      readonly tools: ListToolsResult
    }
  | {
      /** The latest read failed. */
      readonly status: "failed"
      /** User-presentable reason. */
      readonly error: string
    }

/** Observable state of the Tools pane, kept for the session only. */
type ToolStoreState = {
  /** Lifecycle of the list of client tools. */
  readonly list: ToolListState
  /** Whether agents may call tools at all; on until switched off. */
  readonly areToolCallsOn: boolean
  /** Number of tool calls a reply may make before it has to answer. */
  readonly callsPerReply: CallsPerReply
  /**
   * Choices the person changed, keyed by tool name. A tool without an entry
   * uses the default choice that {@link getToolChoice} returns.
   */
  readonly toolChoices: ReadonlyMap<string, ToolChoice>
}

/** Actions of the Tools pane store. */
type ToolStoreActions = {
  /**
   * Reads the client tools from the desktop.
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
   * Replaces the number of tool calls a reply may make.
   *
   * @param callsPerReply - One of {@link CALLS_PER_REPLY_OPTIONS}.
   */
  updateCallsPerReply: (callsPerReply: CallsPerReply) => void
  /**
   * Switches one tool on or off, keeping its approval.
   *
   * @param toolName - Name of a listed tool.
   * @param isOn - Whether the tool is offered to the model.
   */
  updateToolOn: (toolName: string, isOn: boolean) => void
  /**
   * Replaces when one tool runs, keeping whether it is on.
   *
   * @param toolName - Name of a listed tool.
   * @param approval - When the tool runs once the model asks for it.
   */
  updateToolApproval: (toolName: string, approval: ToolApproval) => void
}

/** Complete contract of the Tools pane store. */
type ToolStore = ToolStoreState & ToolStoreActions

/** Runtime dependency of one tool store. */
type ToolStoreDependencies = {
  /** Lists every client tool; rejects when the list cannot be read. */
  readonly listTools: () => Promise<ListToolsResult>
}

/** List state while a read is pending. */
const LOADING_TOOL_LIST: ToolListState = Object.freeze({ status: "loading" })

/**
 * Gets the choice for one tool.
 *
 * @param toolChoices - Choices the person changed in this session, keyed by
 * tool name.
 * @param toolName - Name of the tool.
 * @returns The tool's changed choice, or the default choice, on and run at
 * once, when the person has not changed it.
 */
export function getToolChoice(
  toolChoices: ReadonlyMap<string, ToolChoice>,
  toolName: string
): ToolChoice {
  return toolChoices.get(toolName) ?? DEFAULT_TOOL_CHOICE
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
 * Formats why the client tools could not be read.
 *
 * @param error - Value the list read rejected with.
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
 * @param dependencies - Reader of the client tool list.
 * @returns A Zustand hook and store API owning the Tools pane's list and its
 * session-only choices.
 */
function createToolStore(
  dependencies: ToolStoreDependencies
): UseBoundStore<StoreApi<ToolStore>> {
  /** List read in flight; a read requested meanwhile joins it. */
  let pendingListRead: Promise<void> | undefined

  /** Forgets the settled list read, so the next request starts a new one. */
  function clearPendingListRead(): void {
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
     * Reads the client tools and commits the list or the failure.
     *
     * @returns A promise that resolves after the outcome is committed.
     */
    async function readToolList(): Promise<void> {
      set({ list: LOADING_TOOL_LIST })
      try {
        const tools = await dependencies.listTools()
        set({ list: Object.freeze({ status: "loaded", tools }) })
      } catch (error) {
        const message = formatToolListError(error)
        set({ list: Object.freeze({ status: "failed", error: message }) })
      }
    }

    /**
     * Reads the client tools, joining a read already in flight.
     *
     * @returns A promise that resolves after the list or the failure is
     * committed.
     */
    function loadTools(): Promise<void> {
      pendingListRead ??= readToolList().finally(clearPendingListRead)

      return pendingListRead
    }

    /**
     * Switches one tool on or off, keeping its approval.
     *
     * @param toolName - Name of a listed tool.
     * @param isOn - Whether the tool is offered to the model.
     */
    function updateToolOn(toolName: string, isOn: boolean): void {
      set((state) => {
        const { approval } = getToolChoice(state.toolChoices, toolName)
        const choice = Object.freeze({ isOn, approval } satisfies ToolChoice)

        return {
          toolChoices: buildToolChoices(state.toolChoices, toolName, choice)
        }
      })
    }

    /**
     * Replaces when one tool runs, keeping whether it is on.
     *
     * @param toolName - Name of a listed tool.
     * @param approval - When the tool runs once the model asks for it.
     */
    function updateToolApproval(
      toolName: string,
      approval: ToolApproval
    ): void {
      set((state) => {
        const { isOn } = getToolChoice(state.toolChoices, toolName)
        const choice = Object.freeze({ isOn, approval } satisfies ToolChoice)

        return {
          toolChoices: buildToolChoices(state.toolChoices, toolName, choice)
        }
      })
    }

    return {
      list: Object.freeze({ status: "idle" }),
      areToolCallsOn: true,
      callsPerReply: DEFAULT_CALLS_PER_REPLY,
      toolChoices: new Map(),
      loadTools,
      updateToolCallsOn: (areToolCallsOn) => set({ areToolCallsOn }),
      updateCallsPerReply: (callsPerReply) => set({ callsPerReply }),
      updateToolOn,
      updateToolApproval
    }
  }

  return create<ToolStore>(createToolStoreState)
}

/**
 * Tool store used by the Tools settings pane.
 *
 * @remarks This singleton owns the list of client tools read from the desktop
 * and the choices the pane mocks: tool calls on or off, calls per reply, and
 * each tool's switch and approval. The choices last for the session only;
 * nothing is saved, and nothing reaches the backend or a model.
 */
export const useToolStore: UseBoundStore<StoreApi<ToolStore>> = createToolStore(
  { listTools }
)
