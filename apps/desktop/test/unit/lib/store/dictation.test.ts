import { describe, expect, it, onTestFinished, vi } from "vitest"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildConversation,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import {
  FakeWebSocket,
  getDictationSocket,
  listReleasedMicrophones,
  listSentStops,
  startDictationPlatformFake,
  type DictationPlatformFake
} from "../../support/dictationPlatformFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForMicrotasks } from "../../support/settlement"

/**
 * Loads fresh stores for one case, with voice running, and has the case's
 * dictation cancelled when the case ends.
 *
 * @returns The stores a dictation reads, and the registration of its rules.
 */
async function loadFreshDictationStores() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { registerDictationRules, useDictationStore } =
    await import("@/lib/store/dictation")
  const { useSpeechActivityStore } = await import("@/lib/store/speech-activity")
  useLysStore.setState({
    voiceServerInfo: Object.freeze({ status: "running", problem: null })
  })
  onTestFinished(() => {
    useDictationStore.getState().cancelDictation()
  })
  return {
    useLysStore,
    useChatViewStore,
    useDictationStore,
    useSpeechActivityStore,
    registerDictationRules
  }
}

/** The fresh stores of one case. */
type DictationStores = Awaited<ReturnType<typeof loadFreshDictationStores>>

/** Changes a case's stores into the situation the case names. */
type StoreUpdate = (stores: DictationStores) => void

/**
 * Shows a stored conversation in the chat view.
 *
 * @param stores - The case's stores.
 * @param conversationId - The conversation's identity.
 */
function updateShownConversation(
  stores: DictationStores,
  conversationId: string
): void {
  stores.useChatViewStore.setState({
    conversation: createStoredChatViewConversation(
      buildConversation(conversationId, "Trip", [])
    )
  })
}

/**
 * Starts a dictation at the draft's end and opens its microphone.
 *
 * @param stores - The case's stores.
 * @returns Settlement once the dictation listens.
 */
async function startListening(stores: DictationStores): Promise<void> {
  const draft = stores.useChatViewStore.getState().inputDraft
  stores.useDictationStore.getState().handleDictationPress(draft.length)
  await waitForMicrotasks()
  expect(stores.useDictationStore.getState().status).toBe("listening")
}

/**
 * Sends one partial text from the fake backend on the last socket.
 *
 * @param platform - The case's platform.
 * @param text - Everything dictated so far.
 */
function sendPartial(platform: DictationPlatformFake, text: string): void {
  getDictationSocket(platform).sendJson({ type: "partial", text })
}

/**
 * Registers the rules for one test, unregistered when the test ends.
 *
 * @param stores - The case's stores.
 */
function registerRulesForTest(stores: DictationStores): void {
  onTestFinished(stores.registerDictationRules())
}

describe("useDictationStore", () => {
  it("opens the backend's dictation socket and writes the text into the chat view's draft", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    stores.useChatViewStore.setState({ inputDraft: "Note:" })
    await startListening(stores)
    sendPartial(platform, "buy milk")

    expect(platform.sockets.map((socket) => socket.url)).toEqual([
      `ws://${BACKEND_HOST}:${BACKEND_PORT}/api/v1/voice/dictation`
    ])
    expect(stores.useChatViewStore.getState().inputDraft).toBe("Note: buy milk")
    expect(stores.useDictationStore.getState().status).toBe("listening")
  })

  it.each<[string, StoreUpdate]>([
    [
      "voice does not run",
      (stores) =>
        stores.useLysStore.setState({
          voiceServerInfo: Object.freeze({ status: "stopped", problem: null })
        })
    ],
    [
      "Lys waits for a turn",
      (stores) =>
        stores.useChatViewStore.setState({
          request: { status: "awaiting-turn", token: 1 }
        })
    ],
    [
      "Lys answers",
      (stores) =>
        stores.useChatViewStore.setState({
          request: {
            status: "reply-streaming",
            token: 1,
            assistantMessageId: createFixtureUuidV7(3)
          }
        })
    ],
    [
      "Lys talks",
      (stores) => stores.useSpeechActivityStore.setState({ isTalking: true })
    ],
    [
      "the settings view is shown",
      (stores) => stores.useLysStore.setState({ activeView: "settings" })
    ]
  ])("starts nothing while %s", async (_situation, update) => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    update(stores)
    stores.useDictationStore.getState().handleDictationPress(0)

    expect(platform.sockets).toEqual([])
    expect(platform.microphoneRequests).toEqual([])
    expect(stores.useDictationStore.getState().status).toBe("idle")
  })

  it("stops the running dictation on a press while Lys may no longer listen", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    await startListening(stores)
    getDictationSocket(platform).open()
    stores.useSpeechActivityStore.setState({ isTalking: true })
    stores.useDictationStore.getState().handleDictationPress(0)

    expect(listSentStops(platform)).toHaveLength(1)
    expect(stores.useDictationStore.getState().status).toBe("stopping")
  })

  it.each([
    [
      4503,
      "voice-not-ready",
      { reads: ["get_voice_status"], shown: "stopped" }
    ],
    [1011, "voice-stopped", { reads: ["get_voice_status"], shown: "stopped" }],
    [1006, "stopped", { reads: [], shown: "running" }],
    [4409, "stopped", { reads: [], shown: "running" }]
  ] as const)(
    "reads voice's status again only when the socket closes because voice was not ready or failed (%i)",
    async (code, notice, voice) => {
      const host = startNativeHostFake({
        get_voice_status: () => ({ status: "stopped" })
      })
      const platform = startDictationPlatformFake()
      const stores = await loadFreshDictationStores()
      await startListening(stores)
      getDictationSocket(platform).closeFromBackend(code)
      await waitForMicrotasks()

      expect(stores.useDictationStore.getState().notice).toBe(notice)
      expect(host.commands.map((invoked) => invoked.command)).toEqual(
        voice.reads
      )
      expect(stores.useLysStore.getState().voiceServerInfo.status).toBe(
        voice.shown
      )
    }
  )

  it("keeps the next dictation when the socket of a cancelled one reports its close late", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    await startListening(stores)
    const cancelled = getDictationSocket(platform)
    cancelled.open()
    stores.useDictationStore.getState().cancelDictation()
    await startListening(stores)
    sendPartial(platform, "second")
    await vi.waitFor(() => {
      expect(cancelled.readyState).toBe(FakeWebSocket.CLOSED)
    })

    expect(getDictationSocket(platform)).not.toBe(cancelled)
    expect(stores.useDictationStore.getState()).toMatchObject({
      status: "listening",
      notice: undefined
    })
    expect(stores.useChatViewStore.getState().inputDraft).toBe("second")
  })

  it("listens after a reply completed while its stream stays open for a title", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    stores.useChatViewStore.setState({
      request: {
        status: "reply-completed",
        token: 1,
        assistantMessageId: createFixtureUuidV7(3)
      }
    })
    await startListening(stores)

    expect(platform.microphoneRequests).toHaveLength(1)
  })
})

