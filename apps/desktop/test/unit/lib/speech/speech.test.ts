import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from "vitest"
import { BACKEND_HOST, BACKEND_PORT } from "@lys/protocol"
import type { ConversationMessage } from "@lys/share"
import { startSpeech } from "@/lib/speech/speech"
import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"
import { useSpeechActivityStore } from "@/lib/store/speech-activity"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildEndedAssistantMessage,
  buildStreamingAssistantMessage,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** The fake window's state, driven by the test. */
type FakeWindowState = {
  /** What `isFocused` resolves with. */
  focused: Promise<boolean>
  /** Focus listeners, as Tauri calls them. */
  listeners: FocusListener[]
  /** What `onFocusChanged` resolves with. */
  listening: Promise<() => void>
  /** How many times a listener was removed. */
  unlistens: number
}

/** A focus listener, as Tauri calls it. */
type FocusListener = (event: { payload: boolean }) => void

/**
 * Creates the fake window's state for a focused window.
 *
 * @returns The state.
 */
function createFakeWindowState(): FakeWindowState {
  return {
    focused: Promise.resolve(true),
    listeners: [],
    listening: Promise.resolve(() => undefined),
    unlistens: 0
  }
}

/** The fake window the module under test sees. */
const fakeWindow = vi.hoisted(createFakeWindowState)

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: () => fakeWindow.focused,
    onFocusChanged: (listener: FocusListener) => {
      fakeWindow.listeners.push(listener)
      return fakeWindow.listening
    }
  })
}))

/** One WebSocket the module under test opened. */
class FakeWebSocket {
  /** Every socket opened, in order. */
  public static readonly opened: FakeWebSocket[] = []
  /** The URL it was opened with. */
  public readonly url: string
  /** The binary type the module set. */
  public binaryType = "blob"
  /** Whether `close` ran. */
  public isClosed = false
  /** What `close` throws, when the test sets it. */
  public closeFailure: Error | undefined
  /** Its listeners, by event type. */
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>()

  /**
   * Records the socket.
   *
   * @param url - The URL it was opened with.
   */
  public constructor(url: string) {
    this.url = url
    FakeWebSocket.opened.push(this)
  }

