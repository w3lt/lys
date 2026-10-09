import type {
  ChatApiRequestBody,
  ChatApiStreamEvent,
  ChatGenerationEvent,
  ChatReplyEvent,
  ChatReplyPathParams,
  ChatToolOffer,
  MessageGenerationOptions
} from "@lys/protocol"
import {
  LYS_AGENT_CODE,
  type ConversationAssistantMessageStatus
} from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import {
  readChatEvents,
  readChatReplyEvents,
  stopChatReply,
  type ChatApiOptions,
  type StopChatReplyResult
} from "@/lib/apis/http/chat"
import {
  getConversation,
  type GetConversationResult
} from "@/lib/apis/http/conversations"
import { findEligibleChatModel } from "@/lib/models/model-residency"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import { useLysStore } from "@/lib/store"
import { useToolCallStore } from "@/lib/store/tool-calls"
import {
  buildChatToolOffer,
  NO_CHAT_TOOL_OFFER,
  useToolStore,
  type ChatToolOfferResult
} from "@/lib/store/tools"

import {
  type ChatViewConversation,
  createStoredChatViewConversation,
  findStreamingReply,
  isStreamingConversationAssistantMessage,
  startConversationTurn,
  updateAssistantReplyContent,
  updateAssistantReplyStatus,
  updateAssistantReplyWithSnapshot,
  updateConversationTitle
} from "./conversation-transitions"

/**
 * Opens one typed chat event stream.
 *
 * @param payload - Valid prompt and optional conversation identifier.
 * @param options - Optional transport settings, including cancellation signal.
 * @returns An async generator that yields validated events and completes when
 * the response stream closes.
 * @throws If opening, reading, or validating the response stream fails.
 * @remarks Aborting `options.signal` ends only this observation; the backend
 * keeps generating. Consumers must still ignore any events already queued by
 * the transport.
 */
export type ChatStream = (
  payload: ChatApiRequestBody,
  options?: ChatApiOptions
) => AsyncGenerator<ChatApiStreamEvent, void, unknown>

/**
 * Follows one stored reply from its snapshot to the end of its generation.
 *
 * @param target - Reply and the conversation that holds it.
 * @param signal - Store-owned signal; aborting it ends only this observation.
 * @returns An async generator that yields validated reply events and
 * completes when the backend ends the stream.
 * @throws If opening, reading, or validating the stream fails, or the reply
 * is no longer stored.
 */
export type ChatReplyStream = (
  target: ChatReplyPathParams,
  signal: AbortSignal
) => AsyncGenerator<ChatReplyEvent, void, unknown>

/**
 * Asks the backend to stop one reply's generation.
 *
 * @param target - Reply and the conversation that holds it.
 * @returns The stop outcome after the backend stored the reply's final state
 * or reported that it was not generating.
 * @throws If the backend cannot be reached or answers unexpectedly.
 */
export type ChatReplyStopper = (
  target: ChatReplyPathParams
) => Promise<StopChatReplyResult>

/**
 * Reads one stored conversation to open in the chat view.
 *
 * @param conversationId - UUIDv7 of the conversation to open.
 * @param signal - Store-owned signal aborted when the open is superseded.
 * @returns The stored conversation, or the absence outcome when the backend
 * reports that the conversation is not stored.
 * @throws If opening, transporting, or validating the response fails.
 */
export type StoredConversationReader = (
  conversationId: string,
  signal: AbortSignal
) => Promise<GetConversationResult>

/**
 * Runtime dependencies used by one independently owned chat-view store.
 *
 * @remarks The store owns request and open tokens and their abort controllers;
 * these dependencies provide only transport, stored-conversation reads, reply
 * stops, timestamps, model-selection, generation-settings, and tool-offer
 * capabilities, and hand replies to the tool-call store.
 * Aborting a store-owned signal ends only the store's observation; the
 * backend keeps generating. The store does not share lifecycle state with
 * another store instance, and does not own the settings it reads.
 */
export type ChatViewStoreDependencies = {
  /** Opens the backend chat stream; the store supplies its owned abort signal. */
  readonly streamChat: ChatStream
  /** Follows a stored reply; the store supplies its owned abort signal. */
  readonly streamChatReply: ChatReplyStream
  /** Stops a reply's generation on the backend; not cancellable by the store. */
  readonly stopChatReply: ChatReplyStopper
  /** Reads a stored conversation; the store supplies its owned abort signal. */
  readonly getConversation: StoredConversationReader
  /** Creates the ISO timestamp recorded on each immutable transition. */
  readonly createTimestamp: () => string
  /**
   * Finds the loaded model eligible to answer the next request.
   *
   * @returns The model key current at call time, or `null` when chat cannot be
   * sent. Sampling is owned by {@link ChatViewActions.sendMessage}.
   */
  readonly findEligibleChatModel: () => string | null
  /**
   * Reads the generation controls applied to the next request.
   *
   * @returns The settings-owned controls current at call time. Sampling is
   * owned by {@link ChatViewActions.sendMessage}.
   */
  readonly readGenerationOptions: () => MessageGenerationOptions
  /**
   * Gets the tools the next request offers.
   *
   * @returns The offer current at call time: offered tools, none, or
   * `unavailable` when the tool list cannot be read. Sampling is owned by
   * {@link ChatViewActions.sendMessage}.
   */
  readonly getToolOffer: () => Promise<ChatToolOfferResult>
  /**
   * Starts answering the tool calls of a reply this store starts or follows.
   *
   * @remarks The receiver follows the reply on its own and ignores a reply it
   * already follows, so this store does not stop it.
   */
  readonly startReplyToolCallFollow: (target: ChatReplyPathParams) => void
}

/**
 * Authoritative observable lifecycle state of one chat request.
 *
 * @remarks One monotonically increasing token is the authority for every
 * stream event and private transport resource. `reply-completed` is entered
 * once the reply is final — after `done`, `interrupted`, or `error`, or a
 * snapshot of a final reply — and still permits title events; no later
 * request state accepts deltas again. A new request may replace a
 * `reply-completed` one, which ends following its stream.
 */
export type ChatRequestState =
  | {
      /** No request owns the chat lifecycle. */
      readonly status: "idle"
    }
  | {
      /** The request is waiting for its persisted conversation turn. */
      readonly status: "awaiting-turn"
      /** Token authorizing this request to mutate chat state. */
      readonly token: number
      /** Exact composer draft cleared only if unchanged at start. */
      readonly submittedComposerDraft?: string
    }
  | {
      /** The backend-identified assistant reply is accepting content. */
      readonly status: "reply-streaming"
      /** Token authorizing this request to mutate chat state. */
      readonly token: number
      /** Backend-owned identifier of the streaming assistant reply. */
      readonly assistantMessageId: string
    }
  | {
      /** The assistant reply is terminal while independent events may remain. */
      readonly status: "reply-completed"
      /** Token authorizing this request to mutate chat state. */
      readonly token: number
      /** Backend-owned identifier of the completed assistant reply. */
      readonly assistantMessageId: string
    }

