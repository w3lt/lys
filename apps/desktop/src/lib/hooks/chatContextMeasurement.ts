import type { ChatContextApiRequestBody } from "@lys/protocol"
import type { ConversationMessage } from "@lys/share"
import { useEffect, useMemo, useState } from "react"

import {
  getChatContextMeasurement,
  type ChatContextMeasurementResult
} from "@/lib/apis/http/chat"
import { findEligibleChatModel } from "@/lib/models/model-residency"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import { useLysStore } from "@/lib/store"
import { useAgentStore } from "@/lib/store/agents"
import { calculateNewConversationAgentCode } from "@/lib/store/agents/conversation-agent"
import { useChatViewStore } from "@/lib/store/chat-view"
import {
  buildChatToolFields,
  buildChatToolOffer,
  NO_CHAT_TOOL_OFFER,
  useToolStore,
  type ChatToolOfferResult,
  type ToolListState
} from "@/lib/store/tools"

/** Settled outcome of one context measurement. */
export type ChatContextMeasurementOutcome =
  | ChatContextMeasurementResult
  | {
      /** The measurement failed; the composer still lets the person send. */
      readonly status: "failed"
      /** Caller-safe sentence saying why. */
      readonly message: string
    }

/** What the composer knows about the context its next message would take. */
export type ChatContextMeasurementState = {
  /**
   * Outcome of the latest measurement that settled, or undefined before the
   * first one settles. While {@link isPending} is true it describes earlier
   * inputs.
   */
  readonly outcome: ChatContextMeasurementOutcome | undefined
  /** Whether a measurement of the current inputs has not settled yet. */
  readonly isPending: boolean
}

/** Outcome of a measurement together with the inputs it answered. */
type SettledChatContextMeasurement = {
  /** Identity of the request and history the measurement answered. */
  readonly inputKey: string
  /** What the measurement found. */
  readonly outcome: ChatContextMeasurementOutcome
}

/** Inputs that decide which tools the next message would offer. */
type MeasuredToolOfferInput = {
  /** Whether tool calls are on in the Tools pane. */
  readonly areToolCallsOn: boolean
  /** Whether the loaded model is known to be trained for tool use. */
  readonly isTrainedForToolUse: boolean
  /** Tool list as last read. */
  readonly list: ToolListState
  /** Saved switches the person changed, keyed by tool name. */
  readonly toolSwitches: ReadonlyMap<string, boolean>
}

/** Inputs that decide what the next message would be sent with. */
type ChatContextRequestInput = {
  /** UUIDv7 of the shown conversation, or undefined before the first message. */
  readonly conversationId: string | undefined
  /** Agent that would answer a new conversation. */
  readonly newConversationAgentCode: string
  /** Loaded model the message would be sent to, or null when none is. */
  readonly model: string | null
  /**
   * Tools the message would offer and name as switched off; an
   * `unavailable` offer is measured without tools.
   */
  readonly toolOffer: ChatToolOfferResult
}

/**
 * Measures how much of the loaded model's context window the composer's next
 * message would take, before its own text.
 *
 * @param isComposerIdle - Reactive: whether the composer could send now. No
 * measurement starts while a reply is awaited or a conversation opens; the
 * last outcome stays as it was.
 * @returns The latest settled outcome and whether a newer measurement is
 * pending.
 * @remarks The hook reads the stores the chat-view store reads when it sends:
 * the shown conversation or the agent a new one would start with, the loaded
 * model, and the tools the Tools pane would offer. A measurement starts when
 * the composer is idle, a model is loaded, and that request or the shown
 * conversation's stored messages changed since the last one started; the
 * backend counts it with the model's tokenizer. A change abandons the
 * previous measurement, whose result is then never published; unmounting
 * abandons it too. When the model is trained for tool use and the tool list
 * was never read, the hook starts reading it, as sending would. A failed
 * measurement is reported as `failed` and is not retried
 * until an input changes.
 */
export function useChatContextMeasurement(
  isComposerIdle: boolean
): ChatContextMeasurementState {
  const backendUrl = useLysStore((state) => state.backendUrl)
  const request = useChatContextRequest()
  const historyKey = useChatViewStore((state) =>
    calculateHistoryKey(state.conversation?.messages)
  )
  const [settled, setSettled] = useState<SettledChatContextMeasurement>()
  const inputKey =
    request === undefined || !isComposerIdle
      ? undefined
      : `${JSON.stringify(request)}#${historyKey}`

  useEffect(() => {
    if (request === undefined || inputKey === undefined) return

    const controller = new AbortController()
    void getChatContextMeasurement(request, {
      backendUrl,
      signal: controller.signal
    }).then(
      (outcome) => {
        if (!controller.signal.aborted) setSettled({ inputKey, outcome })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setSettled({ inputKey, outcome: buildFailedOutcome(error) })
      }
    )

    return () => {
      controller.abort()
    }
  }, [backendUrl, inputKey, request])

  return {
    outcome: settled?.outcome,
    isPending: inputKey !== undefined && settled?.inputKey !== inputKey
  }
}