  /**
   * Adds a listener.
   *
   * @param type - Event type.
   * @param listener - The listener.
   */
  public addEventListener(type: string, listener: (event: unknown) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  /** Closes the socket from the client side. */
  public close(): void {
    if (this.closeFailure !== undefined) throw this.closeFailure
    this.isClosed = true
  }

  /**
   * Delivers an event to its listeners, as the platform does.
   *
   * @param type - Event type.
   * @param event - The event.
   */
  public sendEvent(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

/** A stand-in for the platform's audio context, which jsdom lacks. */
class FakeAudioContext {
  /** How many sources were started across every context. */
  public static started = 0
  /** Ends of the sources started across every context, in order. */
  public static readonly ends: (() => void)[] = []
  /** The context's state. */
  public readonly state = "running"
  /** The context's clock. */
  public readonly currentTime = 0
  /** Where sources connect. */
  public readonly destination = {}

  /**
   * Creates a buffer that holds nothing.
   *
   * @param _channels - Channel count.
   * @param length - Sample count.
   * @param sampleRate - Samples per second.
   */
  public createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, copyToChannel: () => undefined }
  }

  /** Creates a source that counts its start and can be ended by the test. */
  public createBufferSource() {
    const source = {
      buffer: null,
      onended: null as (() => void) | null,
      connect: () => undefined,
      start: () => {
        FakeAudioContext.started += 1
        FakeAudioContext.ends.push(() => source.onended?.())
      },
      stop: () => undefined
    }
    return source
  }

  /** Resumes nothing. */
  public resume(): Promise<void> {
    return Promise.resolve()
  }

  /** Closes nothing. */
  public close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Identifier of the reply the tests speak. */
const REPLY_ID = createFixtureUuidV7(3)

/** WebSocket base of the backend. */
const SOCKET_BASE = `ws://${BACKEND_HOST}:${BACKEND_PORT}`

/** Path of the reply's sockets. */
const REPLY_PATH = `/api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY_ID}`

/**
 * Shows a conversation with one reply.
 *
 * @param reply - The reply, streaming or ended.
 */
function updateShownConversation(reply: ConversationMessage): void {
  useChatViewStore.setState({
    conversation: createStoredChatViewConversation(
      buildConversation(FIXTURE_CONVERSATION_ID, "Trip", [
        buildUserMessage(2, "Plan a trip"),
        reply
      ])
    )
  })
}

/** Moves the request to `awaiting-turn`, as sending a message does. */
function updateRequestAwaitingTurn(): void {
  useChatViewStore.setState({ request: { status: "awaiting-turn", token: 1 } })
}

/** Moves the request to `reply-streaming` for the reply. */
function updateRequestStreaming(): void {
  useChatViewStore.setState({
    request: {
      status: "reply-streaming",
      token: 1,
      assistantMessageId: REPLY_ID
    }
  })
}

/** Moves the request to `reply-completed` for the reply. */
function updateRequestCompleted(): void {
  useChatViewStore.setState({
    request: {
      status: "reply-completed",
      token: 1,
      assistantMessageId: REPLY_ID
    }
  })
}

/** Returns the request to `idle`, as the store does once the stream ends. */
function resetRequest(): void {
  useChatViewStore.setState({ request: { status: "idle" } })
}

/** The URLs of every socket opened, in order. */
function listOpenedUrls(): string[] {
  return FakeWebSocket.opened.map((socket) => socket.url)
}

/**
 * The socket opened at `index`.
 *
 * @param index - Position in opening order; the last one by default.
 */
function getSocketAt(index = -1): FakeWebSocket {
  const socket = FakeWebSocket.opened.at(index)
  if (socket === undefined) throw new Error("no such socket was opened")
  return socket
}

/** Loses the window's focus, as Tauri reports it. */
function sendWindowBlur(): void {
  for (const listener of fakeWindow.listeners) listener({ payload: false })
}

/**
 * Starts speech for one test, cleaned up when the test ends.
 *
 * @returns The cleanup, which runs once however often it is called.
 */
function startSpeechForTest(): () => void {
  const stop = startSpeech()
  let isStopped = false
  const stopOnce = (): void => {
    if (isStopped) return
    isStopped = true
    stop()
  }
  onTestFinished(stopOnce)
  return stopOnce
}

beforeEach(() => {
  FakeAudioContext.started = 0
  FakeAudioContext.ends.length = 0
  FakeWebSocket.opened.length = 0
  fakeWindow.focused = Promise.resolve(true)
  fakeWindow.listeners.length = 0
  fakeWindow.listening = Promise.resolve(() => {
    fakeWindow.unlistens += 1
  })
  fakeWindow.unlistens = 0
  vi.stubGlobal("WebSocket", FakeWebSocket)
  vi.stubGlobal("AudioContext", FakeAudioContext)
  useLysStore.setState({
    voiceServerInfo: Object.freeze({ status: "running", problem: null })
  })
  useChatViewStore.setState({
    conversation: undefined,
    request: { status: "idle" }
  })
  useSpeechActivityStore.setState({ isTalking: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("startSpeech", () => {
  it("reads a reply the person asked for from its first word", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    expect(listOpenedUrls()).toEqual([
      `${SOCKET_BASE}${REPLY_PATH}/speech?from=start`
    ])
    expect(getSocketAt().binaryType).toBe("arraybuffer")
  })

  it("joins a reply that was already streaming at the sentence being written", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    expect(listOpenedUrls()).toEqual([
      `${SOCKET_BASE}${REPLY_PATH}/speech?from=current`
    ])
  })

  it("stops when the person sends a new message", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    updateRequestAwaitingTurn()
    expect(getSocketAt().isClosed).toBe(true)
  })

  it("stops when the conversation is closed", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    useChatViewStore.setState({ conversation: undefined })
    expect(getSocketAt().isClosed).toBe(true)
  })

  it("stops at once when the reply was interrupted", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    updateShownConversation(
      buildEndedAssistantMessage(3, "Hello", "interrupted")
    )
    updateRequestCompleted()
    expect(getSocketAt().isClosed).toBe(true)
    expect(FakeWebSocket.opened).toHaveLength(1)
  })

  it("says the notification line for a reply that completed in the background", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    sendWindowBlur()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    updateShownConversation(buildCompletedAssistantMessage(3, "Hello."))
    updateRequestCompleted()
    expect(listOpenedUrls()).toEqual([
      `${SOCKET_BASE}${REPLY_PATH}/notification`
    ])
  })

  it("keeps reading a completed reply after the request returns to idle", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    getSocketAt().sendEvent("message", { data: new ArrayBuffer(4) })
    updateShownConversation(buildCompletedAssistantMessage(3, "Hello."))
    updateRequestCompleted()
    resetRequest()
    expect(getSocketAt().isClosed).toBe(false)
    expect(FakeWebSocket.opened).toHaveLength(1)
  })