/**
 * Lifecycle of replacing the chat view's conversation with a stored one.
 *
 * @remarks While a conversation is opening, the previously shown conversation
 * stays visible and no chat request may start. The store alone owns the read
 * and its cancellation; a superseded read can no longer change state.
 */
export type ConversationOpenState =
  | {
      /** No stored conversation is being opened. */
      readonly status: "idle"
    }
  | {
      /** A stored conversation is being read to replace the shown one. */
      readonly status: "opening"
      /** UUIDv7 of the conversation being opened. */
      readonly conversationId: string
      /**
       * Exact composer draft when the open started; a successful open clears
       * the draft only if it is still this text.
       */
      readonly replacedComposerDraft: string
    }

/**
 * Observable state rendered by the chat view.
 *
 * @remarks The store owns the draft, conversation snapshot, request phase,
 * conversation-open phase, and latest error. Conversation and message values
 * are replaced immutably; the UI may read them but cannot mutate the store's
 * authoritative values.
 */
export type ChatViewState = {
  /** Current composer text. */
  readonly inputDraft: string
  /** Active conversation, or undefined before a conversation starts. */
  readonly conversation?: ChatViewConversation
  /** Single authoritative observable request lifecycle state. */
  readonly request: ChatRequestState
  /** Whether a stored conversation is being opened to replace the shown one. */
  readonly conversationOpen: ConversationOpenState
  /** Latest admission or lifecycle error shown inline, or undefined when clear. */
  readonly error?: string
}

/**
 * Actions that mutate or advance the chat lifecycle.
 *
 * @remarks `openConversation` resolves after the read commits, fails, or is
 * superseded, and when the conversation shown afterwards ends with a reply
 * that is still generating — the opened one, or the previous one after a
 * failed open — after the store stops following it. `resetConversation`
 * and opening another conversation stop following the active reply without
 * stopping it; only `stopStreaming` stops a reply on the backend.
 */
export type ChatViewActions = {
  /** Replaces the composer draft with user-entered text. */
  setInputDraft: (draft: string) => void
  /**
   * Submits an explicit starter prompt or current composer draft when a loaded
   * model is eligible.
   *
   * @param explicitPrompt - Optional starter prompt; omission submits the
   * current composer draft.
   * @returns A promise that resolves without opening a stream when a reply is
   * awaited or streaming, a stored conversation is opening, the prompt is
   * empty, or no loaded model is eligible; otherwise it resolves after stream
   * completion, failure, or invalidation.
   * @remarks An unavailable model records an inline error and preserves the
   * draft and conversation. A reply that is awaited or streaming, an opening
   * conversation, or an empty prompt is ignored. After the reply completed,
   * sending stops following its stream, which may still carry a title; the
   * backend keeps generating and saving that title.
   * The eligible model and generation controls are sampled once before request
   * ownership begins; later edits affect only later requests. The offered tools
   * are sampled once after ownership begins, before the stream opens. A tool
   * list that cannot be read fails the request with an inline error, and
   * nothing is sent.
   */
  sendMessage: (explicitPrompt?: string) => Promise<void>
  /**
   * Stops the active reply.
   *
   * @returns A promise that settles after the backend answered the stop
   * request, or at once when no request is involved; it never rejects.
   * @remarks While the reply streams, asks the backend to stop it and keeps
   * reading until `interrupted` or `done` arrives. Before the turn has
   * started, the stop is sent as soon as the start event names the reply; a
   * stop still pending when another conversation opens or the conversation
   * resets is dropped, and the backend generates the whole reply. After the
   * reply finished while a title may still arrive, only stops following. A
   * failed stop request records an inline error. Repeated presses while the
   * reply streams send repeated requests, which the backend treats
   * idempotently.
   */
  stopStreaming: () => Promise<void>
  /** Stops following active work and restores initial chat state. */
  resetConversation: () => void
  /**
   * Opens a stored conversation, replacing the shown one once it is read, and
   * follows its last reply while that reply is still generating.
   */
  openConversation: (conversationId: string) => Promise<void>
  /** Restores initial state when the view presents the identified conversation. */
  closeConversation: (conversationId: string) => void
}

/** State and actions exposed by one independently owned chat-view store. */
export type ChatViewStore = ChatViewState & ChatViewActions

/** Error shown when an owned stream closes before its done event. */
const PREMATURE_STREAM_CLOSE_MESSAGE = "Chat stream ended before completion."

/** Error shown when a conversation chosen for opening is no longer stored. */
const MISSING_CONVERSATION_MESSAGE = "That conversation no longer exists."

/** Error shown when a followed reply's stream closes before the reply is final. */
const PREMATURE_REPLY_STREAM_CLOSE_MESSAGE =
  "Stopped following the reply before it finished."

/** Error raised when a followed reply's stream does not start with a snapshot. */
const REPLY_STREAM_ORDER_MESSAGE = "Reply stream did not start with a snapshot."

/** Shared idle request state; it carries no per-request data. */
const IDLE_CHAT_REQUEST: ChatRequestState = Object.freeze({ status: "idle" })

/** Shared idle open state; it carries no per-open data. */
const IDLE_CONVERSATION_OPEN: ConversationOpenState = Object.freeze({
  status: "idle"
})

/**
 * Initial observable state used as a fresh value by independent stores.
 *
 * @remarks The outer, request, and open objects are frozen to prevent
 * accidental mutation; reset reuses this immutable snapshot and aborts the
 * prior owners.
 */
const INITIAL_CHAT_VIEW_STATE: Readonly<ChatViewState> = Object.freeze({
  inputDraft: "",
  conversation: undefined,
  request: IDLE_CHAT_REQUEST,
  conversationOpen: IDLE_CONVERSATION_OPEN,
  error: undefined
})

/** Terminal state for an assistant reply that did not complete normally. */
type IncompleteAssistantStatus = Extract<
  ConversationAssistantMessageStatus,
  "interrupted" | "failed"
>

/** Complete backend-owned conversation turn emitted at the start of a stream. */
type ChatTurnStartEvent = Extract<
  ChatApiStreamEvent,
  {
    type: "start-new-conversation-turn" | "start-existing-conversation-turn"
  }
>

/** Non-idle observable request state carrying phase-specific metadata. */
type OwnedChatRequestState = Exclude<ChatRequestState, { status: "idle" }>

