import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import type { DictationSocketHandlers } from "@/lib/dictation/dictation-controller"
import type { MicrophoneRecorder } from "@/lib/dictation/microphone-recorder"
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
import { waitForMicrotasks } from "../../support/settlement"

/** What the fake platform recorded of the dictations the store ran. */
type FakePlatform = {
  /** URLs of the sockets opened, in order. */
  readonly urls: string[]
  /** Handlers of the sockets opened, to play the backend. */
  readonly handlers: DictationSocketHandlers[]
  /** How many times `stop` was sent on any socket. */
  stops: number
  /** How many sockets were closed. */
  closes: number
  /** How many recordings were started. */
  recordings: number
  /** How many recordings were stopped. */
  recordingStops: number
}

/**
 * Creates the fake platform's record, with nothing recorded.
 *
 * @returns The record.
 */
function createFakePlatform(): FakePlatform {
  return {
    urls: [],
    handlers: [],
    stops: 0,
    closes: 0,
    recordings: 0,
    recordingStops: 0
  }
}

/** The fake platform the module under test sees. */
const platform = vi.hoisted(createFakePlatform)

vi.mock("@/lib/dictation/dictation-socket", () => ({
  openDictationSocket: (url: string, handlers: DictationSocketHandlers) => {
    platform.urls.push(url)
    platform.handlers.push(handlers)
    return {
      sendAudio: () => undefined,
      sendStop: () => {
        platform.stops += 1
      },
      close: () => {
        platform.closes += 1
      }
    }
  }
}))

vi.mock("@/lib/dictation/microphone-recorder", () => ({
  startMicrophoneRecorder: (): Promise<MicrophoneRecorder> => {
    platform.recordings += 1
    return Promise.resolve({
      stop: () => {
        platform.recordingStops += 1
      }
    })
  }
}))

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
 * @param text - Everything dictated so far.
 */
function sendPartial(text: string): void {
  platform.handlers.at(-1)?.onText(JSON.stringify({ type: "partial", text }))
}

beforeEach(() => {
  useDictationStore.getState().cancelDictation()
  Object.assign(platform, {
    stops: 0,
    closes: 0,
    recordings: 0,
    recordingStops: 0
  })
  platform.urls.length = 0
  platform.handlers.length = 0
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
    useChatViewStore.setState({ inputDraft: "Note:" })
    await startListening()
    sendPartial("buy milk")

    expect(platform.urls).toEqual([
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
    update()
    useDictationStore.getState().toggleDictation(0)

    expect(platform.urls).toEqual([])
    expect(platform.recordings).toBe(0)
    expect(useDictationStore.getState().status).toBe("idle")
  })

  it("listens after a reply completed while its stream stays open for a title", async () => {
    useChatViewStore.setState({
      request: {
        status: "reply-completed",
        token: 1,
        assistantMessageId: createFixtureUuidV7(3)
      }
    })
    await startListening()

    expect(platform.recordings).toBe(1)
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
      registerRulesForTest()
      await startListening()
      update()

      expect(platform.recordingStops).toBe(1)
      expect(platform.stops).toBe(1)
      expect(platform.closes).toBe(0)
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
      registerRulesForTest()
      await startListening()
      sendPartial("so far")
      update()
      sendPartial("late words")

      expect(platform.recordingStops).toBe(1)
      expect(platform.stops).toBe(0)
      expect(platform.closes).toBe(1)
      expect(useDictationStore.getState().status).toBe("idle")
      expect(useChatViewStore.getState().inputDraft).not.toContain("late")
    }
  )

  it("keeps listening while the shown conversation's messages change", async () => {
    registerRulesForTest()
    updateShownConversation(FIXTURE_CONVERSATION_ID)
    await startListening()
    updateShownConversation(FIXTURE_CONVERSATION_ID)
    sendPartial("still here")

    expect(useDictationStore.getState().status).toBe("listening")
    expect(useChatViewStore.getState().inputDraft).toBe("still here")
  })

  it("keeps a failure's notice until another conversation is shown", async () => {
    registerRulesForTest()
    await startListening()
    platform.handlers.at(-1)?.onClose(1011)
    expect(useDictationStore.getState().notice).toBe("voice-stopped")
    updateShownConversation(FIXTURE_CONVERSATION_ID)

    expect(useDictationStore.getState().notice).toBeUndefined()
  })

  it("cancels the dictation and stops following the stores once it is unregistered", async () => {
    const unregister = registerDictationRules()
    await startListening()
    unregister()
    expect(platform.recordingStops).toBe(1)
    expect(useDictationStore.getState().status).toBe("idle")
    await startListening()
    useSpeechActivityStore.setState({ isTalking: true })
    updateShownConversation(FIXTURE_CONVERSATION_ID)

    expect(useDictationStore.getState().status).toBe("listening")
  })
})