  it("keeps the notification line after the request returns to idle", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    sendWindowBlur()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    updateShownConversation(buildCompletedAssistantMessage(3, "Hello."))
    updateRequestCompleted()
    resetRequest()
    expect(listOpenedUrls()).toEqual([
      `${SOCKET_BASE}${REPLY_PATH}/notification`
    ])
    expect(getSocketAt().isClosed).toBe(false)
  })

  it("stops a completed reply's speech once another conversation is shown", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    updateShownConversation(buildCompletedAssistantMessage(3, "Hello."))
    updateRequestCompleted()
    resetRequest()
    useChatViewStore.setState({
      conversation: createStoredChatViewConversation(
        buildConversation(createFixtureUuidV7(9), "Other", [
          buildUserMessage(10, "Hi"),
          buildCompletedAssistantMessage(11, "Hi there.")
        ])
      )
    })
    expect(getSocketAt().isClosed).toBe(true)
    expect(FakeWebSocket.opened).toHaveLength(1)
  })

  it("forwards binary frames and asks for voice's status after a 4503 close", async () => {
    const host = startNativeHostFake({
      get_voice_status: () => ({ status: "stopped" })
    })
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    getSocketAt().sendEvent("message", { data: "text" })
    getSocketAt().sendEvent("message", { data: new ArrayBuffer(4) })
    expect(FakeAudioContext.started).toBe(1)
    getSocketAt().sendEvent("close", { code: 4503 })
    await vi.waitFor(() =>
      expect(useLysStore.getState().voiceServerInfo.status).toBe("stopped")
    )
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "get_voice_status"
    ])
  })

  it("closes the socket and stops following once cleaned up", async () => {
    const stop = startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    stop()
    expect(getSocketAt().isClosed).toBe(true)
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    expect(FakeWebSocket.opened).toHaveLength(1)
    expect(fakeWindow.unlistens).toBe(1)
  })

  it("removes the focus listener that registers after the cleanup", async () => {
    const listening = createControlledPromise<() => void>()
    fakeWindow.listening = listening.promise
    const stop = startSpeechForTest()
    stop()
    listening.resolve(() => {
      fakeWindow.unlistens += 1
    })
    await waitForMicrotasks()
    expect(fakeWindow.unlistens).toBe(1)
  })

  it("keeps the focused default when the window cannot report its focus", async () => {
    fakeWindow.focused = Promise.reject(new Error("no window"))
    fakeWindow.listening = Promise.reject(new Error("no focus events"))
    startSpeechForTest()
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    expect(listOpenedUrls()).toEqual([
      `${SOCKET_BASE}${REPLY_PATH}/speech?from=start`
    ])
  })

  it("reports a failure of the speech update that the focus read runs", async () => {
    const focused = createControlledPromise<boolean>()
    fakeWindow.focused = focused.promise
    const reportError = vi.fn()
    vi.stubGlobal("reportError", reportError)
    startSpeechForTest()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestAwaitingTurn()
    updateRequestStreaming()
    const failure = new Error("close failed")
    getSocketAt().closeFailure = failure
    focused.resolve(false)
    await waitForMicrotasks()
    expect(reportError).toHaveBeenCalledWith(failure)
  })

  it("reports a failure to remove the focus listener that registers after the cleanup", async () => {
    const listening = createControlledPromise<() => void>()
    fakeWindow.listening = listening.promise
    const reportError = vi.fn()
    vi.stubGlobal("reportError", reportError)
    const stop = startSpeechForTest()
    stop()
    const failure = new Error("unlisten failed")
    listening.resolve(() => {
      throw failure
    })
    await waitForMicrotasks()
    expect(reportError).toHaveBeenCalledWith(failure)
  })

  it("ignores a focus read that arrives after the cleanup", async () => {
    const focused = createControlledPromise<boolean>()
    fakeWindow.focused = focused.promise
    const stop = startSpeechForTest()
    stop()
    focused.resolve(true)
    await waitForMicrotasks()
    updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
    updateRequestStreaming()
    expect(FakeWebSocket.opened).toHaveLength(0)
  })
})

/** Starts a reply the person asked for, which opens its speech socket. */
function startSpokenReply(): void {
  updateShownConversation(buildStreamingAssistantMessage(3, "Hello"))
  updateRequestAwaitingTurn()
  updateRequestStreaming()
}

describe("startSpeech speech activity", () => {
  it("says that Lys is talking while a speech socket is open", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    expect(useSpeechActivityStore.getState().isTalking).toBe(false)
    startSpokenReply()
    expect(useSpeechActivityStore.getState().isTalking).toBe(true)
    getSocketAt().sendEvent("close", { code: 1011 })

    expect(useSpeechActivityStore.getState().isTalking).toBe(false)
  })

  it("says that Lys is talking until the audio of a closed socket has played", async () => {
    startSpeechForTest()
    await waitForMicrotasks()
    startSpokenReply()
    getSocketAt().sendEvent("message", { data: new ArrayBuffer(4) })
    updateShownConversation(buildCompletedAssistantMessage(3, "Hello"))
    updateRequestCompleted()
    getSocketAt().sendEvent("close", { code: 1000 })
    expect(useSpeechActivityStore.getState().isTalking).toBe(true)
    FakeAudioContext.ends[0]?.()

    expect(useSpeechActivityStore.getState().isTalking).toBe(false)
  })

  it("says that Lys is silent once cleaned up, whatever closes afterwards", async () => {
    const stop = startSpeechForTest()
    await waitForMicrotasks()
    startSpokenReply()
    const socket = getSocketAt()
    stop()
    expect(useSpeechActivityStore.getState().isTalking).toBe(false)
    useSpeechActivityStore.setState({ isTalking: true })
    socket.sendEvent("close", { code: 1005 })

    expect(useSpeechActivityStore.getState().isTalking).toBe(true)
  })
})