/** Store-private transport resource correlated with one active request. */
type ChatRequestResource = {
  /** Token correlating this resource with observable request state. */
  readonly token: number
  /** Controller owned exclusively by the store. */
  readonly abortController: AbortController
}

/** Store-private read resource correlated with one conversation open. */
type ConversationOpenResource = {
  /** Token authorizing this open to commit its outcome. */
  readonly token: number
  /** Controller owned exclusively by the store. */
  readonly abortController: AbortController
}

/** Stored reply the store started following, with the request that owns it. */
type StoredReplyFollow = {
  /** Request token that owns the follow and its transport resource. */
  readonly token: number
  /** Followed reply and the conversation that holds it. */
  readonly target: ChatReplyPathParams
}

/** Request state whose backend-identified reply is accepting deltas. */
type StreamingChatReplyState = Extract<
  ChatRequestState,
  { status: "reply-streaming" }
>

/** Inputs sampled to create one immutable chat request payload. */
type CreateChatRequestPayloadInput = {
  /** Existing conversation identifier, when continuing a conversation. */
  readonly conversationId: string | undefined
  /** Trimmed prompt prepared for this turn. */
  readonly submittedPrompt: string
  /** Loaded model selected for this request. */
  readonly model: string
  /** Settings-owned generation controls for this request. */
  readonly generationOptions: MessageGenerationOptions
}

/**
 * How one owned chat stream is opened, applied, and closed.
 *
 * @typeParam TStreamEvent - Validated event union of the stream.
 */
type OwnedChatStreamOptions<TStreamEvent> = {
  /** Opens the stream with the store-owned signal. */
  readonly openEvents: (signal: AbortSignal) => AsyncIterable<TStreamEvent>
  /** Applies one event; may await follow-up work such as a requested stop. */
  readonly handleEvent: (event: TStreamEvent) => Promise<void> | void
  /** State recorded for the reply when the stream ends before it is final. */
  readonly incompleteStatus: IncompleteAssistantStatus
  /** Error recorded when the stream closes early without a stream error. */
  readonly prematureCloseMessage: string
}

/**
 * Converts an unknown thrown value into a user-presentable lifecycle error.
 *
 * @param error - Value thrown while opening or consuming the chat stream.
 * @returns A non-empty message suitable for polite inline presentation.
 */
function formatLifecycleErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Chat request failed."
}

/**
 * Converts an unknown value thrown while opening a conversation into an error.
 *
 * @param error - Value thrown while reading or converting the conversation.
 * @returns A non-empty message naming the failed open and its reason.
 */
function formatConversationOpenErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? `The conversation could not be opened: ${error.message}`
    : "The conversation could not be opened."
}

/**
 * Converts an unknown value thrown by a stop request into an error message.
 *
 * @param error - Value thrown while asking the backend to stop the reply.
 * @returns A non-empty message naming the failed stop and its reason.
 */
function formatReplyStopErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? `The reply could not be stopped: ${error.message}`
    : "The reply could not be stopped."
}

/**
 * Reads a followed reply's events, requiring the snapshot to come first.
 *
 * @param events - Events of one reply-events stream.
 * @returns The same events in order, completing when the source completes.
 * @throws If the first event is not a `reply-snapshot`, because later deltas
 * continue only from the snapshot's content.
 */
async function* readSnapshotFirstReplyEvents(
  events: AsyncIterable<ChatReplyEvent>
): AsyncGenerator<ChatReplyEvent, void, unknown> {
  let isFirstEvent = true
  for await (const event of events) {
    if (isFirstEvent && event.type !== "reply-snapshot") {
      throw new Error(REPLY_STREAM_ORDER_MESSAGE)
    }
    isFirstEvent = false
    yield event
  }
}

/**
 * Creates observable request state awaiting its backend conversation turn.
 *
 * @param token - Monotonic token assigned by the owning store.
 * @param submittedComposerDraft - Exact composer draft, when applicable.
 * @returns Observable request state awaiting its backend conversation turn.
 */
function createAwaitingTurnRequest(
  token: number,
  submittedComposerDraft?: string
): Extract<ChatRequestState, { status: "awaiting-turn" }> {
  return {
    status: "awaiting-turn",
    token,
    ...(submittedComposerDraft === undefined ? {} : { submittedComposerDraft })
  }
}

/**
 * Creates the private transport resource for one request token.
 *
 * @param token - Monotonic token assigned by the owning store.
 * @returns A private cancellation controller correlated with the token.
 */
function createChatRequestResource(token: number): ChatRequestResource {
  return { token, abortController: new AbortController() }
}

/**
 * Creates the current chat payload for a new or an existing conversation.
 *
 * @param input - Model, prompt, conversation, and generation values sampled for
 * this request.
 * @param toolOffer - Tools the request offers; omission sends none, so the
 * reply answers in one round.
 * @returns The complete payload. Without a conversation it starts a new one
 * that Lys answers; with one it continues it with the agent it was started
 * with.
 */
function createChatRequestPayload(
  {
    conversationId,
    submittedPrompt,
    model,
    generationOptions
  }: CreateChatRequestPayloadInput,
  toolOffer: ChatToolOffer | undefined
): ChatApiRequestBody {
  return {
    conversation:
      conversationId === undefined
        ? { kind: "new", agentCode: LYS_AGENT_CODE }
        : { kind: "existing", id: conversationId },
    message: submittedPrompt,
    model,
    generationOptions,
    ...(toolOffer === undefined ? {} : { tools: toolOffer })
  }
}

/**
 * Opens the chat stream for one owned request with the tools it offers.
 *
 * @param requestInput - Prompt, conversation, model, and generation controls
 * sampled before the request took ownership.
 * @param signal - Store-owned signal of the request.
 * @param dependencies - Tool-offer reader and chat transport of the store.
 * @returns An async generator yielding the chat events; it completes when the
 * chat stream closes.
 * @throws If the request would offer tools that cannot be read; the request
 * then fails without opening the stream.
 */
async function* openChatStreamWithToolOffer(
  requestInput: CreateChatRequestPayloadInput,
  signal: AbortSignal,
  dependencies: Pick<ChatViewStoreDependencies, "getToolOffer" | "streamChat">
): AsyncGenerator<ChatApiStreamEvent, void, unknown> {
  const toolOffer = await dependencies.getToolOffer()
  if (toolOffer.status === "unavailable") throw new Error(toolOffer.error)

  const offeredTools =
    toolOffer.status === "offered" ? toolOffer.offer : undefined
  yield* dependencies.streamChat(
    createChatRequestPayload(requestInput, offeredTools),
    { signal }
  )
}

/**
 * Creates one independently owned chat-view store.
 *
 * @param dependencies - Transport, timestamp, model-selection, and generation
 * providers for one store.
 * @returns A Zustand hook and store API owning one chat lifecycle.
 */
