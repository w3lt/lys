import type { ChatApiRequestBody, ChatApiStreamEvent } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"

import type { ChatApiOptions } from "@/lib/apis/http/chat"
import type { GetConversationResult } from "@/lib/apis/http/conversations"
import { createChatViewStore } from "@/lib/store/chat-view"

import {
  buildAssistantMessage,
  buildStoredConversation,
  buildUserMessage,
  createDeferred,
  type Deferred,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMP
} from "../../fixtures/conversations"

/** One stored-conversation read observed by the fake transport. */
type ConversationRead = {
  /** Conversation the store asked for. */
  readonly conversationId: string
  /** Signal the store supplied. */
  readonly signal: AbortSignal
  /** Settlement controlled by the test. */
  readonly result: Deferred<GetConversationResult>
}

/**
 * Streams a new-conversation turn start, then waits until aborted.
 *
 * @param _payload - Request payload; unused by this fake.
 * @param options - Transport options carrying the store's abort signal.
 * @returns A stream that yields one start event and rejects on abort.
 */
async function* streamStartedTurn(
  _payload: ChatApiRequestBody,
  options?: ChatApiOptions
): AsyncGenerator<ChatApiStreamEvent, void, unknown> {
  yield {
    type: "start-new-conversation-turn",
    conversation: {
      id: FIXTURE_IDS.thirdConversation,
      title: null,
      systemPrompt: "You are Lys.",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP
    },
    userMessage: buildUserMessage(FIXTURE_IDS.laterUserMessage, "Hi"),
    assistantMessage: buildAssistantMessage({
      id: FIXTURE_IDS.assistantMessage,
      content: "",
      status: "streaming",
      finishReason: null
    })
  }
  await new Promise<never>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError"))
    )
  })
}

/**
 * Creates a chat-view store whose conversation reads are settled by the test.
 *
 * @returns The store, observed reads, and the chat stream fake.
 */
function createHarness() {
  const conversationReads: ConversationRead[] = []
  const streamChat = vi.fn(streamStartedTurn)
  const store = createChatViewStore({
    streamChat,
    getConversation: (conversationId, signal) => {
      const result = createDeferred<GetConversationResult>()
      conversationReads.push({ conversationId, signal, result })
      return result.promise
    },
    createTimestamp: () => FIXTURE_TIMESTAMP,
    readGenerationOptions: () => ({ temperature: 0.7 })
  })

  return { store, conversationReads, streamChat }
}

/** Stored conversation whose final reply was never finalized. */
const STORED_CONVERSATION = buildStoredConversation(
  FIXTURE_IDS.firstConversation,
  [
    buildUserMessage(FIXTURE_IDS.userMessage, "Hello"),
    buildAssistantMessage({
      id: FIXTURE_IDS.assistantMessage,
      content: "Partial reply",
      status: "streaming",
      finishReason: null
    })
  ]
)