describe("registerDictationRules", () => {
  it.each<[string, StoreUpdate]>([
    [
      "Lys starts answering",
      (stores) =>
        stores.useChatViewStore.setState({
          request: { status: "awaiting-turn", token: 1 }
        })
    ],
    [
      "voice stops running",
      (stores) =>
        stores.useLysStore.setState({
          voiceServerInfo: Object.freeze({ status: "stopping", problem: null })
        })
    ],
    [
      "Lys starts talking",
      (stores) => stores.useSpeechActivityStore.setState({ isTalking: true })
    ],
    [
      "the settings view is shown instead of the chat view",
      (stores) => stores.useLysStore.setState({ activeView: "settings" })
    ]
  ])(
    "stops the dictation as a press does when %s",
    async (_situation, update) => {
      const platform = startDictationPlatformFake()
      const stores = await loadFreshDictationStores()
      registerRulesForTest(stores)
      await startListening(stores)
      getDictationSocket(platform).open()
      update(stores)

      expect(listReleasedMicrophones(platform)).toHaveLength(1)
      expect(listSentStops(platform)).toHaveLength(1)
      expect(getDictationSocket(platform).isClosed).toBe(false)
      expect(stores.useDictationStore.getState().status).toBe("stopping")
    }
  )

  it.each<[string, StoreUpdate]>([
    [
      "another conversation is shown",
      (stores) => updateShownConversation(stores, FIXTURE_CONVERSATION_ID)
    ],
    [
      "a conversation starts to open",
      (stores) =>
        stores.useChatViewStore.setState({
          conversationOpen: {
            status: "opening",
            conversationId: FIXTURE_CONVERSATION_ID,
            replacedComposerDraft: ""
          }
        })
    ],
    [
      "something else changes the draft",
      (stores) =>
        stores.useChatViewStore.getState().setInputDraft("typed elsewhere")
    ]
  ])(
    "cancels the dictation, sending no stop, when %s",
    async (_situation, update) => {
      const platform = startDictationPlatformFake()
      const stores = await loadFreshDictationStores()
      registerRulesForTest(stores)
      await startListening(stores)
      getDictationSocket(platform).open()
      sendPartial(platform, "so far")
      update(stores)
      sendPartial(platform, "late words")

      expect(listReleasedMicrophones(platform)).toHaveLength(1)
      expect(listSentStops(platform)).toHaveLength(0)
      expect(getDictationSocket(platform).isClosed).toBe(true)
      expect(stores.useDictationStore.getState().status).toBe("idle")
      expect(stores.useChatViewStore.getState().inputDraft).not.toContain(
        "late"
      )
    }
  )

  it("keeps listening while the shown conversation's messages change", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    registerRulesForTest(stores)
    updateShownConversation(stores, FIXTURE_CONVERSATION_ID)
    await startListening(stores)
    updateShownConversation(stores, FIXTURE_CONVERSATION_ID)
    sendPartial(platform, "still here")

    expect(stores.useDictationStore.getState().status).toBe("listening")
    expect(stores.useChatViewStore.getState().inputDraft).toBe("still here")
  })

  it("keeps a failure's notice until another conversation is shown", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    registerRulesForTest(stores)
    await startListening(stores)
    getDictationSocket(platform).closeFromBackend(1011)
    expect(stores.useDictationStore.getState().notice).toBe("voice-stopped")
    updateShownConversation(stores, FIXTURE_CONVERSATION_ID)

    expect(stores.useDictationStore.getState().notice).toBeUndefined()
  })

  it("cancels the dictation and stops following the stores once it is unregistered", async () => {
    const platform = startDictationPlatformFake()
    const stores = await loadFreshDictationStores()
    const unregister = stores.registerDictationRules()
    await startListening(stores)
    unregister()
    expect(listReleasedMicrophones(platform)).toHaveLength(1)
    expect(stores.useDictationStore.getState().status).toBe("idle")
    await startListening(stores)
    stores.useSpeechActivityStore.setState({ isTalking: true })
    updateShownConversation(stores, FIXTURE_CONVERSATION_ID)

    expect(stores.useDictationStore.getState().status).toBe("listening")
  })
})