export function createChatViewStore(
  dependencies: ChatViewStoreDependencies
): UseBoundStore<StoreApi<ChatViewStore>> {
  /** Next token issued by this store; tokens never authorize another store. */
  let nextRequestToken = 1
  /** Current store-owned abort resource, or absent after invalidation. */
  let activeRequestResource: ChatRequestResource | undefined
  /** Next open token issued by this store; tokens never authorize another store. */
  let nextOpenToken = 1
  /** Current store-owned conversation read, or absent when none is owned. */
  let activeOpenResource: ConversationOpenResource | undefined
  /** Request token whose stop was requested before its reply was known. */
  let requestedStopToken: number | undefined

  /**
   * Updates an incomplete assistant when its exact message still exists.
   *
   * @param conversation - Current conversation, if the backend started one.
   * @param request - Request snapshot whose assistant may be terminal.
   * @param status - Interrupted or failed outcome to record.
   * @returns A new terminal conversation, or the unchanged current value.
   */
  function updateIncompleteAssistantReplyStatus(
    conversation: ChatViewConversation | undefined,
    request: OwnedChatRequestState,
    status: IncompleteAssistantStatus
  ): ChatViewConversation | undefined {
    if (request.status !== "reply-streaming" || !conversation) {
      return conversation
    }

    const ownedMessage = conversation.messages.find(
      (message) => message.id === request.assistantMessageId
    )
    if (
      ownedMessage?.role !== "assistant" ||
      ownedMessage.status !== "streaming"
    ) {
      return conversation
    }

    return updateAssistantReplyStatus(conversation, {
      assistantMessageId: request.assistantMessageId,
      status,
      finishReason: null,
      timestamp: dependencies.createTimestamp()
    })
  }

  /**
   * Reports whether a token still owns the conversation read.
   *
   * @param token - Open token attempting to commit its outcome.
   * @returns Whether that open has not been superseded or reset.
   */
  function isOpenOwned(token: number): boolean {
    return activeOpenResource?.token === token
  }

  /**
   * Creates the state and actions that own this store's request lifecycle.
   *
   * @param set - Zustand capability that applies observable state changes.
   * @param get - Zustand capability that reads current observable state.
   * @returns Initial chat state and its lifecycle actions.
   */
  function createChatViewStoreState(
    set: StoreApi<ChatViewStore>["setState"],
    get: StoreApi<ChatViewStore>["getState"]
  ): ChatViewStore {
    /**
     * Reports whether a token owns observable state and its private resource.
     *
     * @param token - Request token attempting to mutate the store.
     * @returns Whether the request remains authorized to change state.
     */
    function isRequestOwned(token: number): boolean {
      const request = get().request

      return (
        request.status !== "idle" &&
        request.token === token &&
        activeRequestResource?.token === token
      )
    }

    /**
     * Gets the non-idle request authorized by one token.
     *
     * @param token - Token expected to own the current request lifecycle.
     * @returns The authoritative request state carrying the supplied token.
     * @throws If the token no longer owns the request lifecycle.
     */
    function getOwnedRequest(token: number): OwnedChatRequestState {
      const request = get().request
      if (request.status === "idle" || !isRequestOwned(token)) {
        throw new Error("Chat request no longer owns the lifecycle")
      }

      return request
    }

    /**
     * Gets the private transport resource authorized by one request token.
     *
     * @param token - Token expected to own state and transport cancellation.
     * @returns The store-private resource correlated with the supplied token.
     * @throws If the token no longer owns both lifecycle representations.
     */
    function getOwnedRequestResource(token: number): ChatRequestResource {
      const resource = activeRequestResource
      if (!isRequestOwned(token) || resource?.token !== token) {
        throw new Error("Chat request no longer owns its transport resource")
      }

      return resource
    }

    /**
     * Gets the streaming reply authorized by one token.
     *
     * @param token - Token expected to own a reply accepting stream events.
     * @returns The authoritative streaming reply state.
     * @throws If the reply is absent or already terminal.
     */
    function getStreamingReply(token: number): StreamingChatReplyState {
      const request = getOwnedRequest(token)
      if (request.status !== "reply-streaming") {
        throw new Error("Chat reply is not accepting stream events")
      }

      return request
    }

    /**
     * Gets the conversation required by an in-order stream event.
     *
     * @returns The conversation currently receiving stream transitions.
     * @throws If a stream event arrives before conversation start.
     */
    function getActiveConversation(): ChatViewConversation {
      const conversation = get().conversation
      if (!conversation) {
        throw new Error("Chat conversation has not started")
      }

      return conversation
    }

    /**
     * Starts a backend-owned conversation turn for an awaiting request and
     * hands its reply to the tool-call store.
     *
     * @param event - Complete turn emitted by the backend stream.
     * @param token - Token expected to own the awaiting request.
     * @throws If the event is out of order or its token is inactive.
     */
    function handleChatTurnStartEvent(
      event: ChatTurnStartEvent,
      token: number
    ): void {
      const currentState = get()
      const request = getOwnedRequest(token)
      if (request.status !== "awaiting-turn") {
        throw new Error("Chat turn start did not match an awaiting request")
      }
      if (!isStreamingConversationAssistantMessage(event.assistantMessage)) {
        throw new Error(
          "Chat turn assistant must be streaming with no finish reason"
        )
      }

      const previousConversation =
        event.type === "start-existing-conversation-turn"
          ? getActiveConversation()
          : undefined
      const conversationMetadata =
        event.type === "start-new-conversation-turn"
          ? event.conversation
          : getActiveConversation()
      const conversation = startConversationTurn({
        conversationMetadata,
        previousConversation,
        userMessage: event.userMessage,
        assistantMessage: event.assistantMessage
      })
      const inputDraft =
        request.submittedComposerDraft !== undefined &&
        currentState.inputDraft === request.submittedComposerDraft
          ? ""
          : currentState.inputDraft
      const streamingRequest = {
        status: "reply-streaming",
        token,
        assistantMessageId: event.assistantMessage.id
      } satisfies Extract<ChatRequestState, { status: "reply-streaming" }>

      set({
        conversation,
        inputDraft,
        request: streamingRequest
      })
      const replyTarget = Object.freeze({
        conversationId: conversation.id,
        assistantMessageId: event.assistantMessage.id
      } satisfies ChatReplyPathParams)
      dependencies.startReplyToolCallFollow(replyTarget)
    }

    /**
     * Handles one authorized content delta for the streaming assistant reply.
     *
     * @param event - Delta event emitted by the backend stream.
     * @param token - Token expected to own the started reply.
     * @throws If the event is out of order or its assistant is absent.
     */
    function handleChatDeltaEvent(
      event: Extract<ChatApiStreamEvent, { type: "delta" }>,
      token: number
    ): void {
      const request = getStreamingReply(token)
      const conversation = getActiveConversation()

      set({
        conversation: updateAssistantReplyContent(conversation, {
          assistantMessageId: request.assistantMessageId,
          content: event.content,
          timestamp: dependencies.createTimestamp()
        })
      })
    }

    /**
     * Handles completion of one authorized streaming assistant reply.
     *
     * @param event - Done event containing the model finish reason.
     * @param token - Token expected to own the started reply.
     * @throws If the event is out of order or its assistant is absent.
     */
    function handleChatDoneEvent(
      event: Extract<ChatApiStreamEvent, { type: "done" }>,
      token: number
    ): void {
      const request = getStreamingReply(token)
      const conversation = getActiveConversation()

      set({
        conversation: updateAssistantReplyStatus(conversation, {
          assistantMessageId: request.assistantMessageId,
          status: "completed",
          finishReason: event.finishReason,
          timestamp: dependencies.createTimestamp()
        }),
        request: {
          status: "reply-completed",
          token,
          assistantMessageId: request.assistantMessageId
        }
      })
    }

    /**
     * Handles an authorized reply that ended before the model finished.
     *
     * @param token - Token expected to own the started reply.
     * @throws If the event is out of order or its assistant is absent.
     * @remarks A title may still arrive afterwards, so the request moves to
     * `reply-completed` rather than idle.
     */
    function handleChatInterruptedEvent(token: number): void {
      const request = getStreamingReply(token)
      const conversation = updateAssistantReplyStatus(getActiveConversation(), {
        assistantMessageId: request.assistantMessageId,
        status: "interrupted",
        finishReason: null,
        timestamp: dependencies.createTimestamp()
      })
      const completedRequest = {
        status: "reply-completed",
        token,
        assistantMessageId: request.assistantMessageId
      } satisfies ChatRequestState

      set({ conversation, request: completedRequest })
    }

    /**
     * Handles a reply generation failure reported by the backend.
     *
     * @param event - Error event carrying the user-presentable message.
     * @param token - Token expected to own the reply.
     * @remarks The backend stores the reply as failed before sending this
     * event, which ends the reply, so a streaming reply becomes failed and the
     * request moves to `reply-completed` while a title may still arrive. The
     * message is recorded inline in every request state.
     */
    function handleChatErrorEvent(
      event: Extract<ChatGenerationEvent, { type: "error" }>,
      token: number
    ): void {
      const request = getOwnedRequest(token)
      if (request.status !== "reply-streaming") {
        set({ error: event.message })
        return
      }

      const conversation = updateIncompleteAssistantReplyStatus(
        get().conversation,
        request,
        "failed"
      )
      const completedRequest = {
        status: "reply-completed",
        token,
        assistantMessageId: request.assistantMessageId
      } satisfies ChatRequestState

      set({ conversation, request: completedRequest, error: event.message })
    }

    /**
     * Applies the stored snapshot that starts a followed reply's stream.
     *
     * @param event - Snapshot of the followed reply and its conversation title.
     * @param token - Token expected to own the followed reply.
     * @throws If the snapshot names another reply or the reply is terminal.
     */
    function handleChatReplySnapshotEvent(
      event: Extract<ChatReplyEvent, { type: "reply-snapshot" }>,
      token: number
    ): void {
      const request = getStreamingReply(token)
      if (event.assistantMessage.id !== request.assistantMessageId) {
        throw new Error("Reply snapshot did not match the followed reply")
      }

      const withReply = updateAssistantReplyWithSnapshot(
        getActiveConversation(),
        event.assistantMessage
      )
      const conversation =
        event.conversationTitle === null
          ? withReply
          : updateConversationTitle(withReply, event.conversationTitle)
      const isStillStreaming =
        findStreamingReply(conversation)?.id === request.assistantMessageId
      const completedRequest = {
        status: "reply-completed",
        token,
        assistantMessageId: request.assistantMessageId
      } satisfies ChatRequestState

      set({
        conversation,
        request: isStillStreaming ? request : completedRequest
      })
    }

    /**
     * Handles one title for a started or completed assistant reply.
     *
     * @param event - Title event emitted by the backend stream.
     * @param token - Token expected to own a started assistant reply.
     * @throws If the event arrives before reply start or the active conversation
     * is absent. Stale tokens are rejected silently by the dispatcher before
     * this handler is reached.
     */
    function handleChatTitleEvent(
      event: Extract<ChatApiStreamEvent, { type: "title" }>,
      token: number
    ): void {
      const request = getOwnedRequest(token)
      if (
        request.status !== "reply-streaming" &&
        request.status !== "reply-completed"
      ) {
        throw new Error("Chat title event arrived before reply start")
      }

      set({
        conversation: updateConversationTitle(
          getActiveConversation(),
          event.title
        )
      })
    }

    /**
     * Applies one generation event shared by chat and followed-reply streams.
     *
     * @param event - Title, delta, tool-call, final, or error event of the
     * reply.
     * @param token - Token whose ownership authorizes event side effects.
     * @throws If an in-order handler detects an invariant violation.
     * @remarks Exactly one of `done`, `interrupted`, or `error` ends the
     * reply; the backend sends nothing but a possible `title` after it.
     */
    function handleChatGenerationEvent(
      event: ChatGenerationEvent,
      token: number
    ): void {
      switch (event.type) {
        case "title":
          handleChatTitleEvent(event, token)
          return
        case "delta":
          handleChatDeltaEvent(event, token)
          return
        case "done":
          handleChatDoneEvent(event, token)
          return
        case "interrupted":
          handleChatInterruptedEvent(token)
          return
        case "error":
          handleChatErrorEvent(event, token)
          return
        case "tool-call":
          // The tool-call store follows this reply itself and owns its calls.
          return
      }
    }

    /**
     * Applies one chat-stream event only while its request token is active.
     *
     * @param event - Typed event emitted by the active chat stream.
     * @param token - Token whose ownership authorizes event side effects.
     * @throws If an in-order handler detects a request or conversation
     * invariant violation.
     * @remarks A stale token is ignored without error.
     */
    function handleChatStreamEvent(
      event: ChatApiStreamEvent,
      token: number
    ): void {
      if (!isRequestOwned(token)) return

      switch (event.type) {
        case "start-new-conversation-turn":
        case "start-existing-conversation-turn":
          handleChatTurnStartEvent(event, token)
          return
        case "title":
        case "delta":
        case "done":
        case "interrupted":
        case "error":
        case "tool-call":
          handleChatGenerationEvent(event, token)
          return
      }
    }

    /**
     * Applies one followed-reply event only while its request token is active.
     *
     * @param event - Typed event of the followed reply's stream.
     * @param token - Token whose ownership authorizes event side effects.
     * @throws If an in-order handler detects an invariant violation.
     * @remarks A stale token is ignored without error.
     */
    function handleChatReplyEvent(event: ChatReplyEvent, token: number): void {
      if (!isRequestOwned(token)) return

      switch (event.type) {
        case "reply-snapshot":
          handleChatReplySnapshotEvent(event, token)
          return
        case "title":
        case "delta":
        case "done":
        case "interrupted":
        case "error":
        case "tool-call":
          handleChatGenerationEvent(event, token)
          return
      }
    }

    /**
     * Records an early end for an owned request and its reply when present.
     *
     * @param token - Token expected to own the request.
     * @param error - User-presentable message.
     * @param status - `failed` when the reply failed, `interrupted` when the
     * store only stopped following a reply that may still be generating.
     */
    function updateChatRequestFailure(
      token: number,
      error: string,
      status: IncompleteAssistantStatus
    ): void {
      if (!isRequestOwned(token)) return

      const request = getOwnedRequest(token)
      const conversation = updateIncompleteAssistantReplyStatus(
        get().conversation,
        request,
        status
      )
      set({ conversation, error })
    }

    /**
     * Reads one owned stream through terminal cleanup.
     *
     * @typeParam TStreamEvent - Validated event union of the stream.
     * @param token - Request token that owns the stream and its resource.
     * @param options - How the stream is opened, applied, and reported.
     * @returns A promise that resolves after completion, failure, or
     * invalidation.
     * @remarks Events are applied in arrival order. Stream closure before the
     * reply is final records the latest stream error, or the premature-close
     * message, with the incomplete status. Stale queued events and failures are
     * ignored silently after token invalidation. The finally block releases
     * the resource and returns the request to idle only while this token still
     * owns both representations.
     */
    async function readChatStream<TStreamEvent>(
      token: number,
      options: OwnedChatStreamOptions<TStreamEvent>
    ): Promise<void> {
      try {
        const resource = getOwnedRequestResource(token)
        const events = options.openEvents(resource.abortController.signal)
        for await (const event of events) {
          await options.handleEvent(event)
        }

        if (
          isRequestOwned(token) &&
          get().request.status !== "reply-completed"
        ) {
          updateChatRequestFailure(
            token,
            get().error ?? options.prematureCloseMessage,
            options.incompleteStatus
          )
        }
      } catch (error) {
        if (!isRequestOwned(token)) return
        updateChatRequestFailure(
          token,
          formatLifecycleErrorMessage(error),
          options.incompleteStatus
        )
      } finally {
        if (isRequestOwned(token)) {
          activeRequestResource = undefined
          set({ request: IDLE_CHAT_REQUEST })
        }
      }
    }

    /**
     * Replaces the composer draft with user-entered text.
     *
     * @param draft - Exact text currently entered in the composer.
     */
    function setInputDraft(draft: string): void {
      set({ inputDraft: draft })
    }

    /**
     * Reports whether a new chat request may take ownership of the lifecycle.
     *
     * @returns Whether no conversation is opening and no reply is awaited:
     * either no request is active, or the active one has a final reply and
     * only waits for a possible title.
     */
    function canStartChatRequest(): boolean {
      const { request, conversationOpen } = get()
      if (conversationOpen.status === "opening") return false

      switch (request.status) {
        case "idle":
        case "reply-completed":
          return true
        case "awaiting-turn":
        case "reply-streaming":
          return false
      }
    }

    /**
     * Implements {@link ChatViewActions.sendMessage} for this store.
     *
     * @param explicitPrompt - Optional starter prompt supplied outside composer.
     * @returns A promise with the admission and settlement semantics defined
     * by {@link ChatViewActions.sendMessage}.
     */
    async function sendMessage(explicitPrompt?: string): Promise<void> {
      if (!canStartChatRequest()) return

      const promptSource = explicitPrompt ?? get().inputDraft
      const submittedComposerDraft =
        explicitPrompt === undefined ? promptSource : undefined
      const submittedPrompt = promptSource.trim()
      if (!submittedPrompt) return
      const model = dependencies.findEligibleChatModel()
      if (model === null) {
        set({
          error:
            "Chat is unavailable. Check the backend and loaded model in Settings → Model, then try again."
        })
        return
      }

      const token = nextRequestToken
      nextRequestToken += 1
      const request = createAwaitingTurnRequest(token, submittedComposerDraft)
      const resource = createChatRequestResource(token)
      const requestInput = {
        conversationId: get().conversation?.id,
        submittedPrompt,
        model,
        generationOptions: dependencies.readGenerationOptions()
      } satisfies CreateChatRequestPayloadInput

      const supersededRequest = activeRequestResource
      activeRequestResource = resource
      set({
        error: undefined,
        request
      })
      supersededRequest?.abortController.abort()
      await readChatStream(token, {
        openEvents: (signal) =>
          openChatStreamWithToolOffer(requestInput, signal, dependencies),
        handleEvent: async (event) => {
          handleChatStreamEvent(event, token)
          await stopRequestedChatReply(token)
        },
        incompleteStatus: "failed",
        prematureCloseMessage: PREMATURE_STREAM_CLOSE_MESSAGE
      })
    }

    /**
     * Finds the reply an owned request is streaming.
     *
     * @param token - Request token expected to own a streaming reply.
     * @returns The reply and its conversation, or undefined when the token no
     * longer owns a streaming reply.
     */
    function findOwnedReplyTarget(
      token: number
    ): ChatReplyPathParams | undefined {
      const { request, conversation } = get()
      if (
        !isRequestOwned(token) ||
        request.status !== "reply-streaming" ||
        conversation === undefined
      ) {
        return undefined
      }

      return {
        conversationId: conversation.id,
        assistantMessageId: request.assistantMessageId
      }
    }

    /**
     * Asks the backend to stop an owned reply and records a failed request.
     *
     * @param token - Request token that owns the reply.
     * @param target - Reply and the conversation that holds it.
     * @returns Settlement after the stop request settles; it never rejects.
     * @remarks The reply's `interrupted` or `done` event, not this request,
     * updates the reply. A reply that is no longer generating needs nothing
     * more: its final event is already on the stream.
     */
    async function stopOwnedChatReply(
      token: number,
      target: ChatReplyPathParams
    ): Promise<void> {
      try {
        await dependencies.stopChatReply(target)
      } catch (error) {
        if (isRequestOwned(token)) {
          set({ error: formatReplyStopErrorMessage(error) })
        }
      }
    }

    /**
     * Stops a reply whose stop was requested before its turn started.
     *
     * @param token - Request whose stream just applied an event.
     * @returns Settlement after the stop request settles, or at once when no
     * stop is pending for this request or its reply is not known yet.
     */
    async function stopRequestedChatReply(token: number): Promise<void> {
      if (requestedStopToken !== token) return
      const target = findOwnedReplyTarget(token)
      if (target === undefined) return

      requestedStopToken = undefined
      await stopOwnedChatReply(token, target)
    }

    /**
     * Stops following the owned request's stream without affecting the
     * backend.
     *
     * @param token - Request token that owns the stream.
     * @throws If the observable request has no matching private resource.
     * @remarks The token and resource are cleared before abort so queued
     * transport events cannot commit state.
     */
    function stopFollowingChatReply(token: number): void {
      const resource = getOwnedRequestResource(token)
      activeRequestResource = undefined
      set({ request: IDLE_CHAT_REQUEST })
      resource.abortController.abort()
    }

    /**
     * Implements {@link ChatViewActions.stopStreaming} for this store.
     *
     * @returns A promise with the settlement defined by
     * {@link ChatViewActions.stopStreaming}.
     */
    async function stopStreaming(): Promise<void> {
      const request = get().request
      switch (request.status) {
        case "idle":
          return
        case "awaiting-turn":
          requestedStopToken = request.token
          return
        case "reply-completed":
          if (isRequestOwned(request.token))
            stopFollowingChatReply(request.token)
          return
        case "reply-streaming": {
          const target = findOwnedReplyTarget(request.token)
          if (target !== undefined)
            await stopOwnedChatReply(request.token, target)
          return
        }
      }
    }

    /**
     * Restores initial chat state and stops following any active stream.
     *
     * @remarks Reset invalidates the request and open tokens before aborting
     * the local transports, clears draft, conversation, request, open, and
     * error together, and reports no error. The backend keeps generating a
     * reply that was streaming.
     */
    function resetConversation(): void {
      const requestResource = activeRequestResource
      const openResource = activeOpenResource
      activeRequestResource = undefined
      activeOpenResource = undefined
      set(INITIAL_CHAT_VIEW_STATE)
      requestResource?.abortController.abort()
      openResource?.abortController.abort()
    }

    /**
     * Reports whether the view already shows a conversation with no open pending.
     *
     * @param conversationId - Conversation requested for opening.
     * @returns Whether opening it again would change nothing.
     */
    function isConversationShown(conversationId: string): boolean {
      const { conversation, conversationOpen } = get()

      return (
        conversationOpen.status === "idle" &&
        conversation?.id === conversationId
      )
    }

    /**
     * Reports whether the view presents, or is about to present, a conversation.
     *
     * @param conversationId - Conversation whose presentation is checked.
     * @returns Whether it is the conversation being opened, or the shown
     * conversation when no other conversation is opening.
     */
    function isConversationPresented(conversationId: string): boolean {
      const { conversation, conversationOpen } = get()

      return conversationOpen.status === "opening"
        ? conversationOpen.conversationId === conversationId
        : conversation?.id === conversationId
    }

    /**
     * Calculates the composer draft kept when an opened conversation is shown.
     *
     * @returns An empty draft when the composer still holds the text it had
     * when the open started, or the text typed while the conversation opened.
     */
    function calculateOpenedConversationDraft(): string {
      const { inputDraft, conversationOpen } = get()
      const isDraftUnchanged =
        conversationOpen.status === "opening" &&
        inputDraft === conversationOpen.replacedComposerDraft

      return isDraftUnchanged ? "" : inputDraft
    }

    /**
     * Updates the view with the outcome of an owned conversation read.
     *
     * @param result - Stored conversation or absence outcome from the backend.
     * @throws If the stored conversation violates a transcript invariant; the
     * caller still owns the open and records that failure.
     */
    function updateViewWithStoredConversation(
      result: GetConversationResult
    ): void {
      switch (result.status) {
        case "found": {
          const conversation = createStoredChatViewConversation(
            result.conversation
          )
          const inputDraft = calculateOpenedConversationDraft()
          activeOpenResource = undefined
          set({
            conversation,
            inputDraft,
            error: undefined,
            conversationOpen: IDLE_CONVERSATION_OPEN
          })
          return
        }
        case "not-found":
          activeOpenResource = undefined
          set({
            error: MISSING_CONVERSATION_MESSAGE,
            conversationOpen: IDLE_CONVERSATION_OPEN
          })
          return
      }
    }

    /**
     * Starts following the reply that ends the shown conversation when that
     * reply is still generating.
     *
     * @returns The started follow, or undefined when the shown conversation
     * does not end with a streaming reply.
     * @remarks Runs in the same synchronous step that ended the open, whether
     * it showed the opened conversation or kept the previous one, so no
     * request can start in between. The request enters `reply-streaming` at
     * once, which keeps the composer from sending. The reply is also handed
     * to the tool-call store, which answers its tool calls.
     */
    function startStoredReplyFollowing(): StoredReplyFollow | undefined {
      const conversation = get().conversation
      const followedReply =
        conversation === undefined
          ? undefined
          : findStreamingReply(conversation)
      if (conversation === undefined || followedReply === undefined)
        return undefined

      const token = nextRequestToken
      nextRequestToken += 1
      activeRequestResource = createChatRequestResource(token)
      const followingRequest = {
        status: "reply-streaming",
        token,
        assistantMessageId: followedReply.id
      } satisfies ChatRequestState
      set({ request: followingRequest })
      const target = Object.freeze({
        conversationId: conversation.id,
        assistantMessageId: followedReply.id
      } satisfies ChatReplyPathParams)
      dependencies.startReplyToolCallFollow(target)
      return { token, target }
    }

    /**
     * Reads a followed reply's stream from its snapshot to its end.
     *
     * @param follow - Follow started by {@link startStoredReplyFollowing}.
     * @returns Settlement after the stream ends, fails, or is superseded.
     * @remarks The snapshot replaces the stored content, so later deltas are
     * neither lost nor repeated. An early end shows the reply interrupted,
     * because the store only stopped following it.
     */
    async function readStoredReplyStream(
      follow: StoredReplyFollow
    ): Promise<void> {
      await readChatStream(follow.token, {
        openEvents: (signal) =>
          readSnapshotFirstReplyEvents(
            dependencies.streamChatReply(follow.target, signal)
          ),
        handleEvent: (event) => {
          handleChatReplyEvent(event, follow.token)
        },
        incompleteStatus: "interrupted",
        prematureCloseMessage: PREMATURE_REPLY_STREAM_CLOSE_MESSAGE
      })
    }

    /**
     * Loads one stored conversation into the view through commit or failure.
     *
     * @param conversationId - Conversation being opened.
     * @param resource - Private read resource owned by this open.
     * @returns A promise that resolves after the outcome commits, the failure
     * is recorded, or the open is superseded. It carries the started follow
     * when the conversation shown afterwards ends with a reply that is still
     * generating: the opened one, or the previous one when the open failed.
     * @remarks Superseded reads are ignored silently, including their
     * failures, because a newer open, reset, or close already owns the view.
     */
    async function loadStoredConversation(
      conversationId: string,
      resource: ConversationOpenResource
    ): Promise<StoredReplyFollow | undefined> {
      try {
        const result = await dependencies.getConversation(
          conversationId,
          resource.abortController.signal
        )
        if (!isOpenOwned(resource.token)) return undefined
        updateViewWithStoredConversation(result)
      } catch (error) {
        if (!isOpenOwned(resource.token)) return undefined
        activeOpenResource = undefined
        set({
          error: formatConversationOpenErrorMessage(error),
          conversationOpen: IDLE_CONVERSATION_OPEN
        })
      }
      return startStoredReplyFollowing()
    }

    /**
     * Opens a stored conversation, replacing the shown one once it is read.
     *
     * @param conversationId - UUIDv7 of the stored conversation to open.
     * @returns A promise that resolves after the read commits, fails, or is
     * superseded by a newer open, reset, or close, and after any followed
     * reply's stream ends.
     * @remarks Opening the conversation already shown is ignored. Otherwise
     * the active request, if any, is invalidated first: the view stops
     * following its reply, whose text stays as last shown while the backend
     * keeps generating it. Its transport and any earlier open are aborted. The
     * previous conversation stays visible until the read succeeds. A
     * successful open clears the draft only if it still holds the text present
     * when the open started, so text typed while opening is kept. When the
     * opened conversation ends with a reply that is still generating, the
     * store follows it. A missing conversation or a failed read leaves the
     * previous conversation with an inline error, and the store follows its
     * reply again from a fresh snapshot when that reply is still generating.
     */
    async function openConversation(conversationId: string): Promise<void> {
      if (isConversationShown(conversationId)) return

      const resource: ConversationOpenResource = {
        token: nextOpenToken,
        abortController: new AbortController()
      }
      nextOpenToken += 1
      const conversationOpen: ConversationOpenState = {
        status: "opening",
        conversationId,
        replacedComposerDraft: get().inputDraft
      }
      const supersededRequest = activeRequestResource
      const supersededOpen = activeOpenResource
      activeRequestResource = undefined
      activeOpenResource = resource
      set({
        request: IDLE_CHAT_REQUEST,
        conversationOpen,
        error: undefined
      })
      supersededRequest?.abortController.abort()
      supersededOpen?.abortController.abort()
      const follow = await loadStoredConversation(conversationId, resource)
      if (follow !== undefined) await readStoredReplyStream(follow)
    }

    /**
     * Restores initial state when the view presents a removed conversation.
     *
     * @param conversationId - Conversation that is no longer stored.
     * @remarks When the identified conversation is shown or being opened, this
     * behaves as {@link resetConversation}, including discarding the draft.
     * Otherwise, including while a different conversation is opening to
     * replace it, nothing changes.
     */
    function closeConversation(conversationId: string): void {
      if (!isConversationPresented(conversationId)) return

      resetConversation()
    }

    return {
      ...INITIAL_CHAT_VIEW_STATE,
      setInputDraft,
      sendMessage,
      stopStreaming,
      resetConversation,
      openConversation,
      closeConversation
    }
  }

  return create<ChatViewStore>(createChatViewStoreState)
}