/**
 * Builds the measurement request the composer's next message corresponds to,
 * and starts reading the tool list when it is needed and was never read.
 *
 * @returns The request, the same object until one of its inputs changes; or
 * undefined while no model is loaded or the backend is not running.
 */
function useChatContextRequest(): ChatContextApiRequestBody | undefined {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const modelRuntime = useLysStore((state) => state.modelRuntime)
  const modelInventory = useLysStore((state) => state.modelInventory)
  const conversationId = useChatViewStore((state) => state.conversation?.id)
  const selectedAgentCode = useChatViewStore((state) => state.selectedAgentCode)
  const agentList = useAgentStore((state) => state.list)
  const areToolCallsOn = useToolStore((state) => state.areToolCallsOn)
  const list = useToolStore((state) => state.list)
  const toolSwitches = useLysStore((state) => state.settings.tools.switches)
  const loadTools = useToolStore((state) => state.loadTools)
  const isTrainedForToolUse =
    calculateToolModelSupport(modelRuntime, modelInventory).status === "trained"
  const model = findEligibleChatModel(backendStatus, modelRuntime)
  const newConversationAgentCode = calculateNewConversationAgentCode(
    selectedAgentCode,
    agentList
  )
  const isToolListNeeded = isTrainedForToolUse && list.status === "idle"

  useEffect(() => {
    if (isToolListNeeded) void loadTools()
  }, [isToolListNeeded, loadTools])

  const toolOffer = useMemo(
    () =>
      buildMeasuredToolOffer({
        areToolCallsOn,
        isTrainedForToolUse,
        list,
        toolSwitches
      }),
    [areToolCallsOn, isTrainedForToolUse, list, toolSwitches]
  )
  return useMemo(
    () =>
      buildChatContextRequest({
        conversationId,
        newConversationAgentCode,
        model,
        toolOffer
      }),
    [conversationId, newConversationAgentCode, model, toolOffer]
  )
}

/**
 * Builds the tool offer the next message would carry.
 *
 * @param input - The Tools pane's choices, the model's training, and the list.
 * @returns The offer sending would build from the same list, with the tools
 * it would name as switched off; {@link NO_CHAT_TOOL_OFFER} when the model is
 * not known to be trained for tool use.
 * @remarks Sending reads an unread list first and then offers what it holds;
 * the hook reads it too, so the measurement follows once the list arrives.
 */
function buildMeasuredToolOffer(
  input: MeasuredToolOfferInput
): ChatToolOfferResult {
  if (!input.isTrainedForToolUse) return NO_CHAT_TOOL_OFFER
  return buildChatToolOffer({
    list: input.list,
    areToolCallsOn: input.areToolCallsOn,
    toolSwitches: input.toolSwitches
  })
}

/**
 * Builds the measurement request of the next message.
 *
 * @param input - Conversation, agent, model, and tool offer.
 * @returns The request for the shown conversation, or for a new one its agent
 * would start, with the offered tools and the switched-off ones when there
 * are any; undefined when no model is loaded.
 */
function buildChatContextRequest(
  input: ChatContextRequestInput
): ChatContextApiRequestBody | undefined {
  if (input.model === null) return undefined
  const conversation: ChatContextApiRequestBody["conversation"] =
    input.conversationId === undefined
      ? { kind: "new", agentCode: input.newConversationAgentCode }
      : { kind: "existing", id: input.conversationId }
  return {
    conversation,
    model: input.model,
    ...buildChatToolFields(input.toolOffer)
  }
}

/**
 * Calculates a key that changes whenever the stored messages a turn could
 * include change.
 *
 * @param messages - Messages of the shown conversation, or undefined.
 * @returns The identifiers of the messages in order, each reply with its
 * status; empty without a conversation.
 */
function calculateHistoryKey(
  messages: readonly ConversationMessage[] | undefined
): string {
  return (messages ?? [])
    .map((message) =>
      message.role === "assistant"
        ? `${message.id}:${message.status}`
        : message.id
    )
    .join(",")
}

/**
 * Builds the outcome of a measurement that failed.
 *
 * @param failure - Value the measurement rejected with.
 * @returns A `failed` outcome with the failure's message, or a general
 * sentence when it has none.
 */
function buildFailedOutcome(failure: unknown): ChatContextMeasurementOutcome {
  return {
    status: "failed",
    message:
      failure instanceof Error && failure.message
        ? failure.message
        : "The context could not be measured."
  }
}
