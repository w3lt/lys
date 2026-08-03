import type { ChatApiRequestBody, ChatApiStreamEvent } from "@lys/protocol"
import type { Conversation } from "@lys/share"
import { create, type StoreApi, type UseBoundStore } from "zustand"

import { readChatEvents, type ChatApiOptions } from "@/lib/apis/http/chat"

import {
  startAssistantReply,
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

/** Runtime dependencies used by one chat-view store instance. */
export type ChatViewStoreDependencies = {
  /** Opens the backend chat stream for one submitted prompt. */
  readonly streamChat: ChatStream
  /** Creates an ISO timestamp for one lifecycle transition. */
  readonly createTimestamp: () => string
}

/** Authoritative observable lifecycle state of one chat request. */
export type ChatRequestState =
  | {
      /** No request owns the chat lifecycle. */
      readonly status: "idle"
    }
  | {
      /** The request is waiting for the backend to identify its reply. */
      readonly status: "awaiting-start"
      /** Token authorizing this request to mutate chat state. */
      readonly token: number
      /** Trimmed prompt submitted to the backend. */
      readonly submittedPrompt: string
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

/** Observable state rendered by the chat view. */
export type ChatViewState = {
  /** Current composer text. */
  readonly inputDraft: string
  /** Active conversation, or undefined before a conversation starts. */
  readonly conversation?: Conversation
  /** Single authoritative observable request lifecycle state. */
  readonly request: ChatRequestState
  /** Latest lifecycle error shown inline, or undefined when clear. */
  readonly error?: string
}

/** Actions that mutate or advance the chat lifecycle. */
export type ChatViewActions = {
  /** Replaces the composer draft with user-entered text. */
  setInputDraft: (draft: string) => void
  /** Submits an explicit starter prompt or the current composer draft. */
  sendMessage: (explicitPrompt?: string) => Promise<void>
  /** Interrupts the active assistant reply without affecting prior history. */
  stopStreaming: () => void
  /** Silently invalidates active work and restores initial chat state. */
  resetConversation: () => void
}

/** State and actions exposed by one chat-view Zustand store. */
export type ChatViewStore = ChatViewState & ChatViewActions

/** Model identifier used by the current chat lifecycle integration. */
const CHAT_MODEL = "google/gemma-4-12b-qat"

/** Error shown when an owned stream closes before its done event. */
const PREMATURE_STREAM_CLOSE_MESSAGE = "Chat stream ended before completion."

/** Initial observable state shared by independent chat-view stores. */
const INITIAL_CHAT_VIEW_STATE: Readonly<ChatViewState> = Object.freeze({
  inputDraft: "",
  conversation: undefined,
  request: Object.freeze({ status: "idle" }),
  error: undefined
})

/** Terminal state for an assistant reply that did not complete normally. */
type IncompleteAssistantStatus = "interrupted" | "failed"

/** Non-idle observable request state carrying phase-specific metadata. */
type OwnedChatRequestState = Exclude<ChatRequestState, { status: "idle" }>

/** Store-private transport resource correlated with one active request. */
type ChatRequestResource = {
  /** Token correlating this resource with observable request state. */
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
 * Creates observable request state awaiting its backend start event.
 *
 * @param token - Monotonic token assigned by the owning store.
 * @param submittedPrompt - Trimmed prompt sent to the backend.
 * @param submittedComposerDraft - Exact composer draft, when applicable.
 * @returns Observable request state awaiting its backend start event.
 */
function createAwaitingChatRequest(
  token: number,
  submittedPrompt: string,
  submittedComposerDraft?: string
): Extract<ChatRequestState, { status: "awaiting-start" }> {
  return {
    status: "awaiting-start",
    token,
    submittedPrompt,
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
 * Creates a chat payload with conversation absence represented by omission.
 *
 * @param conversationId - Existing conversation identifier, when continuing.
 * @param submittedPrompt - Trimmed prompt sent for this turn.
 * @returns The protocol request for a new or existing conversation.
 */
function createChatRequestPayload(
  conversationId: string | undefined,
  submittedPrompt: string
): ChatApiRequestBody {
  return conversationId
    ? { conversationId, message: submittedPrompt, model: CHAT_MODEL }
    : { message: submittedPrompt, model: CHAT_MODEL }
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
  let nextRequestToken = 1
  let activeRequestResource: ChatRequestResource | undefined

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
    function getActiveConversation(): Conversation {
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
      conversation: Conversation | undefined,
      request: OwnedChatRequestState,
      status: IncompleteAssistantStatus
    ): Conversation | undefined {
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
     * Starts the backend-identified assistant reply for an awaiting request.
     *
     * @param event - Start event containing conversation metadata and message ID.
     * @param token - Token expected to own the awaiting request.
     * @throws If the event is out of order or its token is inactive.
     */
    function handleChatStartEvent(
      event: Extract<ChatApiStreamEvent, { type: "start" }>,
      token: number
    ): void {
      const currentState = get()
      const request = getOwnedRequest(token)
      if (request.status !== "awaiting-start") {
        throw new Error("Chat start event did not match an awaiting request")
      }

      const conversation = startAssistantReply({
        conversationMetadata: event.conversation,
        previousConversation: currentState.conversation,
        assistantMessageId: event.assistantMessageId,
        model: CHAT_MODEL,
        timestamp: dependencies.createTimestamp()
      })
      const inputDraft =
        request.submittedComposerDraft !== undefined &&
        currentState.inputDraft === request.submittedComposerDraft
          ? ""
          : currentState.inputDraft

      set({
        conversation,
        inputDraft,
        request: {
          status: "reply-streaming",
          token,
          assistantMessageId: event.assistantMessageId
        }
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
     * @throws If the event arrives before start or after invalidation.
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
     */
    function handleChatStreamEvent(
      event: ChatApiStreamEvent,
      token: number
    ): void {
      if (!isRequestOwned(token)) return

      switch (event.type) {
        case "start":
          handleChatStartEvent(event, token)
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
     * @param payload - Valid chat request sent to the backend.
     * @param request - Awaiting observable state correlated with the transport.
     * @returns A promise that resolves after completion, failure, or invalidation.
     */
    async function readChatStream(
      payload: ChatApiRequestBody,
      request: Extract<ChatRequestState, { status: "awaiting-start" }>
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
     * Submits an explicit starter prompt or the current composer draft.
     *
     * @param explicitPrompt - Optional starter prompt supplied outside composer.
     * @returns A promise that resolves after this request loses or ends ownership.
     */
    async function sendMessage(explicitPrompt?: string): Promise<void> {
      if (get().request.status !== "idle") return

      const promptSource =
        explicitPrompt === undefined ? get().inputDraft : explicitPrompt
      const submittedComposerDraft =
        explicitPrompt === undefined ? promptSource : undefined
      const submittedPrompt = promptSource.trim()
      if (!submittedPrompt) return

      const token = nextRequestToken
      nextRequestToken += 1
      const request = createAwaitingChatRequest(
        token,
        submittedPrompt,
        submittedComposerDraft
      )
      const resource = createChatRequestResource(token)
      const payload = createChatRequestPayload(
        get().conversation?.id,
        submittedPrompt
      )

      activeRequestResource = resource
      set({
        error: undefined,
        request
      })
      await readChatStream(payload, request)
    }

    /** Interrupts the active assistant reply and requests transport abort. */
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

    /** Restores initial chat state and silently aborts any active transport. */
    function resetConversation(): void {
      const resource = activeRequestResource
      activeRequestResource = undefined
      set(INITIAL_CHAT_VIEW_STATE)
      resource?.abortController.abort()
    }

    return {
      ...INITIAL_CHAT_VIEW_STATE,
      setInputDraft,
      sendMessage,
      stopStreaming,
      resetConversation
    }
  }

  return create<ChatViewStore>(createChatViewStoreState)
}

/** Chat-view store used by the desktop React tree. */
export const useChatViewStore: UseBoundStore<StoreApi<ChatViewStore>> =
  createChatViewStore({
    streamChat: readChatEvents,
    createTimestamp: () => new Date().toISOString()
  })