/**
 * Reads a stored conversation from the backend the application store names.
 *
 * @param conversationId - UUIDv7 of the conversation to open.
 * @param signal - Store-owned signal aborted when the open is superseded.
 * @returns The stored conversation or the absence outcome.
 * @throws If the request, transport, or response validation fails.
 * @remarks The backend origin is sampled when the read starts.
 */
function getStoredConversation(
  conversationId: string,
  signal: AbortSignal
): Promise<GetConversationResult> {
  const backendUrl = useLysStore.getState().backendUrl

  return getConversation(conversationId, { backendUrl, signal })
}

/**
 * Gets the tools the next chat request offers.
 *
 * @returns A promise that resolves with `not-offered` when tool calls are off
 * or the loaded model is not known to be trained for tool use, and otherwise
 * with the offer built from the tool list, which is read first when it has
 * not been. It never rejects.
 */
async function getChatToolOffer(): Promise<ChatToolOfferResult> {
  const { modelRuntime, modelInventory } = useLysStore.getState()
  const support = calculateToolModelSupport(modelRuntime, modelInventory)
  const { areToolCallsOn, list, loadTools } = useToolStore.getState()
  if (!areToolCallsOn || support.status !== "trained") {
    return NO_CHAT_TOOL_OFFER
  }
  if (list.status !== "loaded") await loadTools()

  const { list: currentList, toolChoices } = useToolStore.getState()
  return buildChatToolOffer({ list: currentList, toolChoices })
}

