import type {
  ChatReplyEvent,
  ChatReplyPathParams,
  ChatToolApprovalAnswer,
  ChatToolCall,
  ChatToolCallPathParams,
  ChatToolResult
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import {
  readChatReplyEvents,
  sendChatToolApproval,
  sendChatToolResult,
  type SendChatToolCallAnswerResult
} from "@/lib/apis/http/chat"
import {
  findFiles,
  getCurrentTime,
  getLocation,
  readTextFile
} from "@/lib/apis/tauri/tools"
import { useLysStore } from "@/lib/store"
import { useToolStore, type ToolListState } from "@/lib/store/tools"

import {
  ALLOWED_TOOL_APPROVAL,
  buildDeclinedToolApproval,
  calculateToolApprovalPrompt,
  type ToolCallInput
} from "./approval-prompt"
import {
  buildRunFailedToolResult,
  parseClientToolInput,
  runClientTool,
  type ClientToolCommands,
  type ClientToolInput
} from "./client-tools"

export type { ToolCallInput } from "./approval-prompt"

/**
 * Where one held call's answer to its approval prompt stands.
 *
 * @remarks Only `awaiting-person` and `send-failed` need the person, so only
 * they are shown. `answered` is final for the prompt; a client tool's call
 * then waits for the backend to send it to run.
 */
type HeldToolApprovalAnswer =
  | {
      /** The person must allow or reject the call. */
      readonly status: "awaiting-person"
      /** Definition of the called tool, for its access and runner tags. */
      readonly definition: ToolDefinition
      /** Validated input the card describes. */
      readonly input: ToolCallInput
    }
  | {
      /** The answer is being sent to the backend. */
      readonly status: "sending"
      /** Answer being sent. */
      readonly toolAnswer: ChatToolApprovalAnswer
    }
  | {
      /** Sending the answer failed; the person can send it again. */
      readonly status: "send-failed"
      /** Answer that was not sent. */
      readonly toolAnswer: ChatToolApprovalAnswer
      /** User-presentable reason. */
      readonly error: string
    }
  | {
      /**
       * The backend took the answer, or no longer waits for it. The call stays
       * held so a snapshot built before the answer arrived does not show it
       * again.
       */
      readonly status: "answered"
    }

/**
 * Where one held call the backend sent to run stands.
 *
 * @remarks Only `send-failed` needs the person, so only it is shown.
 * `answered` is final.
 */
type HeldToolRunAnswer =
  | {
      /** The desktop tool is running; its result is not built yet. */
      readonly status: "running"
    }
  | {
      /** The result is being sent to the backend. */
      readonly status: "sending"
      /** Result being sent. */
      readonly toolAnswer: ChatToolResult
    }
  | {
      /** Sending the result failed; the person can send it again. */
      readonly status: "send-failed"
      /** Result that was not sent, kept so a retry does not run the tool again. */
      readonly toolAnswer: ChatToolResult
      /** User-presentable reason. */
      readonly error: string
    }
  | {
      /**
       * The backend took the result, or no longer waits for it. The call stays
       * held so a snapshot built before the result arrived does not run it
       * again.
       */
      readonly status: "answered"
    }

/** Where one held call's answer stands, whichever step it is in. */
export type HeldToolCallAnswer = HeldToolApprovalAnswer | HeldToolRunAnswer

/**
 * One tool call of a followed reply, held until the store stops following
 * that reply.
 *
 * @remarks `step` says which request of the backend the call answers: its
 * approval prompt, or its run request. A client tool's call answers its
 * prompt first and then, under the same identifier, its run request.
 */
export type HeldToolCall =
  | {
      /** Call, reply, and conversation the answer is sent to. */
      readonly target: ChatToolCallPathParams
      /** Call as the backend sent it. */
      readonly call: ChatToolCall
      /** The backend shows the call to the person for approval. */
      readonly step: "approval"
      /** Where the answer to the prompt stands. */
      readonly answer: HeldToolApprovalAnswer
    }
  | {
      /** Call, reply, and conversation the result is sent to. */
      readonly target: ChatToolCallPathParams
      /** Call as the backend sent it. */
      readonly call: ChatToolCall
      /** The backend asked the desktop to run the call. */
      readonly step: "run"
      /** Where the run and its result stand. */
      readonly answer: HeldToolRunAnswer
    }

/** Held call the composer shows: one that needs the person. */
export type ShownToolCall = HeldToolCall & {
  /** Waiting for the person, or its answer failed to send. */
  readonly answer: Extract<
    HeldToolCallAnswer,
    { status: "awaiting-person" | "send-failed" }
  >
}

/** Held call whose answer is being sent. */
type SendingHeldToolCall =
  | (Extract<HeldToolCall, { step: "approval" }> & {
      /** Approval answer being sent. */
      readonly answer: Extract<HeldToolApprovalAnswer, { status: "sending" }>
    })
  | (Extract<HeldToolCall, { step: "run" }> & {
      /** Result being sent. */
      readonly answer: Extract<HeldToolRunAnswer, { status: "sending" }>
    })

/** Observable state of the tool-call store. */
type ToolCallState = {
  /** Every held call, in arrival order. */
  readonly heldCalls: readonly HeldToolCall[]
}

/** Actions of the tool-call store. */
type ToolCallActions = {
  /**
   * Starts following one reply to show its approval prompts and run the
   * calls the backend sends to run.
   *
   * @param target - Reply that is generating, and its conversation.
   * @remarks The store follows the reply on its own connection, independent
   * of the chat view, until the reply ends; a reply it already follows is
   * ignored. The backend decides which calls need the person: each prompt
   * waits for the person in arrival order, and each call sent to run runs at
   * once. When the following ends, every call of the reply still held is
   * dropped.
   */
  startReplyToolCallFollow: (target: ChatReplyPathParams) => void
  /**
   * Allows one call that waits for the person and sends the answer.
   *
   * @param callId - Identifier of a held call.
   * @returns A promise that settles once the answer was sent or failed to
   * send; it never rejects. A call that does not wait for the person is
   * ignored, so a repeated press answers once. After this answer the backend
   * runs its own tool, or sends a desktop tool's call to run.
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
   * Sends again the answer or result of a call whose answer failed to send.
   *
   * @param callId - Identifier of a held call.
   * @returns A promise that settles once the answer was sent or failed again;
   * it never rejects. The tool does not run again. A call whose answer did
   * not fail is ignored.
   */
  sendUnsentToolCallAnswer: (callId: string) => Promise<void>
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
  /** Sends one run's result; throws when the backend cannot take it. */
  readonly sendChatToolResult: (
    target: ChatToolCallPathParams,
    result: ChatToolResult
  ) => Promise<SendChatToolCallAnswerResult>
  /** Sends one prompt's answer; throws when the backend cannot take it. */
  readonly sendChatToolApproval: (
    target: ChatToolCallPathParams,
    answer: ChatToolApprovalAnswer
  ) => Promise<SendChatToolCallAnswerResult>
  /** Gets the tool list, loading it when it has not been read; never rejects. */
  readonly getToolList: () => Promise<ToolListState>
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
const RUNNING_ANSWER: HeldToolRunAnswer = Object.freeze({ status: "running" })

/** Shared answered state; it carries no per-call data. */
const ANSWERED_ANSWER = Object.freeze({ status: "answered" } as const)

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
function formatToolCallAnswerSendError(error: unknown): string {
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
function buildToolCallAnswerTarget(
  target: ChatReplyPathParams,
  callId: string
): ChatToolCallPathParams {
  return Object.freeze({
    conversationId: target.conversationId,
    assistantMessageId: target.assistantMessageId,
    callId
  })
}

/**
 * Builds a held prompt whose answer is being sent.
 *
 * @param target - Address of the call's answer.
 * @param call - Call as the backend sent it.
 * @param toolAnswer - Approval answer to send.
 * @returns A frozen held call in the approval step.
 */
function buildSendingToolApproval(
  target: ChatToolCallPathParams,
  call: ChatToolCall,
  toolAnswer: ChatToolApprovalAnswer
): SendingHeldToolCall {
  const answer = Object.freeze({ status: "sending", toolAnswer } as const)
  return Object.freeze({ target, call, step: "approval", answer } as const)
}

/**
 * Builds a held run whose result is being sent.
 *
 * @param target - Address of the call's result.
 * @param call - Call as the backend sent it.
 * @param toolAnswer - Result to send.
 * @returns A frozen held call in the run step.
 */
function buildSendingToolRun(
  target: ChatToolCallPathParams,
  call: ChatToolCall,
  toolAnswer: ChatToolResult
): SendingHeldToolCall {
  const answer = Object.freeze({ status: "sending", toolAnswer } as const)
  return Object.freeze({ target, call, step: "run", answer } as const)
}

/**
 * Builds the held call whose answer could not be sent.
 *
 * @param heldCall - Held call whose answer was being sent.
 * @param error - User-presentable reason.
 * @returns A frozen held call keeping the answer, in the same step.
 */
function buildSendFailedHeldToolCall(
  heldCall: SendingHeldToolCall,
  error: string
): HeldToolCall {
  const { target, call } = heldCall
  switch (heldCall.step) {
    case "approval": {
      const answer = Object.freeze({
        status: "send-failed",
        toolAnswer: heldCall.answer.toolAnswer,
        error
      } as const)
      return Object.freeze({ target, call, step: "approval", answer } as const)
    }
    case "run": {
      const answer = Object.freeze({
        status: "send-failed",
        toolAnswer: heldCall.answer.toolAnswer,
        error
      } as const)
      return Object.freeze({ target, call, step: "run", answer } as const)
    }
  }
}

/**
 * Builds the held call whose answer the backend took.
 *
 * @param heldCall - Held call whose answer was being sent.
 * @returns A frozen answered held call, in the same step.
 */
function buildAnsweredHeldToolCall(
  heldCall: SendingHeldToolCall
): HeldToolCall {
  const { target, call } = heldCall
  switch (heldCall.step) {
    case "approval":
      return Object.freeze({
        target,
        call,
        step: "approval",
        answer: ANSWERED_ANSWER
      } as const)
    case "run":
      return Object.freeze({
        target,
        call,
        step: "run",
        answer: ANSWERED_ANSWER
      } as const)
  }
}

/**
 * Builds the held call that sends again an answer that failed to send.
 *
 * @param heldCall - Held call.
 * @returns The held call sending the same answer, in the same step; or
 * undefined when the call's answer did not fail to send.
 */
function buildResentHeldToolCall(
  heldCall: HeldToolCall
): SendingHeldToolCall | undefined {
  switch (heldCall.step) {
    case "approval":
      return heldCall.answer.status === "send-failed"
        ? buildSendingToolApproval(
            heldCall.target,
            heldCall.call,
            heldCall.answer.toolAnswer
          )
        : undefined
    case "run":
      return heldCall.answer.status === "send-failed"
        ? buildSendingToolRun(
            heldCall.target,
            heldCall.call,
            heldCall.answer.toolAnswer
          )
        : undefined
  }
}

/**
 * Creates one independently owned tool-call store.
 *
 * @param dependencies - Reply transport, answer senders, tool list reader,
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
   * Sends a held call's answer to the endpoint of its step.
   *
   * @param heldCall - Held call whose answer is being sent.
   * @returns The backend's outcome.
   * @throws When the backend cannot take the answer.
   */
  function sendToolCallAnswer(
    heldCall: SendingHeldToolCall
  ): Promise<SendChatToolCallAnswerResult> {
    switch (heldCall.step) {
      case "approval":
        return dependencies.sendChatToolApproval(
          heldCall.target,
          heldCall.answer.toolAnswer
        )
      case "run":
        return dependencies.sendChatToolResult(
          heldCall.target,
          heldCall.answer.toolAnswer
        )
    }
  }

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
     * Replaces the held call with the same identifier, keeping its place.
     *
     * @param heldCall - New state of the call; nothing changes when the call
     * is no longer held.
     */
    function updateHeldToolCall(heldCall: HeldToolCall): void {
      set((state) => ({
        heldCalls: Object.freeze(
          state.heldCalls.map((current) =>
            current.call.id === heldCall.call.id ? heldCall : current
          )
        )
      }))
    }

    /**
     * Answers whether a call's answer is still being sent in the given step.
     *
     * @param callId - Identifier of the call.
     * @param step - Step whose answer was sent.
     * @returns True while the store holds the call in that step and still
     * sending; false once the follow stopped, the call moved to its run, or
     * another send settled it.
     */
    function isHeldToolCallSending(
      callId: string,
      step: HeldToolCall["step"]
    ): boolean {
      const heldCall = findHeldToolCall(callId)
      return heldCall?.step === step && heldCall.answer.status === "sending"
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
     * Holds a call as sending its answer, sends it, and marks the call
     * answered once the backend no longer waits for it.
     *
     * @param heldCall - Held call with the answer to send.
     * @returns A promise that settles after the send; a failed send never
     * rejects it. An accepted or not-pending answer marks the call
     * `answered`; a failed send keeps it as `send-failed` with the answer.
     * Either happens only while the call is still sending in the same step,
     * so a run that started while an allowed answer was in flight is never
     * overwritten. Only the send's failure is recorded: a store listener that
     * throws on either update rejects the promise.
     */
    async function sendHeldToolAnswer(
      heldCall: SendingHeldToolCall
    ): Promise<void> {
      updateHeldToolCall(heldCall)
      try {
        await sendToolCallAnswer(heldCall)
      } catch (error) {
        if (!isHeldToolCallSending(heldCall.call.id, heldCall.step)) return
        const sendError = formatToolCallAnswerSendError(error)
        updateHeldToolCall(buildSendFailedHeldToolCall(heldCall, sendError))
        return
      }
      if (!isHeldToolCallSending(heldCall.call.id, heldCall.step)) return
      updateHeldToolCall(buildAnsweredHeldToolCall(heldCall))
    }

    /**
     * Runs one held call of a desktop tool and sends its result.
     *
     * @param heldCall - Call held as running.
     * @param input - Validated input to run with.
     * @returns A promise that settles after the result was sent or failed to
     * send; it never rejects. A call that is no longer running when the tool
     * finishes is not answered: its reply's follow stopped, or an earlier
     * result of the same call reached the backend.
     */
    async function runHeldToolCall(
      heldCall: HeldToolCall,
      input: ClientToolInput
    ): Promise<void> {
      const result = await dependencies.runClientTool(input)
      const current = findHeldToolCall(heldCall.call.id)
      if (current?.step !== "run" || current.answer.status !== "running") return

      await sendHeldToolAnswer(
        buildSendingToolRun(heldCall.target, heldCall.call, result)
      )
    }

    /**
     * Holds one prompt of a followed reply and starts answering it.
     *
     * @param target - Reply that made the call, and its conversation.
     * @param call - Call the backend shows for approval.
     * @param list - Tool list the card is described from.
     * @remarks A call already held, including an answered one, is ignored. A
     * prompt the desktop cannot show is answered at once; sending never
     * rejects.
     */
    function startToolApproval(
      target: ChatReplyPathParams,
      call: ChatToolCall,
      list: ToolListState
    ): void {
      if (findHeldToolCall(call.id) !== undefined) return

      const answerTarget = buildToolCallAnswerTarget(target, call.id)
      const prompt = calculateToolApprovalPrompt(call, list)
      switch (prompt.status) {
        case "ask": {
          const answer = Object.freeze({
            status: "awaiting-person",
            definition: prompt.definition,
            input: prompt.input
          } as const)
          addHeldToolCall(
            Object.freeze({
              target: answerTarget,
              call,
              step: "approval",
              answer
            } as const)
          )
          return
        }
        case "rejected": {
          const sending = buildSendingToolApproval(
            answerTarget,
            call,
            prompt.toolAnswer
          )
          addHeldToolCall(sending)
          // Sending never rejects; it records its outcome in the held call.
          void sendHeldToolAnswer(sending)
          return
        }
      }
    }

    /**
     * Holds one call the backend sent to run and runs it, or answers it as
     * not run when the desktop cannot run it.
     *
     * @param target - Reply that made the call, and its conversation.
     * @param call - Call to run.
     * @remarks A call already held in its run step is ignored, so a run
     * request listed again by a snapshot runs once. A call held in its
     * approval step moves to its run step in place, also while it still
     * waits for the person: the store does not check who allowed the call,
     * and the backend takes an approval answer from any local process until
     * its callers are authenticated (#211). Running and sending never reject.
     */
    function startToolRun(
      target: ChatReplyPathParams,
      call: ChatToolCall
    ): void {
      const heldCall = findHeldToolCall(call.id)
      if (heldCall?.step === "run") return

      const holdToolCall =
        heldCall === undefined ? addHeldToolCall : updateHeldToolCall
      const answerTarget = buildToolCallAnswerTarget(target, call.id)
      const parsed = parseClientToolInput(call)
      if (parsed.status === "rejected") {
        const result = buildRunFailedToolResult(parsed.content)
        const sending = buildSendingToolRun(answerTarget, call, result)
        holdToolCall(sending)
        // Sending never rejects; it records its outcome in the held call.
        void sendHeldToolAnswer(sending)
        return
      }
      const running: HeldToolCall = Object.freeze({
        target: answerTarget,
        call,
        step: "run",
        answer: RUNNING_ANSWER
      } as const)
      holdToolCall(running)
      // Running never rejects; it records its outcome in the held call.
      void runHeldToolCall(running, parsed.input)
    }

    /**
     * Holds the prompts that arrived for a followed reply and starts answering
     * each one.
     *
     * @param target - Reply that made the calls, and its conversation.
     * @param calls - Calls in arrival order: one live prompt, or the prompts a
     * snapshot lists as waiting.
     * @returns A promise that settles once the prompts are held. Calls already
     * held are ignored; when the reply stopped being followed while the tool
     * list was read, every call is.
     */
    async function handleToolApprovalArrival(
      target: ChatReplyPathParams,
      calls: readonly ChatToolCall[]
    ): Promise<void> {
      const arrivedCalls = calls.filter(
        (call) => findHeldToolCall(call.id) === undefined
      )
      if (arrivedCalls.length === 0) return
      const list = await dependencies.getToolList()
      if (!replyFollows.has(target.assistantMessageId)) return

      for (const call of arrivedCalls) {
        startToolApproval(target, call, list)
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
          await handleToolApprovalArrival(target, event.pendingToolApprovals)
          for (const call of event.pendingToolCalls) startToolRun(target, call)
          return "reply-continues"
        case "tool-approval":
          await handleToolApprovalArrival(target, [event.call])
          return "reply-continues"
        case "tool-call":
          startToolRun(target, event.call)
          return "reply-continues"
        case "title":
        case "reply-part":
        case "reply-part-delta":
        case "sources":
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
     * Sends the person's answer to one call that waits for them.
     *
     * @param callId - Identifier of a held call.
     * @param toolAnswer - Answer to send.
     * @returns The settlement of the send; a call that does not wait for the
     * person is ignored.
     */
    function sendPersonToolApproval(
      callId: string,
      toolAnswer: ChatToolApprovalAnswer
    ): Promise<void> {
      const heldCall = findHeldToolCall(callId)
      if (heldCall?.answer.status !== "awaiting-person")
        return Promise.resolve()

      return sendHeldToolAnswer(
        buildSendingToolApproval(heldCall.target, heldCall.call, toolAnswer)
      )
    }

    /**
     * Implements {@link ToolCallActions.resolveToolCall} for this store.
     *
     * @param callId - Identifier of a held call.
     * @returns The settlement defined by
     * {@link ToolCallActions.resolveToolCall}.
     */
    function resolveToolCall(callId: string): Promise<void> {
      return sendPersonToolApproval(callId, ALLOWED_TOOL_APPROVAL)
    }

    /**
     * Implements {@link ToolCallActions.rejectToolCall} for this store.
     *
     * @param callId - Identifier of a held call.
     * @param note - Reason the person typed; may be empty.
     * @returns The settlement defined by {@link ToolCallActions.rejectToolCall}.
     */
    function rejectToolCall(callId: string, note: string): Promise<void> {
      return sendPersonToolApproval(callId, buildDeclinedToolApproval(note))
    }

    /**
     * Implements {@link ToolCallActions.sendUnsentToolCallAnswer} for this
     * store.
     *
     * @param callId - Identifier of a held call.
     * @returns The settlement defined by
     * {@link ToolCallActions.sendUnsentToolCallAnswer}.
     */
    function sendUnsentToolCallAnswer(callId: string): Promise<void> {
      const heldCall = findHeldToolCall(callId)
      const resent =
        heldCall === undefined ? undefined : buildResentHeldToolCall(heldCall)
      if (resent === undefined) return Promise.resolve()

      return sendHeldToolAnswer(resent)
    }

    return {
      heldCalls: NO_HELD_CALLS,
      startReplyToolCallFollow,
      resolveToolCall,
      rejectToolCall,
      sendUnsentToolCallAnswer
    }
  }

  return create<ToolCallStore>(createToolCallStoreState)
}

/** Tauri commands that run the client tools. */
const CLIENT_TOOL_COMMANDS: ClientToolCommands = Object.freeze({
  readTextFile,
  findFiles,
  getCurrentTime,
  getLocation
})

/**
 * Gets the tool list an approval card is described from, loading it when it
 * has not been read.
 *
 * @returns A promise that resolves with the list state once it is ready; it
 * never rejects, because a failed read is part of the list state.
 */
async function getToolList(): Promise<ToolListState> {
  if (useToolStore.getState().list.status !== "loaded") {
    await useToolStore.getState().loadTools()
  }
  return useToolStore.getState().list
}

/**
 * Tool-call store used by the chat view and the composer.
 *
 * @remarks This singleton follows every reply the chat view starts or
 * follows, independent of which conversation is shown. The backend decides
 * which tool calls need the person: the store shows each approval prompt,
 * runs through Tauri each client tool's call the backend sends to run, and
 * sends every answer to the backend origin the application store names when
 * each request starts. It reads neither the Tools pane's switches nor the
 * saved Just run choices. It holds nothing across a renderer reload: a
 * prompt or call still waiting is found again through its reply's snapshot
 * when the reply is followed again, as when its conversation is shown after
 * the reload. Quitting the app stops the backend, which drops every waiting
 * call; the reply is marked interrupted when the backend next starts.
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
    sendChatToolApproval: (target, answer) =>
      sendChatToolApproval(target, answer, {
        backendUrl: useLysStore.getState().backendUrl
      }),
    getToolList,
    runClientTool: (input) => runClientTool(input, CLIENT_TOOL_COMMANDS)
  })
