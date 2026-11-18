import type { FastifyInstance } from "fastify"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  chatNotificationApi,
  chatSpeechApi,
  SPEECH_CLOSE_COMPLETE,
  SPEECH_CLOSE_FAILED,
  SPEECH_CLOSE_NO_SUCH_REPLY,
  SPEECH_CLOSE_REPLY_ENDED,
  SPEECH_CLOSE_SHUTDOWN,
  SPEECH_CLOSE_SUPERSEDED,
  SPEECH_CLOSE_TOO_SLOW,
  SPEECH_CLOSE_VOICE_UNAVAILABLE
} from "@lys/protocol"
import type { ChatGenerationEvent } from "@lys/protocol"
import type { Conversation } from "@lys/share"
import { updateFastifyWithHttpTransport } from "../../../../src/http"
import type {
  ReplyGenerationTaskContext,
  ReplyTaskContext
} from "../../../../src/modules/chat/replyGeneration"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../../src/modules/chat/replyGenerationRegistry"
import registerVoiceRoutes from "../../../../src/modules/voice/routes"
import {
  VoiceUnavailableError,
  type VoiceSpeech,
  type VoiceSpeechHandlers
} from "../../../../src/modules/voice/voiceClient"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createUserMessage,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"
import { openConversationTestServices } from "../../support/conversationDatabase"
import { createTestFastify } from "../../support/fastifyTestApp"
import ControlledReplyTask from "../../support/controlledReplyTask"

/** Conversation the reply routes are addressed with. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** User message of the stored conversation. */
const USER_MESSAGE = createUserMessage(2, "Plan my trip")

/** Stored streaming text part of the fixture reply. */
function createStreamingPart(content: string) {
  return createTextPart({ sequence: 4, round: 0, content })
}

const TEXT_PART = createStreamingPart("Hello the")

/** The stored streaming reply the fixture conversation holds. */
const ASSISTANT_MESSAGE = createAssistantMessage(3, [TEXT_PART], {
  status: "streaming"
})

/** The stored completed reply the fixture conversation holds. */
const COMPLETED_ASSISTANT_MESSAGE = createAssistantMessage(
  3,
  [createTextPart({ sequence: 4, round: 0, content: "All done." })],
  {
    status: "completed",
    finishReason: "stop"
  }
)

/** Addresses the fixture reply. */
const REPLY_TARGET = Object.freeze({
  conversationId: CONVERSATION_ID,
  assistantMessageId: ASSISTANT_MESSAGE.id
} satisfies ReplyTarget)

/** Stored streaming conversation fixture. */
const STREAMING_CONVERSATION = Object.freeze({
  id: CONVERSATION_ID,
  title: "Trip plan",
  agentCode: "lys",
  kind: "main",
  parentConversationId: null,
  jobNumber: null,
  delegatorAgentCode: null,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  messages: [USER_MESSAGE, ASSISTANT_MESSAGE],
  sources: [],
  jobs: []
} satisfies Conversation)

/** Stored completed conversation fixture. */
const COMPLETED_CONVERSATION = Object.freeze({
  ...STREAMING_CONVERSATION,
  messages: [USER_MESSAGE, COMPLETED_ASSISTANT_MESSAGE]
} satisfies Conversation)

/** Builds the URL of a speech or notification socket for the fixture reply. */
function buildSpeechUrl(path: string, from?: "start" | "current"): string {
  const base = path
    .replace(":conversationId", CONVERSATION_ID)
    .replace(":assistantMessageId", REPLY_TARGET.assistantMessageId)
  return from === undefined ? base : `${base}?from=${from}`
}

/** Records what the fake voice was told, and plays voice back on demand. */
class FakeVoiceSpeech implements VoiceSpeech {
  readonly spoken: string[] = []
  speakCalled = false
  finishCalled = false
  cancelled = false
  audioFrames: Buffer[] = []
  #onAudio: ((pcm: Buffer) => void) | undefined
  #onClose: ((code: number) => void) | undefined

  public constructor(handlers: {
    onAudio: (pcm: Buffer) => void
    onClose: (code: number) => void
  }) {
    this.#onAudio = handlers.onAudio
    this.#onClose = handlers.onClose
  }

