import type {
  ChatApiRequestBody,
  ChatApiStreamEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type { ConversationAssistantMessageStatus } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import { readChatEvents, type ChatApiOptions } from "@/lib/apis/http/chat"
import {
  getConversation,
  type GetConversationResult
} from "@/lib/apis/http/conversations"
import { useLysStore } from "@/lib/store"

import {
  type ChatViewConversation,
  createStoredChatViewConversation,
  isStreamingConversationAssistantMessage,
  startConversationTurn,
  updateAssistantReplyContent,
  updateAssistantReplyStatus,
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
 * @remarks Aborting `options.signal` requests transport cancellation; consumers
 * must still ignore any events already queued by the transport.
 */
export type ChatStream = (
  payload: ChatApiRequestBody,
  options?: ChatApiOptions
) => AsyncGenerator<ChatApiStreamEvent, void, unknown>

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
 * these dependencies provide only transport, stored-conversation reads,
 * timestamps, and generation settings. The store does not share lifecycle
 * state with another store instance, and does not own the settings it reads.
 */
export type ChatViewStoreDependencies = {
  /** Opens the backend chat stream; the store supplies its owned abort signal. */
  readonly streamChat: ChatStream
  /** Reads a stored conversation; the store supplies its owned abort signal. */
  readonly getConversation: StoredConversationReader
  /** Creates the ISO timestamp recorded on each immutable transition. */
  readonly createTimestamp: () => string
  /**
   * Reads the generation controls applied to the next request.
   *
   * @returns The settings-owned controls current at call time; the store reads
   * them once per request, so a later change applies to the following request.
   */
  readonly readGenerationOptions: () => MessageGenerationOptions
}

/**
 * Authoritative observable lifecycle state of one chat request.
 *
 * @remarks One monotonically increasing token is the authority for every
 * stream event and private transport resource. `reply-completed` permits
 * title events after `done`; no later request state accepts deltas again.
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
  /** Latest lifecycle error shown inline, or undefined when clear. */
  readonly error?: string
}

/**
 * Actions that mutate or advance the chat lifecycle.
 *
 * @remarks `sendMessage` resolves after stream completion, failure, or request
 * invalidation, and `openConversation` after the read commits, fails, or is
 * superseded. `stopStreaming` and `resetConversation` abort the store-owned
 * transport; reset additionally discards the conversation and error.
 */
export type ChatViewActions = {
  /** Replaces the composer draft with user-entered text. */
  setInputDraft: (draft: string) => void
  /** Submits an explicit starter prompt or the current composer draft. */
  sendMessage: (explicitPrompt?: string) => Promise<void>
  /** Interrupts the active assistant reply without affecting prior history. */
  stopStreaming: () => void
  /** Silently invalidates active work and restores initial chat state. */
  resetConversation: () => void
  /** Opens a stored conversation, replacing the shown one once it is read. */
  openConversation: (conversationId: string) => Promise<void>
  /** Restores initial state when the view presents the identified conversation. */
  closeConversation: (conversationId: string) => void
}

/** State and actions exposed by one independently owned chat-view store. */
export type ChatViewStore = ChatViewState & ChatViewActions

/** Model identifier sent by the current chat lifecycle integration. */
const CHAT_MODEL = "google/gemma-4-12b-qat"

/** Error shown when an owned stream closes before its done event. */
const PREMATURE_STREAM_CLOSE_MESSAGE = "Chat stream ended before completion."

/** Error shown when a conversation chosen for opening is no longer stored. */
const MISSING_CONVERSATION_MESSAGE = "That conversation no longer exists."

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

/** Request state whose backend-identified reply is accepting deltas. */
type StreamingChatReplyState = Extract<
  ChatRequestState,
  { status: "reply-streaming" }
>

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
 * Creates the current chat payload with conversation absence represented by omission.
 *
 * @param conversationId - Existing conversation identifier, when continuing.
 * @param submittedPrompt - Trimmed prompt prepared for this turn.
 * @param generationOptions - Settings-owned controls for this request.
 * @returns The complete payload for a new or existing conversation.
 * @remarks The request contract is strict, so conversation absence is
 * represented by omitting the identifier rather than sending an empty one.
 */
function createChatRequestPayload(
  conversationId: string | undefined,
  submittedPrompt: string,
  generationOptions: MessageGenerationOptions
): ChatApiRequestBody {
  return conversationId
    ? {
        conversationId,
        message: submittedPrompt,
        model: CHAT_MODEL,
        generationOptions
      }
    : { message: submittedPrompt, model: CHAT_MODEL, generationOptions }
}

/**
 * Creates one independently owned chat-view store.
 *
 * @param dependencies - Transport and timestamp providers for one store.
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
        !ownedMessage ||
        ownedMessage.role !== "assistant" ||
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
     * Starts a backend-owned conversation turn for an awaiting request.
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
     * Applies one stream event only while its request token remains active.
     *
     * @param event - Typed event emitted by the active chat stream.
     * @param token - Token whose ownership authorizes event side effects.
     * @throws If an in-order handler detects a request or conversation
     * invariant violation.
     * @remarks A stale token is ignored without error. An `error` event only
     * records the latest inline error; it is non-terminal, so later `title` or
     * `done` events may still be applied while this token remains active.
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
          handleChatTitleEvent(event, token)
          return
        case "delta":
          handleChatDeltaEvent(event, token)
          return
        case "done":
          handleChatDoneEvent(event, token)
          return
        case "error":
          set({ error: event.message })
          return
      }
    }

    /**
     * Records failure for an owned request and its assistant when present.
     *
     * @param token - Token expected to own the failed request.
     * @param error - User-presentable failure message.
     */
    function updateChatRequestFailure(token: number, error: string): void {
      if (!isRequestOwned(token)) return

      const request = getOwnedRequest(token)
      const conversation = updateIncompleteAssistantReplyStatus(
        get().conversation,
        request,
        "failed"
      )
      set({ conversation, error })
    }

    /**
     * Reads one request's stream through terminal cleanup.
     *
     * @param payload - Complete store-created payload for this request.
     * @param request - Awaiting observable state correlated with the transport.
     * @returns A promise that resolves after completion, failure, or invalidation.
     * @remarks Events are consumed in arrival order. An `error` notification
     * records the latest inline error but does not end iteration; a later
     * `title` or `done` event may still complete the request. A normal `done`
     * event makes the assistant terminal; a close before `done` records
     * failure with the latest stream error or the premature-close message.
     * Stale queued events and failures are ignored silently after token
     * invalidation. The finally block releases the active resource and returns
     * the request to idle only while this token still owns both representations.
     */
    async function readChatStream(
      payload: ChatApiRequestBody,
      request: Extract<ChatRequestState, { status: "awaiting-turn" }>
    ): Promise<void> {
      try {
        const resource = getOwnedRequestResource(request.token)
        const events = dependencies.streamChat(payload, {
          signal: resource.abortController.signal
        })
        for await (const event of events) {
          handleChatStreamEvent(event, request.token)
        }

        const currentRequest = get().request
        if (
          isRequestOwned(request.token) &&
          currentRequest.status !== "reply-completed"
        ) {
          updateChatRequestFailure(
            request.token,
            get().error ?? PREMATURE_STREAM_CLOSE_MESSAGE
          )
        }
      } catch (error) {
        if (!isRequestOwned(request.token)) return
        updateChatRequestFailure(
          request.token,
          formatLifecycleErrorMessage(error)
        )
      } finally {
        if (isRequestOwned(request.token)) {
          activeRequestResource = undefined
          set({ request: { status: "idle" } })
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
     * @returns Whether no request is active and no conversation is opening.
     */
    function canStartChatRequest(): boolean {
      const { request, conversationOpen } = get()

      return request.status === "idle" && conversationOpen.status === "idle"
    }

    /**
     * Submits an explicit starter prompt or the current composer draft.
     *
     * @param explicitPrompt - Optional starter prompt supplied outside composer.
     * @returns A promise that resolves after this request loses or ends ownership.
     * @remarks A submission is ignored while a request is active or a stored
     * conversation is opening.
     */
    async function sendMessage(explicitPrompt?: string): Promise<void> {
      if (!canStartChatRequest()) return

      const promptSource =
        explicitPrompt === undefined ? get().inputDraft : explicitPrompt
      const submittedComposerDraft =
        explicitPrompt === undefined ? promptSource : undefined
      const submittedPrompt = promptSource.trim()
      if (!submittedPrompt) return

      const token = nextRequestToken
      nextRequestToken += 1
      const request = createAwaitingTurnRequest(token, submittedComposerDraft)
      const resource = createChatRequestResource(token)
      const payload = createChatRequestPayload(
        get().conversation?.id,
        submittedPrompt,
        dependencies.readGenerationOptions()
      )

      activeRequestResource = resource
      set({
        error: undefined,
        request
      })
      await readChatStream(payload, request)
    }

    /**
     * Interrupts the active assistant reply and requests transport abort.
     *
     * @remarks Awaiting-turn requests are also invalidated, although no
     * assistant exists yet to mark interrupted. The token and resource are
     * cleared before abort so queued transport events cannot commit state.
     * @throws If the observable request has no matching private resource.
     */
    function stopStreaming(): void {
      const currentState = get()
      const request = currentState.request
      if (request.status === "idle") return
      const resource = getOwnedRequestResource(request.token)

      const conversation = updateIncompleteAssistantReplyStatus(
        currentState.conversation,
        request,
        "interrupted"
      )
      activeRequestResource = undefined
      set({
        conversation,
        request: { status: "idle" }
      })
      resource.abortController.abort()
    }

    /**
     * Restores initial chat state and silently aborts any active transport.
     *
     * @remarks Reset invalidates the request and open tokens before aborting,
     * clears draft, conversation, request, open, and error together, and
     * intentionally reports no cancellation error from superseded work.
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
     * Reports whether a token still owns the conversation read.
     *
     * @param token - Open token attempting to commit its outcome.
     * @returns Whether that open has not been superseded or reset.
     */
    function isOpenOwned(token: number): boolean {
      return activeOpenResource?.token === token
    }

    /**
     * Calculates the shown conversation after its active reply is abandoned.
     *
     * @returns The current conversation with any streaming reply owned by the
     * active request marked interrupted, or the unchanged conversation.
     */
    function calculateInterruptedConversation():
      ChatViewConversation | undefined {
      const { conversation, request } = get()
      if (request.status === "idle") return conversation

      return updateIncompleteAssistantReplyStatus(
        conversation,
        request,
        "interrupted"
      )
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
          activeOpenResource = undefined
          set({
            conversation,
            inputDraft: "",
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
     * Loads one stored conversation into the view through commit or failure.
     *
     * @param conversationId - Conversation being opened.
     * @param resource - Private read resource owned by this open.
     * @returns A promise that resolves after the outcome commits, the failure
     * is recorded, or the open is superseded.
     * @remarks Superseded reads are ignored silently, including their
     * failures, because a newer open, reset, or close already owns the view.
     */
    async function loadStoredConversation(
      conversationId: string,
      resource: ConversationOpenResource
    ): Promise<void> {
      try {
        const result = await dependencies.getConversation(
          conversationId,
          resource.abortController.signal
        )
        if (!isOpenOwned(resource.token)) return
        updateViewWithStoredConversation(result)
      } catch (error) {
        if (!isOpenOwned(resource.token)) return
        activeOpenResource = undefined
        set({
          error: formatConversationOpenErrorMessage(error),
          conversationOpen: IDLE_CONVERSATION_OPEN
        })
      }
    }

    /**
     * Opens a stored conversation, replacing the shown one once it is read.
     *
     * @param conversationId - UUIDv7 of the stored conversation to open.
     * @returns A promise that resolves after the read commits, fails, or is
     * superseded by a newer open, reset, or close.
     * @remarks Opening the conversation already shown is ignored. Otherwise
     * the active request, if any, is invalidated first: its streaming reply is
     * marked interrupted and its transport and any earlier open are aborted.
     * The previous conversation stays visible until the read succeeds; a
     * successful open also clears the draft. A missing conversation or a
     * failed read leaves the previous conversation with an inline error.
     */
    async function openConversation(conversationId: string): Promise<void> {
      if (isConversationShown(conversationId)) return

      const resource: ConversationOpenResource = {
        token: nextOpenToken,
        abortController: new AbortController()
      }
      nextOpenToken += 1
      const conversation = calculateInterruptedConversation()
      const conversationOpen: ConversationOpenState = {
        status: "opening",
        conversationId
      }
      const supersededRequest = activeRequestResource
      const supersededOpen = activeOpenResource
      activeRequestResource = undefined
      activeOpenResource = resource
      set({
        conversation,
        request: IDLE_CHAT_REQUEST,
        conversationOpen,
        error: undefined
      })
      supersededRequest?.abortController.abort()
      supersededOpen?.abortController.abort()
      await loadStoredConversation(conversationId, resource)
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
 * Chat-view store used by the desktop React tree.
 *
 * @remarks This singleton owns the live browser request and open lifecycles.
 * Tests or alternate compositions should call {@link createChatViewStore} to
 * obtain separate token and abort-resource owners. Generation controls are
 * read from the application store at send time, so the request carries the
 * settings shown by the Generation pane; the two controls are named explicitly
 * because the request contract rejects unknown fields. A saved zero ceiling is
 * omitted so the backend receives no explicit completion-token limit.
 */
export const useChatViewStore: UseBoundStore<StoreApi<ChatViewStore>> =
  createChatViewStore({
    streamChat: readChatEvents,
    getConversation: getStoredConversation,
    createTimestamp: () => new Date().toISOString(),
    readGenerationOptions: () => {
      const { temperature, replyCeiling } =
        useLysStore.getState().settings.generation

      return replyCeiling === 0
        ? { temperature }
        : { temperature, replyCeiling }
    }
  })