/**
 * Chat-view store used by the desktop React tree.
 *
 * @remarks This singleton owns the live browser request and open lifecycles.
 * Tests or alternate compositions should call {@link createChatViewStore} to
 * obtain separate token and abort-resource owners. Application-store
 * dependencies supply the model and Generation controls to
 * {@link ChatViewActions.sendMessage}. The two generation controls are named
 * explicitly because the request contract rejects unknown fields. A saved zero
 * ceiling is omitted so the backend receives no explicit completion-token limit.
 * The backend origin for following and stopping a reply is sampled when each
 * request starts. Tool offers read the Tools pane and the loaded model when
 * each request takes ownership, and every reply the store starts or follows
 * is handed to the tool-call store.
 */
export const useChatViewStore: UseBoundStore<StoreApi<ChatViewStore>> =
  createChatViewStore({
    streamChat: readChatEvents,
    streamChatReply: (target, signal) =>
      readChatReplyEvents(target, {
        backendUrl: useLysStore.getState().backendUrl,
        signal
      }),
    stopChatReply: (target) =>
      stopChatReply(target, { backendUrl: useLysStore.getState().backendUrl }),
    getConversation: getStoredConversation,
    createTimestamp: () => new Date().toISOString(),
    findEligibleChatModel: () => {
      const { backendServerInfo, modelRuntime } = useLysStore.getState()

      return findEligibleChatModel(backendServerInfo.status, modelRuntime)
    },
    readGenerationOptions: () => {
      const { temperature, replyCeiling } =
        useLysStore.getState().settings.generation

      return replyCeiling === 0
        ? { temperature }
        : { temperature, replyCeiling }
    },
    getToolOffer: getChatToolOffer,
    startReplyToolCallFollow: (target) => {
      useToolCallStore.getState().startReplyToolCallFollow(target)
    }
  })