  public speak(): void {
    this.speakCalled = true
  }
  public speakText(text: string): void {
    this.spoken.push(text)
  }
  public finish(): void {
    this.finishCalled = true
  }
  public cancel(): void {
    this.cancelled = true
  }
  /** Plays one audio frame to the socket, as voice does. */
  public emitAudio(pcm: Buffer): void {
    this.#onAudio?.(pcm)
  }
  /** Ends the voice socket with a code, as voice does. */
  public closeFromVoice(code: number): void {
    this.#onClose?.(code)
  }
}

/** Opens a speech with the fake voice, as the backend would. */
type VoiceConnector = (handlers: VoiceSpeechHandlers) => Promise<VoiceSpeech>

/** What the fake voice connection was opened with. */
type FakeVoice = Readonly<{
  /** Every speech the backend opened, in order. */
  speeches: FakeVoiceSpeech[]
  /** Injected `connect` matching the route option. */
  connect: VoiceConnector
}>

/** Records one binary frame towards the list. */
function recordBinaryFrame(frames: Buffer[], source: unknown): void {
  if (source instanceof ArrayBuffer) frames.push(Buffer.from(source))
}

/** Creates a fake voice whose behavior the test drives. */
function createFakeVoice(): { fake: FakeVoice } {
  const speeches: FakeVoiceSpeech[] = []
  const connect: VoiceConnector = (handlers) => {
    const speech = new FakeVoiceSpeech(handlers)
    speeches.push(speech)
    return Promise.resolve(speech)
  }
  return { fake: { speeches, connect } }
}

/** A socket the tests drive through a real loopback server. */
type TestSocket = Readonly<{
  /** Binary frames the server sent, in order. */
  frames: Buffer[]
  /** Resolves with the close code the server chose. */
  closed: Promise<number>
  /** Closes the socket from the client side. */
  close: () => void
}>

/** Listens on an ephemeral port and returns its base URL. */
async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  const port =
    typeof address === "object" && address !== null ? address.port : 0
  return `ws://127.0.0.1:${port}`
}

/** Opens a speech socket against a listening app, recording frames. */
function openTestSocket(baseUrl: string, path: string): TestSocket {
  const frames: Buffer[] = []
  let ws: WebSocket | undefined
  const closed = new Promise<number>((resolve, reject) => {
    ws = new WebSocket(`${baseUrl}${path}`)
    ws.binaryType = "arraybuffer"
    ws.addEventListener("message", (event) => {
      recordBinaryFrame(frames, event.data)
    })
    ws.addEventListener("close", (event) => resolve(event.code))
    ws.addEventListener("error", () => reject(new Error("WebSocket error")))
  })
  return {
    frames,
    closed,
    close: () => ws?.close()
  }
}

/** Options for the app under test. */
type VoiceRoutesAppOptions = Readonly<{
  /** Stored conversation the speech endpoints read. */
  conversation: Conversation | undefined
  /** Voice readiness probe; defaults to always ready. */
  isReady?: () => Promise<boolean>
  /** Voice connection opener; defaults to the real one. */
  connect?: FakeVoice["connect"]
}>

/** Creates the app under test with a stubbed history and a controllable voice. */
async function createVoiceRoutesApp(options: VoiceRoutesAppOptions) {
  const testFastify = createTestFastify()
  const { history } = openConversationTestServices()
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  const getConversation = vi
    .spyOn(history, "getConversation")
    .mockImplementation(() => options.conversation)
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("conversationHistoryReader", history)
  testFastify.app.decorate("replyGenerations", generations)
  const voiceOptions = {
    isReady: options.isReady ?? (async () => true),
    ...(options.connect === undefined ? {} : { connect: options.connect })
  }
  await registerVoiceRoutes(testFastify.app, voiceOptions)
  const baseUrl = await listen(testFastify.app)
  return { ...testFastify, generations, getConversation, baseUrl }
}

/** The two tasks of a generation a test drives. */
type FixtureGeneration = Readonly<{
  /** Reply task, whose context sends the reply's events. */
  replyTask: ControlledReplyTask<ReplyTaskContext>
  /** Title task. */
  titleTask: ControlledReplyTask<ReplyGenerationTaskContext>
}>

