import type {
  ChatReplyEvent,
  ChatReplyPathParams,
  ChatToolCall,
  ChatToolResult,
  ChatToolResultPathParams
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import {
  readChatReplyEvents,
  sendChatToolResult,
  type SendChatToolResultResult
} from "@/lib/apis/http/chat"
import { findFiles, readTextFile } from "@/lib/apis/tauri/tools"
import { useLysStore } from "@/lib/store"
import { useToolStore } from "@/lib/store/tools"

import {
  buildDeclinedToolResult,
  formatRejectedToolCallContent,
  runClientTool,
  type ClientToolCommands,
  type ClientToolInput
} from "./client-tools"
import { calculateToolCallGate, type ToolCallSettings } from "./tool-call-gate"

export type { ClientToolInput } from "./client-tools"

/**
 * Where one held call's answer stands.
 *
 * @remarks Only `awaiting-person` and `send-failed` need the person, so only
 * they are shown. `answered` is final.
 */
export type HeldToolCallAnswer =
  | {
      /** The person must allow or reject the call. */
      readonly status: "awaiting-person"
      /** Definition of the called tool, for its access tag. */
      readonly definition: ToolDefinition
      /** Validated input the call runs with when allowed. */
      readonly input: ClientToolInput
    }
  | {
      /** The tool is running; its answer is not built yet. */
      readonly status: "running"
    }
  | {
      /** The answer is being sent to the backend. */
      readonly status: "sending"
      /** Answer being sent. */
      readonly result: ChatToolResult
    }
  | {
      /** Sending the answer failed; the person can send it again. */
      readonly status: "send-failed"
      /** Answer that was not sent, kept so a retry does not run the tool again. */
      readonly result: ChatToolResult
      /** User-presentable reason. */
      readonly error: string
    }
  | {
      /**
       * The backend took the answer, or no longer waits for it. The call stays
       * held so a snapshot built before the answer arrived does not bring it
       * back.
       */
      readonly status: "answered"
    }

/**
 * One tool call of a followed reply, held until the store stops following
 * that reply.
 */
export type HeldToolCall = {
  /** Call, reply, and conversation the answer is sent to. */
  readonly target: ChatToolResultPathParams
  /** Call as the backend sent it. */
  readonly call: ChatToolCall
  /** Where the call's answer stands. */
  readonly answer: HeldToolCallAnswer
}

/** Held call the composer shows: one that needs the person. */
export type ShownToolCall = HeldToolCall & {
  /** Waiting for the person, or its answer failed to send. */
  readonly answer: Extract<
    HeldToolCallAnswer,
    { status: "awaiting-person" | "send-failed" }
  >
}

/** Observable state of the tool-call store. */
type ToolCallState = {
  /** Every held call, in arrival order. */
  readonly heldCalls: readonly HeldToolCall[]
}

/** Actions of the tool-call store. */
type ToolCallActions = {
  /**
   * Starts following one reply to answer its tool calls.
   *
   * @param target - Reply that is generating, and its conversation.
   * @remarks The store follows the reply on its own connection, independent
   * of the chat view, until the reply ends; a reply it already follows is
   * ignored. Calls on Run run at once, and calls on Ask wait in arrival
   * order. When the following ends, every call of the reply still held is
   * dropped.
   */
  startReplyToolCallFollow: (target: ChatReplyPathParams) => void
  /**
   * Resolves one call that waits for the person: allows it, runs it, and
   * sends its answer.
   *
   * @param callId - Identifier of a held call.
   * @returns A promise that settles once the answer was sent or failed to
   * send; it never rejects. A call that does not wait for the person is
   * ignored, so a repeated press runs the tool once.
   */
  resolveToolCall: (callId: string) => Promise<void>
  /**
   * Rejects one call that waits for the person and sends the rejection.
   *
   * @param callId - Identifier of a held call.
   * @param note - Reason the person typed; may be empty.
   * @returns A promise that settles once the rejection was sent or failed to
   * send; it never rejects. A call that does not wait for the person is
   * ignored.
   */
  rejectToolCall: (callId: string, note: string) => Promise<void>
  /**
   * Sends again the answer of a call whose answer failed to send.
   *
   * @param callId - Identifier of a held call.
   * @returns A promise that settles once the answer was sent or failed again;
   * it never rejects. The tool does not run again. A call whose answer did
   * not fail is ignored.
   */
  sendUnsentToolResult: (callId: string) => Promise<void>
}

/** Complete contract of the tool-call store. */
type ToolCallStore = ToolCallState & ToolCallActions

/**
 * Follows one reply's events.
 *
 * @param target - Followed reply and its conversation.
 * @param signal - Store-owned signal; aborting it ends only this observation.
 * @returns Validated reply events, ending when the backend ends the stream.
 * @throws If opening, reading, or validating the stream fails, or the reply
 * is no longer stored.
 */
type ReplyEventStream = (
  target: ChatReplyPathParams,
  signal: AbortSignal
) => AsyncIterable<ChatReplyEvent>

/** Runtime dependencies of one tool-call store. */
type ToolCallStoreDependencies = {
  /** Follows a reply; the store supplies its owned signal. */
  readonly streamChatReply: ReplyEventStream
  /** Sends one answer; throws when the backend cannot take it. */
  readonly sendChatToolResult: (
    target: ChatToolResultPathParams,
    result: ChatToolResult
  ) => Promise<SendChatToolResultResult>
  /** Gets the tool list and the person's choices; never rejects. */
  readonly getToolCallSettings: () => Promise<ToolCallSettings>
  /** Runs one validated call; never rejects. */
  readonly runClientTool: (input: ClientToolInput) => Promise<ChatToolResult>
}

/** How one follow of a reply ended. */
type ReplyFollowOutcome =
  "reply-ended" | "closed-after-live-events" | "closed-without-live-events"

/** Whether a reply still generates after one of its events. */
type ReplyEventEffect = "reply-continues" | "reply-ended"

/**
 * Follows in a row that may close without any event past the snapshot
 * before the store stops following the reply.
 */
const MAXIMUM_FRUITLESS_REPLY_FOLLOWS = 2

/** Error raised when a reply's stream does not start with a snapshot. */
const REPLY_STREAM_ORDER_MESSAGE = "Reply stream did not start with a snapshot."

/** Shared running answer; it carries no per-call data. */
const RUNNING_ANSWER: HeldToolCallAnswer = Object.freeze({ status: "running" })

/** Shared answered state; it carries no per-call data. */
const ANSWERED_ANSWER: HeldToolCallAnswer = Object.freeze({
  status: "answered"
})

/** Empty held-call list of a store that holds no call. */
const NO_HELD_CALLS: readonly HeldToolCall[] = Object.freeze([])

/**
 * Answers whether a held call needs the person.
 *
 * @param heldCall - Call the store holds.
 * @returns True while it waits for the person or its answer failed to send.
 */
function isShownToolCall(heldCall: HeldToolCall): heldCall is ShownToolCall {
  return (
    heldCall.answer.status === "awaiting-person" ||
    heldCall.answer.status === "send-failed"
  )
}

/**
 * Finds the first call of a conversation that needs the person.
 *
 * @param state - Tool-call store state.
 * @param conversationId - Conversation the chat view shows, if any.
 * @returns The earliest-arrived call of that conversation that waits for the
 * person or whose answer failed to send, or undefined. An unchanged state
 * returns the same call object.
 */
export function findShownToolCall(
  state: ToolCallState,
  conversationId: string | undefined
): ShownToolCall | undefined {
  if (conversationId === undefined) return undefined

  return state.heldCalls
    .filter((heldCall) => heldCall.target.conversationId === conversationId)
    .find(isShownToolCall)
}

/**
 * Formats a value thrown while sending an answer.
 *
 * @param error - Untrusted thrown value.
 * @returns A sentence for the composer's failed-answer card.
 */
function formatToolResultSendError(error: unknown): string {
  return error instanceof Error && error.message
    ? `Couldn't send the answer to Lys: ${error.message}`
    : "Couldn't send the answer to Lys."
}

/**
 * Builds the follows map with one reply's follow added or removed.
 *
 * @param follows - Current follows, left unchanged.
 * @param assistantMessageId - Reply whose follow changes.
 * @param abortController - New follow's controller, or undefined to remove
 * the reply's follow.
 * @returns A new map holding every other follow and the change.
 */
function buildReplyFollows(
  follows: ReadonlyMap<string, AbortController>,
  assistantMessageId: string,
  abortController: AbortController | undefined
): ReadonlyMap<string, AbortController> {
  const nextFollows = new Map(follows)
  if (abortController === undefined) nextFollows.delete(assistantMessageId)
  else nextFollows.set(assistantMessageId, abortController)

  return nextFollows
}

/**
 * Builds the address of one call's answer.
 *
 * @param target - Reply that made the call, and its conversation.
 * @param callId - Identifier of the call.
 * @returns A frozen address.
 */
function buildToolResultTarget(
  target: ChatReplyPathParams,
  callId: string
): ChatToolResultPathParams {
  return Object.freeze({
    conversationId: target.conversationId,
    assistantMessageId: target.assistantMessageId,
    callId
  })
}

/**
 * Creates one independently owned tool-call store.
 *
 * @param dependencies - Reply transport, answer sender, tool settings reader,
 * and tool runner for one store.
 * @returns A Zustand hook and store API owning the held calls and the reply
 * follows that deliver them.
 */
function createToolCallStore(
  dependencies: ToolCallStoreDependencies
): UseBoundStore<StoreApi<ToolCallStore>> {
  /** Controller of each reply this store follows, by assistant message id. */
  let replyFollows: ReadonlyMap<string, AbortController> = new Map()

  /**
   * Creates the state and actions that own this store's held calls.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @param get - Zustand capability that reads current observable state.
   * @returns Initial tool-call state and its actions.
   */
  function createToolCallStoreState(
    set: StoreApi<ToolCallStore>["setState"],
    get: StoreApi<ToolCallStore>["getState"]
  ): ToolCallStore {
    /**
     * Finds a held call.
     *
     * @param callId - Identifier of the call.
     * @returns The held call, or undefined when the store no longer holds it.
     */
    function findHeldToolCall(callId: string): HeldToolCall | undefined {
      return get().heldCalls.find((heldCall) => heldCall.call.id === callId)
    }

    /**
     * Adds a call after every call already held.
     *
     * @param heldCall - Newly held call.
     */
    function addHeldToolCall(heldCall: HeldToolCall): void {
      set((state) => ({
        heldCalls: Object.freeze([...state.heldCalls, heldCall])
      }))
    }

    /**
     * Updates where one held call's answer stands, keeping its place.
     *
     * @param callId - Identifier of the call; nothing changes when it is no
     * longer held.
     * @param answer - New answer state.
     */
    function updateHeldToolCallAnswer(
      callId: string,
      answer: HeldToolCallAnswer
    ): void {
      set((state) => ({
        heldCalls: Object.freeze(
          state.heldCalls.map((heldCall) =>
            heldCall.call.id === callId
              ? Object.freeze({ ...heldCall, answer })
              : heldCall
          )
        )
      }))
    }

    /**
     * Stops the following of one reply and drops its held calls, answered or
     * not.
     *
     * @param assistantMessageId - Reply whose following stops.
     * @param abortController - Controller of the follow that stops; a newer
     * follow of the same reply is left alone.
     */
    function stopReplyToolCallFollow(
      assistantMessageId: string,
      abortController: AbortController
    ): void {
      if (replyFollows.get(assistantMessageId) !== abortController) return

      replyFollows = buildReplyFollows(
        replyFollows,
        assistantMessageId,
        undefined
      )
      set((state) => ({
        heldCalls: Object.freeze(
          state.heldCalls.filter(
            (heldCall) =>
              heldCall.target.assistantMessageId !== assistantMessageId
          )
        )
      }))
      abortController.abort()
    }

    /**
     * Sends one held call's answer and marks the call answered once the
     * backend no longer waits for it.
     *
     * @param callId - Identifier of the call.
     * @param result - Answer to send.
     * @returns A promise that settles after the send; it never rejects. An
     * accepted or not-pending answer marks the call `answered`; a failed send
     * keeps it as `send-failed` with the answer, unless the reply's follow
     * stopped or the call was answered meanwhile.
     */
    async function sendHeldToolResult(
      callId: string,
      result: ChatToolResult
    ): Promise<void> {
      const heldCall = findHeldToolCall(callId)
      if (heldCall === undefined) return

      const sending = Object.freeze({
        status: "sending",
        result
      } satisfies HeldToolCallAnswer)
      updateHeldToolCallAnswer(callId, sending)
      try {
        await dependencies.sendChatToolResult(heldCall.target, result)
        updateHeldToolCallAnswer(callId, ANSWERED_ANSWER)
      } catch (error) {
        if (findHeldToolCall(callId)?.answer.status !== "sending") return
        const sendFailure = Object.freeze({
          status: "send-failed",
          result,
          error: formatToolResultSendError(error)
        } satisfies HeldToolCallAnswer)
        updateHeldToolCallAnswer(callId, sendFailure)
      }
    }

    /**
     * Runs one held call and sends its answer.
     *
     * @param callId - Identifier of the call.
     * @param input - Validated input to run with.
     * @returns A promise that settles after the answer was sent or failed to
     * send; it never rejects. A call that is no longer running when the tool
     * finishes is not answered: its reply's follow stopped, or an earlier
     * answer to the same call reached the backend.
     */
    async function runHeldToolCall(
      callId: string,
      input: ClientToolInput
    ): Promise<void> {
      updateHeldToolCallAnswer(callId, RUNNING_ANSWER)
      const result = await dependencies.runClientTool(input)
      if (findHeldToolCall(callId)?.answer.status !== "running") return

      await sendHeldToolResult(callId, result)
    }

    /**
     * Holds one call of a followed reply and starts answering it as the
     * Tools pane decides.
     *
     * @param target - Reply that made the call, and its conversation.
     * @param call - Call the backend sent.
     * @param settings - Tool list and choices read when the call arrived.
     * @remarks A call already held, including an answered one, is ignored.
     * Running and sending continue on their own and never reject.
     */
    function startToolCallAnswer(
      target: ChatReplyPathParams,
      call: ChatToolCall,
      settings: ToolCallSettings
    ): void {
      if (findHeldToolCall(call.id) !== undefined) return

      const resultTarget = buildToolResultTarget(target, call.id)
      const gate = calculateToolCallGate(call, settings)
      switch (gate.status) {
        case "answered": {
          const answer = Object.freeze({
            status: "sending",
            result: gate.result
          } satisfies HeldToolCallAnswer)
          addHeldToolCall(Object.freeze({ target: resultTarget, call, answer }))
          // Sending never rejects; it records its outcome in the held call.
          void sendHeldToolResult(call.id, gate.result)
          return
        }
        case "run":
          addHeldToolCall(
            Object.freeze({
              target: resultTarget,
              call,
              answer: RUNNING_ANSWER
            })
          )
          // Running never rejects; it records its outcome in the held call.
          void runHeldToolCall(call.id, gate.input)
          return
        case "ask": {
          const answer = Object.freeze({
            status: "awaiting-person",
            definition: gate.definition,
            input: gate.input
          } satisfies HeldToolCallAnswer)
          addHeldToolCall(Object.freeze({ target: resultTarget, call, answer }))
          return
        }
      }
    }

    /**
     * Holds the calls that arrived for a followed reply and starts answering
     * each one as the Tools pane decides.
     *
     * @param target - Reply that made the calls, and its conversation.
     * @param calls - Calls in arrival order: one live call, or the calls a
     * snapshot lists as waiting.
     * @returns A promise that settles once the calls are held. Calls already
     * held, including answered ones, are ignored; when the reply stopped
     * being followed while the settings were read, every call is.
     */
    async function handleToolCallArrival(
      target: ChatReplyPathParams,
      calls: readonly ChatToolCall[]
    ): Promise<void> {
      const arrivedCalls = calls.filter(
        (call) => findHeldToolCall(call.id) === undefined
      )
      if (arrivedCalls.length === 0) return
      const settings = await dependencies.getToolCallSettings()
      if (!replyFollows.has(target.assistantMessageId)) return

      for (const call of arrivedCalls) {
        startToolCallAnswer(target, call, settings)
      }
    }

    /**
     * Handles one event of a followed reply.
     *
     * @param target - Followed reply and its conversation.
     * @param event - Validated reply event.
     * @returns Whether the reply still generates. A snapshot of a reply that
     * is not generating, and a final event, end it.
     */
    async function handleFollowedReplyEvent(
      target: ChatReplyPathParams,
      event: ChatReplyEvent
    ): Promise<ReplyEventEffect> {
      switch (event.type) {
        case "reply-snapshot":
          if (event.assistantMessage.status !== "streaming") {
            return "reply-ended"
          }
          await handleToolCallArrival(target, event.pendingToolCalls)
          return "reply-continues"
        case "tool-call":
          await handleToolCallArrival(target, [event.call])
          return "reply-continues"
        case "title":
        case "delta":
          return "reply-continues"
        case "done":
        case "interrupted":
        case "error":
          return "reply-ended"
      }
    }

    /**
     * Follows one reply once, from its snapshot until the stream closes.
     *
     * @param target - Followed reply and its conversation.
     * @param signal - Store-owned signal of the follow.
     * @returns `reply-ended` when the reply ended, or how the stream closed
     * before it did.
     * @throws If the stream fails, or does not start with exactly one
     * snapshot.
     */
    async function readReplyToolCallEvents(
      target: ChatReplyPathParams,
      signal: AbortSignal
    ): Promise<ReplyFollowOutcome> {
      let hasReadSnapshot = false
      let hasLiveEvent = false
      for await (const event of dependencies.streamChatReply(target, signal)) {
        if ((event.type === "reply-snapshot") === hasReadSnapshot) {
          throw new Error(REPLY_STREAM_ORDER_MESSAGE)
        }
        const effect = await handleFollowedReplyEvent(target, event)
        if (effect === "reply-ended") return "reply-ended"
        if (hasReadSnapshot) hasLiveEvent = true
        hasReadSnapshot = true
      }

      return hasLiveEvent
        ? "closed-after-live-events"
        : "closed-without-live-events"
    }

    /**
     * Follows one reply until it ends, following again after an early close.
     *
     * @param target - Followed reply and its conversation.
     * @param abortController - Controller this follow owns.
     * @returns A promise that settles once the following ended; it never
     * rejects. It ends when the reply ends, when a follow fails, or after
     * {@link MAXIMUM_FRUITLESS_REPLY_FOLLOWS} closes in a row brought no
     * event past the snapshot; the reply's held calls are then dropped.
     */
    async function followReplyToolCalls(
      target: ChatReplyPathParams,
      abortController: AbortController
    ): Promise<void> {
      let fruitlessFollowCount = 0
      try {
        while (fruitlessFollowCount < MAXIMUM_FRUITLESS_REPLY_FOLLOWS) {
          const outcome = await readReplyToolCallEvents(
            target,
            abortController.signal
          )
          if (outcome === "reply-ended") return
          fruitlessFollowCount =
            outcome === "closed-after-live-events"
              ? 0
              : fruitlessFollowCount + 1
        }
      } catch {
        // The chat view follows the same reply and reports stream failures;
        // here a failed follow only stops this follow.
      } finally {
        stopReplyToolCallFollow(target.assistantMessageId, abortController)
      }
    }

    /**
     * Implements {@link ToolCallActions.startReplyToolCallFollow} for this
     * store.
     *
     * @param target - Reply that is generating, and its conversation.
     */
    function startReplyToolCallFollow(target: ChatReplyPathParams): void {
      if (replyFollows.has(target.assistantMessageId)) return

      const abortController = new AbortController()
      replyFollows = buildReplyFollows(
        replyFollows,
        target.assistantMessageId,
        abortController
      )
      // Following never rejects and stops its own follow.
      void followReplyToolCalls(target, abortController)
    }

    /**
     * Implements {@link ToolCallActions.resolveToolCall} for this store.
     *
     * @param callId - Identifier of a held call.
     * @returns The settlement defined by
     * {@link ToolCallActions.resolveToolCall}.
     */
    function resolveToolCall(callId: string): Promise<void> {
      const answer = findHeldToolCall(callId)?.answer
      if (answer?.status !== "awaiting-person") return Promise.resolve()

      return runHeldToolCall(callId, answer.input)
    }

    /**
     * Implements {@link ToolCallActions.rejectToolCall} for this store.
     *
     * @param callId - Identifier of a held call.
     * @param note - Reason the person typed; may be empty.
     * @returns The settlement defined by {@link ToolCallActions.rejectToolCall}.
     */
    function rejectToolCall(callId: string, note: string): Promise<void> {
      const answer = findHeldToolCall(callId)?.answer
      if (answer?.status !== "awaiting-person") return Promise.resolve()

      const content = formatRejectedToolCallContent(note)
      return sendHeldToolResult(callId, buildDeclinedToolResult(content))
    }

    /**
     * Implements {@link ToolCallActions.sendUnsentToolResult} for this store.
     *
     * @param callId - Identifier of a held call.
     * @returns The settlement defined by
     * {@link ToolCallActions.sendUnsentToolResult}.
     */
    function sendUnsentToolResult(callId: string): Promise<void> {
      const answer = findHeldToolCall(callId)?.answer
      if (answer?.status !== "send-failed") return Promise.resolve()

      return sendHeldToolResult(callId, answer.result)
    }

    return {
      heldCalls: NO_HELD_CALLS,
      startReplyToolCallFollow,
      resolveToolCall,
      rejectToolCall,
      sendUnsentToolResult
    }
  }

  return create<ToolCallStore>(createToolCallStoreState)
}

/** Tauri commands that run the client tools. */
const CLIENT_TOOL_COMMANDS: ClientToolCommands = Object.freeze({
  readTextFile,
  findFiles
})

/**
 * Gets the tool settings a call is decided by, loading the tool list when it
 * has not been read.
 *
 * @returns A promise that resolves with the list and the person's choices;
 * it never rejects, because a failed list read is part of the list state.
 */
async function getToolCallSettings(): Promise<ToolCallSettings> {
  if (useToolStore.getState().list.status !== "loaded") {
    await useToolStore.getState().loadTools()
  }
  const { list, areToolCallsOn, toolChoices } = useToolStore.getState()

  return Object.freeze({ list, areToolCallsOn, toolChoices })
}

/**
 * Tool-call store used by the chat view and the composer.
 *
 * @remarks This singleton follows every reply the chat view starts or
 * follows, independent of which conversation is shown. It answers each tool
 * call by the Tools pane's choices at the moment the call arrives, runs
 * client tools through Tauri, and sends their answers to the backend origin
 * the application store names when each request starts. It holds nothing
 * across a renderer reload: a call still waiting is found again through its
 * reply's snapshot when the reply is followed again, as when its
 * conversation is shown after the reload. Quitting the app stops the
 * backend, which drops every waiting call; the reply is marked interrupted
 * when the backend next starts.
 */
export const useToolCallStore: UseBoundStore<StoreApi<ToolCallStore>> =
  createToolCallStore({
    streamChatReply: (target, signal) =>
      readChatReplyEvents(target, {
        backendUrl: useLysStore.getState().backendUrl,
        signal
      }),
    sendChatToolResult: (target, result) =>
      sendChatToolResult(target, result, {
        backendUrl: useLysStore.getState().backendUrl
      }),
    getToolCallSettings,
    runClientTool: (input) => runClientTool(input, CLIENT_TOOL_COMMANDS)
  })
