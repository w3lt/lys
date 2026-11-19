import { beforeEach, describe, expect, it, onTestFinished } from "vitest"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  registerDictationRules,
  useDictationStore
} from "@/lib/store/dictation"
import { useSpeechActivityStore } from "@/lib/store/speech-activity"
import {
  buildConversation,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import {
  countReleasedMicrophones,
  countSentStops,
  getDictationSocket,
  startDictationPlatformFake,
  type DictationPlatformFake
} from "../../support/dictationPlatformFake"
import { waitForMicrotasks } from "../../support/settlement"

/**
 * Shows a stored conversation in the chat view.
 *
 * @param conversationId - The conversation's identity.
 */
function updateShownConversation(conversationId: string): void {
  useChatViewStore.setState({
    conversation: createStoredChatViewConversation(
      buildConversation(conversationId, "Trip", [])
    )
  })
}

/**
 * Starts a dictation at the draft's end and opens its microphone.
 *
 * @returns Settlement once the dictation listens.
 */
async function startListening(): Promise<void> {
  const draft = useChatViewStore.getState().inputDraft
  useDictationStore.getState().toggleDictation(draft.length)
  await waitForMicrotasks()
  expect(useDictationStore.getState().status).toBe("listening")
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

beforeEach(() => {
  useDictationStore.getState().cancelDictation()
  useLysStore.setState({
    voiceServerInfo: Object.freeze({ status: "running", problem: null })
  })
  useSpeechActivityStore.setState({ isTalking: false })
  useChatViewStore.setState({
    conversation: undefined,
    conversationOpen: { status: "idle" },
    inputDraft: "",
    request: { status: "idle" }
  })
})

/** Registers the rules for one test, unregistered when the test ends. */
function registerRulesForTest(): void {
  onTestFinished(registerDictationRules())
}

describe("useDictationStore", () => {
  it("opens the backend's dictation socket and writes the text into the chat view's draft", async () => {
    const platform = startDictationPlatformFake()
    useChatViewStore.setState({ inputDraft: "Note:" })
    await startListening()
    sendPartial(platform, "buy milk")

    expect(platform.sockets.map((socket) => socket.url)).toEqual([
      `ws://${BACKEND_HOST}:${BACKEND_PORT}/api/v1/voice/dictation`
    ])
    expect(useChatViewStore.getState().inputDraft).toBe("Note: buy milk")
    expect(useDictationStore.getState().status).toBe("listening")
  })

  it.each([
    [
      "voice does not run",
      () =>
        useLysStore.setState({
          voiceServerInfo: Object.freeze({ status: "stopped", problem: null })
        })
    ],
    [
      "Lys waits for a turn",
      () =>
        useChatViewStore.setState({
          request: { status: "awaiting-turn", token: 1 }
        })
    ],
    [
      "Lys answers",
      () =>
        useChatViewStore.setState({
          request: {
            status: "reply-streaming",
            token: 1,
            assistantMessageId: createFixtureUuidV7(3)
          }
        })
    ],
    ["Lys talks", () => useSpeechActivityStore.setState({ isTalking: true })]
  ])("starts nothing while %s", (_situation, update) => {
    const platform = startDictationPlatformFake()
    update()
    useDictationStore.getState().toggleDictation(0)

    expect(platform.sockets).toEqual([])
    expect(platform.microphoneRequests).toEqual([])
    expect(useDictationStore.getState().status).toBe("idle")
  })

  it("listens after a reply completed while its stream stays open for a title", async () => {
    const platform = startDictationPlatformFake()
    useChatViewStore.setState({
      request: {
        status: "reply-completed",
        token: 1,
        assistantMessageId: createFixtureUuidV7(3)
      }
    })
    await startListening()

    expect(platform.microphoneRequests).toHaveLength(1)
  })
})

describe("registerDictationRules", () => {
  it.each([
    [
      "Lys starts answering",
      () =>
        useChatViewStore.setState({
          request: { status: "awaiting-turn", token: 1 }
        })
    ],
    [
      "voice stops running",
      () =>
        useLysStore.setState({
          voiceServerInfo: Object.freeze({ status: "stopping", problem: null })
        })
    ],
    [
      "Lys starts talking",
      () => useSpeechActivityStore.setState({ isTalking: true })
    ]
  ])(
    "stops the dictation as a press does when %s",
    async (_situation, update) => {
      const platform = startDictationPlatformFake()
      registerRulesForTest()
      await startListening()
      getDictationSocket(platform).open()
      update()

      expect(countReleasedMicrophones(platform)).toBe(1)
      expect(countSentStops(platform)).toBe(1)
      expect(getDictationSocket(platform).isClosed).toBe(false)
      expect(useDictationStore.getState().status).toBe("stopping")
    }
  )

  it.each([
    [
      "another conversation is shown",
      () => updateShownConversation(FIXTURE_CONVERSATION_ID)
    ],
    [
      "a conversation starts to open",
      () =>
        useChatViewStore.setState({
          conversationOpen: {
            status: "opening",
            conversationId: FIXTURE_CONVERSATION_ID,
            replacedComposerDraft: ""
          }
        })
    ],
    [
      "something else changes the draft",
      () => useChatViewStore.getState().setInputDraft("typed elsewhere")
    ]
  ])(
    "cancels the dictation, sending no stop, when %s",
    async (_situation, update) => {
      const platform = startDictationPlatformFake()
      registerRulesForTest()
      await startListening()
      getDictationSocket(platform).open()
      sendPartial(platform, "so far")
      update()
      sendPartial(platform, "late words")

      expect(countReleasedMicrophones(platform)).toBe(1)
      expect(countSentStops(platform)).toBe(0)
      expect(getDictationSocket(platform).isClosed).toBe(true)
      expect(useDictationStore.getState().status).toBe("idle")
      expect(useChatViewStore.getState().inputDraft).not.toContain("late")
    }
  )

  it("keeps listening while the shown conversation's messages change", async () => {
    const platform = startDictationPlatformFake()
    registerRulesForTest()
    updateShownConversation(FIXTURE_CONVERSATION_ID)
    await startListening()
    updateShownConversation(FIXTURE_CONVERSATION_ID)
    sendPartial(platform, "still here")

    expect(useDictationStore.getState().status).toBe("listening")
    expect(useChatViewStore.getState().inputDraft).toBe("still here")
  })

  it("keeps a failure's notice until another conversation is shown", async () => {
    const platform = startDictationPlatformFake()
    registerRulesForTest()
    await startListening()
    getDictationSocket(platform).closeFromBackend(1011)
    expect(useDictationStore.getState().notice).toBe("voice-stopped")
    updateShownConversation(FIXTURE_CONVERSATION_ID)

    expect(useDictationStore.getState().notice).toBeUndefined()
  })

  it("cancels the dictation and stops following the stores once it is unregistered", async () => {
    const platform = startDictationPlatformFake()
    const unregister = registerDictationRules()
    await startListening()
    unregister()
    expect(countReleasedMicrophones(platform)).toBe(1)
    expect(useDictationStore.getState().status).toBe("idle")
    await startListening()
    useSpeechActivityStore.setState({ isTalking: true })
    updateShownConversation(FIXTURE_CONVERSATION_ID)

    expect(useDictationStore.getState().status).toBe("listening")
  })
})