/** Starts a generation for the fixture reply, returning its tasks. */
function startFixtureGeneration(
  generations: ReplyGenerationRegistry
): FixtureGeneration {
  const replyTask = new ControlledReplyTask<ReplyTaskContext>()
  const titleTask = new ControlledReplyTask<ReplyGenerationTaskContext>()
  generations.startReplyGeneration(REPLY_TARGET, {
    startReplyTask: (context: ReplyTaskContext) => replyTask.start(context),
    startTitleTask: (context: ReplyGenerationTaskContext) =>
      titleTask.start(context),
    reportTaskFailure: vi.fn()
  })
  onTestFinished(() => {
    replyTask.resolve()
    titleTask.resolve()
  })
  return { replyTask, titleTask }
}

/** A streamed fragment of the fixture reply's text part. */
function createTextDelta(content: string): ChatGenerationEvent {
  return {
    type: "reply-part-delta",
    partId: TEXT_PART.id,
    content,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/** A second completed reply in the same conversation. */
const OTHER_ASSISTANT_MESSAGE = createAssistantMessage(
  5,
  [createTextPart({ sequence: 6, round: 0, content: "Other." })],
  { status: "completed", finishReason: "stop" }
)

/** Conversation holding a streaming reply and a second completed one. */
const TWO_REPLY_CONVERSATION = Object.freeze({
  ...STREAMING_CONVERSATION,
  messages: [USER_MESSAGE, ASSISTANT_MESSAGE, OTHER_ASSISTANT_MESSAGE]
} satisfies Conversation)

/** Builds the speech URL of the second reply. */
function buildOtherReplySpeechUrl(): string {
  return buildSpeechUrl(chatSpeechApi.path, "start").replace(
    REPLY_TARGET.assistantMessageId,
    OTHER_ASSISTANT_MESSAGE.id
  )
}

describe("speech routes", () => {
  it("closes with 4404 when the reply does not exist", async () => {
    const app = await createVoiceRoutesApp({ conversation: undefined })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_NO_SUCH_REPLY)
  })

  it("closes with 4503 when voice is not ready", async () => {
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      isReady: async () => false
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_VOICE_UNAVAILABLE)
  })

  it("closes with 4410 for a `current` speech once the reply is not being written", async () => {
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "current")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_REPLY_ENDED)
  })

  it("hands voice a sentence too long for one message in pieces", async () => {
    const sentence = Array.from({ length: 1000 }, () => "word").join(" ")
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: {
        ...COMPLETED_CONVERSATION,
        messages: [
          USER_MESSAGE,
          createAssistantMessage(
            3,
            [createTextPart({ sequence: 4, round: 0, content: sentence })],
            { status: "completed", finishReason: "stop" }
          )
        ]
      },
      connect: fake.connect
    })
    openTestSocket(app.baseUrl, buildSpeechUrl(chatSpeechApi.path, "start"))
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    const spoken = fake.speeches[0]?.spoken ?? []
    expect(spoken.length).toBeGreaterThan(1)
    expect(spoken.every((piece) => piece.length <= 2000)).toBe(true)
    expect(spoken.join(" ")).toBe(`${sentence}.`)
  })

  it("speaks the stored snapshot of a finished reply and closes 1000", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual(["All done."])
    expect(fake.speeches[0]?.finishCalled).toBe(true)
    fake.speeches[0]?.emitAudio(Buffer.from([1, 2, 3, 4]))
    fake.speeches[0]?.closeFromVoice(1000)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_COMPLETE)
    expect(socket.frames).toHaveLength(1)
  })

  it("joins a running reply at the sentence being written", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      connect: fake.connect
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "current")
    )
    await vi.waitFor(() => expect(fake.speeches).toHaveLength(1))
    // The stored snapshot holds "Hello the"; no complete sentence yet.
    expect(fake.speeches[0]?.spoken).toEqual([])

    replyTask.context.sendEvent(createTextDelta(" world. Fresh start"))
    await vi.waitFor(() =>
      expect(fake.speeches[0]?.spoken).toEqual(["Hello the world."])
    )
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual([
      "Hello the world.",
      "Fresh start."
    ])
    fake.speeches[0]?.closeFromVoice(1000)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_COMPLETE)
  })

  it("closes the socket with 4410 when the reply is interrupted", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      connect: fake.connect
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches).toHaveLength(1))
    replyTask.context.sendEvent({ type: "interrupted" })
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_REPLY_ENDED)
    await vi.waitFor(() => expect(fake.speeches[0]?.cancelled).toBe(true))
    replyTask.resolve()
  })

  it("supersedes an older speech socket for the same reply", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const first = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches).toHaveLength(1))
    const second = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(first.closed).resolves.toBe(SPEECH_CLOSE_SUPERSEDED)
    second.close()
    await vi.waitFor(() => expect(fake.speeches).toHaveLength(2))
  })

  it("notification speaks one line and relays the audio", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatNotificationApi.path)
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toHaveLength(1)
    expect(fake.speeches[0]?.spoken[0]).toMatch(
      /^(Master, your response is ready\.|Master, I've finished my answer\.|Your answer is waiting for you, Master\.|I'm done, Master\. Come and see\.)$/
    )
    fake.speeches[0]?.emitAudio(Buffer.from([9]))
    fake.speeches[0]?.closeFromVoice(1000)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_COMPLETE)
    expect(socket.frames).toHaveLength(1)
  })

  it("notification closes 4503 when voice is not ready", async () => {
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      isReady: async () => false
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatNotificationApi.path)
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_VOICE_UNAVAILABLE)
  })

  it("refuses a foreign origin before the upgrade with 403", async () => {
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION
    })
    const httpBase = app.baseUrl.replace(/^ws:/, "http:")
    for (const path of [
      buildSpeechUrl(chatSpeechApi.path, "start"),
      buildSpeechUrl(chatNotificationApi.path)
    ]) {
      const response = await fetch(`${httpBase}${path}`, {
        headers: { origin: "https://evil.example" }
      })
      expect(response.status).toBe(403)
    }
  })

  it("does not refuse the desktop origin", async () => {
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION
    })
    const httpBase = app.baseUrl.replace(/^ws:/, "http:")
    const response = await fetch(
      `${httpBase}${buildSpeechUrl(chatSpeechApi.path, "start")}`,
      { headers: { origin: "http://localhost:1420" } }
    )
    expect(response.status).not.toBe(403)
  })
})