describe("openConversation", () => {
  it("replaces the conversation once read, clears the draft, and stops orphaned replies", async () => {
    const harness = createHarness()
    harness.store.getState().setInputDraft("unsent")

    const opening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)

    expect(harness.store.getState().conversationOpen).toEqual({
      status: "opening",
      conversationId: FIXTURE_IDS.firstConversation
    })
    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: STORED_CONVERSATION
    })
    await opening

    const state = harness.store.getState()
    expect(state.conversationOpen).toEqual({ status: "idle" })
    expect(state.inputDraft).toBe("")
    expect(state.conversation?.id).toBe(FIXTURE_IDS.firstConversation)
    expect(state.conversation?.messages.map((message) => message.id)).toEqual([
      FIXTURE_IDS.userMessage,
      FIXTURE_IDS.assistantMessage
    ])
    expect(state.conversation?.messages[1]).toMatchObject({
      content: "Partial reply",
      status: "interrupted",
      finishReason: null
    })
    expect(Object.isFrozen(state.conversation?.messages)).toBe(true)
  })

  it("lets only the newest open commit and aborts the superseded read", async () => {
    const harness = createHarness()
    const firstOpening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)
    const secondOpening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.secondConversation)

    expect(harness.conversationReads[0].signal.aborted).toBe(true)
    harness.conversationReads[1].result.resolve({
      status: "found",
      conversation: buildStoredConversation(FIXTURE_IDS.secondConversation, [])
    })
    await secondOpening
    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: STORED_CONVERSATION
    })
    await firstOpening

    expect(harness.store.getState().conversation?.id).toBe(
      FIXTURE_IDS.secondConversation
    )
  })

  it("does not read again for the conversation already shown", async () => {
    const harness = createHarness()
    const opening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)
    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: STORED_CONVERSATION
    })
    await opening

    await harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)

    expect(harness.conversationReads).toHaveLength(1)
  })

  it.each<[string, GetConversationResult | Error, string]>([
    ["missing", { status: "not-found" }, "That conversation no longer exists."],
    [
      "failed",
      new Error("The backend could not be reached."),
      "The conversation could not be opened: The backend could not be reached."
    ]
  ])(
    "keeps the shown conversation and reports a %s read",
    async (_label, outcome, expectedError) => {
      const harness = createHarness()
      const firstOpening = harness.store
        .getState()
        .openConversation(FIXTURE_IDS.firstConversation)
      harness.conversationReads[0].result.resolve({
        status: "found",
        conversation: STORED_CONVERSATION
      })
      await firstOpening

      const secondOpening = harness.store
        .getState()
        .openConversation(FIXTURE_IDS.secondConversation)
      if (outcome instanceof Error) {
        harness.conversationReads[1].result.reject(outcome)
      } else {
        harness.conversationReads[1].result.resolve(outcome)
      }
      await secondOpening

      const state = harness.store.getState()
      expect(state.conversation?.id).toBe(FIXTURE_IDS.firstConversation)
      expect(state.error).toBe(expectedError)
      expect(state.conversationOpen).toEqual({ status: "idle" })
    }
  )

  it("reports a stored reply that breaks its status pairing", async () => {
    const harness = createHarness()
    const opening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)

    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: buildStoredConversation(FIXTURE_IDS.firstConversation, [
        buildAssistantMessage({
          id: FIXTURE_IDS.assistantMessage,
          content: "Done",
          status: "completed",
          finishReason: null
        })
      ])
    })
    await opening

    const state = harness.store.getState()
    expect(state.conversation).toBeUndefined()
    expect(state.error).toMatch(/^The conversation could not be opened: /)
    expect(state.conversationOpen).toEqual({ status: "idle" })
  })

  it("ignores a send while a conversation is opening", async () => {
    const harness = createHarness()
    void harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)

    await harness.store.getState().sendMessage("Hello")

    expect(harness.streamChat).not.toHaveBeenCalled()
  })

  it("interrupts a streaming reply and aborts its transport before reading", async () => {
    const harness = createHarness()
    const sending = harness.store.getState().sendMessage("Hi")
    await vi.waitFor(() =>
      expect(harness.store.getState().request.status).toBe("reply-streaming")
    )
    const streamSignal = harness.streamChat.mock.calls[0][1]?.signal

    void harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)
    await sending

    const state = harness.store.getState()
    expect(streamSignal?.aborted).toBe(true)
    expect(state.request).toEqual({ status: "idle" })
    expect(state.conversation?.messages.at(-1)).toMatchObject({
      status: "interrupted"
    })
  })
})

describe("resetting and closing during an open", () => {
  it("abandons the read on reset and ignores its late result", async () => {
    const harness = createHarness()
    const opening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)

    harness.store.getState().resetConversation()
    expect(harness.conversationReads[0].signal.aborted).toBe(true)
    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: STORED_CONVERSATION
    })
    await opening

    const state = harness.store.getState()
    expect(state.conversation).toBeUndefined()
    expect(state.conversationOpen).toEqual({ status: "idle" })
  })

  it("closes only the conversation the view presents", async () => {
    const harness = createHarness()
    const opening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)
    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: STORED_CONVERSATION
    })
    await opening

    harness.store.getState().closeConversation(FIXTURE_IDS.secondConversation)
    expect(harness.store.getState().conversation?.id).toBe(
      FIXTURE_IDS.firstConversation
    )

    harness.store.getState().closeConversation(FIXTURE_IDS.firstConversation)
    expect(harness.store.getState().conversation).toBeUndefined()
  })

  it("leaves a shown conversation alone while another one is opening to replace it", async () => {
    const harness = createHarness()
    const firstOpening = harness.store
      .getState()
      .openConversation(FIXTURE_IDS.firstConversation)
    harness.conversationReads[0].result.resolve({
      status: "found",
      conversation: STORED_CONVERSATION
    })
    await firstOpening
    void harness.store
      .getState()
      .openConversation(FIXTURE_IDS.secondConversation)

    harness.store.getState().closeConversation(FIXTURE_IDS.firstConversation)

    expect(harness.store.getState().conversationOpen).toEqual({
      status: "opening",
      conversationId: FIXTURE_IDS.secondConversation
    })
    expect(harness.conversationReads[1].signal.aborted).toBe(false)
  })
})