/** A fake voice whose handshake the test answers. */
type PendingVoice = Readonly<{
  /** Injected `connect` that waits for {@link answer}. */
  connect: VoiceConnector
  /** Whether the backend dialed voice. */
  isDialed: () => boolean
  /** Accepts the handshake, returning the speech the backend received. */
  answer: () => FakeVoiceSpeech
}>

/** Creates a fake voice that holds the handshake until the test answers. */
function createPendingVoice(): PendingVoice {
  const handshake = Promise.withResolvers<VoiceSpeech>()
  let handlers: VoiceSpeechHandlers | undefined
  return {
    connect: (dialed) => {
      handlers = dialed
      return handshake.promise
    },
    isDialed: () => handlers !== undefined,
    answer: () => {
      if (handlers === undefined) throw new Error("voice was not dialed")
      const speech = new FakeVoiceSpeech(handlers)
      handshake.resolve(speech)
      return speech
    }
  }
}

describe("speech sockets over their lifecycle", () => {
  it("speaks text stored while voice's health was being checked", async () => {
    const { fake } = createFakeVoice()
    const health = Promise.withResolvers<boolean>()
    const isReady = vi.fn(() => health.promise)
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      isReady,
      connect: fake.connect
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(isReady).toHaveBeenCalled())
    replyTask.context.sendEvent(createTextDelta("re, friend. Next"))
    app.getConversation.mockReturnValue({
      ...STREAMING_CONVERSATION,
      messages: [
        USER_MESSAGE,
        {
          ...ASSISTANT_MESSAGE,
          parts: [createStreamingPart("Hello there, friend. Next")]
        }
      ]
    })
    health.resolve(true)
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent(createTextDelta(" one."))
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual([
      "Hello there, friend.",
      "Next one."
    ])
    socket.close()
  })

  it("cancels a speech voice accepts after the UI closed its socket", async () => {
    const voice = createPendingVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: voice.connect
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(voice.isDialed()).toBe(true))
    socket.close()
    await socket.closed
    const speech = voice.answer()
    await vi.waitFor(() => expect(speech.cancelled).toBe(true))
    expect(speech.speakCalled).toBe(false)
  })

  it("speaks a reply that ended while voice's handshake was pending", async () => {
    const voice = createPendingVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      connect: voice.connect
    })
    const { replyTask, titleTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(voice.isDialed()).toBe(true))
    replyTask.context.sendEvent(createTextDelta(" world. Bye now."))
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    replyTask.resolve()
    titleTask.resolve()
    await vi.waitFor(() =>
      expect(app.generations.findReplyGeneration(REPLY_TARGET)).toBeUndefined()
    )
    const speech = voice.answer()
    await vi.waitFor(() => expect(speech.finishCalled).toBe(true))
    expect(speech.spoken).toEqual(["Hello the world.", "Bye now."])
    expect(speech.cancelled).toBe(false)
    speech.closeFromVoice(1000)
    await expect(socket.closed).resolves.toBe(1000)
  })

  it("speaks the sentence before a reasoning part without waiting for more text", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      connect: fake.connect
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent(createTextDelta(" weather."))
    replyTask.context.sendEvent({
      type: "reply-part",
      part: createReasoningPart(7, 0, "Checking.")
    })
    await vi.waitFor(() =>
      expect(fake.speeches[0]?.spoken).toEqual(["Hello the weather."])
    )
    socket.close()
  })

  it("supersedes the socket of another reply and cancels its speech", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: TWO_REPLY_CONVERSATION,
      connect: fake.connect
    })
    startFixtureGeneration(app.generations)
    const first = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    const second = openTestSocket(app.baseUrl, buildOtherReplySpeechUrl())
    await expect(first.closed).resolves.toBe(SPEECH_CLOSE_SUPERSEDED)
    await vi.waitFor(() => expect(fake.speeches[0]?.cancelled).toBe(true))
    await vi.waitFor(() => expect(fake.speeches[1]?.spoken).toEqual(["Other."]))
    second.close()
  })

  it("closes 1011 when voice ends a speech with a failure", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    fake.speeches[0]?.closeFromVoice(1011)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_FAILED)
  })

  it("closes 4410 and cancels the speech when the reply fails", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      connect: fake.connect
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent({ type: "error", message: "Model failed" })
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_REPLY_ENDED)
    expect(fake.speeches[0]?.cancelled).toBe(true)
  })

  it("closes 4410 when the reply's generation ends without an end event", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      connect: fake.connect
    })
    const { replyTask, titleTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.resolve()
    titleTask.resolve()
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_REPLY_ENDED)
    expect(fake.speeches[0]?.cancelled).toBe(true)
  })

  it("closes 4503 when voice refuses the speech handshake", async () => {
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: () => Promise.reject(new VoiceUnavailableError("refused"))
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_VOICE_UNAVAILABLE)
  })

  it("closes 1011 when the conversation store cannot be read", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    app.getConversation.mockImplementation(() => {
      throw new Error("The database is locked")
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_FAILED)
    expect(fake.speeches).toHaveLength(0)
  })

  it("notification closes 4404 when the reply does not exist", async () => {
    const app = await createVoiceRoutesApp({ conversation: undefined })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatNotificationApi.path)
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_NO_SUCH_REPLY)
  })

  it("closes 1008 and cancels the speech when the UI falls behind", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    const frame = Buffer.alloc(64 * 1024)
    for (let count = 0; count < 160; count += 1)
      fake.speeches[0]?.emitAudio(frame)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_TOO_SLOW)
    expect(fake.speeches[0]?.cancelled).toBe(true)
  })

  it("closes 1001 when the backend shuts down", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    await app.app.close()
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_SHUTDOWN)
  })

  it("refuses a foreign origin's upgrade, so no speech starts", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      connect: fake.connect
    })
    const url = `${app.baseUrl}${buildSpeechUrl(chatSpeechApi.path, "start")}`
    const socket = new WebSocket(url, {
      headers: { origin: "https://evil.example" }
    })
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code))
    })
    await expect(closed).resolves.toBe(1006)
    expect(fake.speeches).toHaveLength(0)
  })
})
