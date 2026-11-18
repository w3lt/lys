import type { FastifyInstance } from "fastify"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  chatNotificationApi,
  chatSpeechApi,
  SPEECH_CLOSE_COMPLETE,
  SPEECH_CLOSE_NO_SUCH_REPLY,
  SPEECH_CLOSE_REPLY_ENDED,
  SPEECH_CLOSE_SUPERSEDED,
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
import updateFastifyWithVoiceRoutes from "../../../../src/modules/voice/routes"
import type {
  VoiceSpeech,
  VoiceSpeechHandlers
} from "../../../../src/modules/voice/voiceClient"
import {
  createAssistantMessage,
  createFixtureUuidV7,
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
  public readonly bufferedAmount = 0
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
  updateFastifyWithVoiceRoutes(testFastify.app, voiceOptions)
  const baseUrl = await listen(testFastify.app)
  return { ...testFastify, generations, getConversation, baseUrl }
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
    const replyTask = new ControlledReplyTask()
    const titleTask = new ControlledReplyTask()
    app.generations.startReplyGeneration(REPLY_TARGET, {
      startReplyTask: (context: ReplyTaskContext) => replyTask.start(context),
      startTitleTask: (context: ReplyGenerationTaskContext) =>
        titleTask.start(context),
      reportTaskFailure: vi.fn()
    })
    onTestFinished(() => {
      replyTask.resolve()
      titleTask.resolve()
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "current")
    )
    await vi.waitFor(() => expect(fake.speeches).toHaveLength(1))
    // The stored snapshot holds "Hello the"; no complete sentence yet.
    expect(fake.speeches[0]?.spoken).toEqual([])

    replyTask.context.sendEvent({
      type: "reply-part-delta",
      partId: TEXT_PART.id,
      content: " world. Fresh start",
      updatedAt: FIXTURE_TIMESTAMP
    } satisfies ChatGenerationEvent)
    await vi.waitFor(() =>
      expect(fake.speeches[0]?.spoken).toEqual(["Hello the world."])
    )
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual([
      "Hello the world.",
      "Fresh start"
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
    const replyTask = new ControlledReplyTask()
    const titleTask = new ControlledReplyTask()
    app.generations.startReplyGeneration(REPLY_TARGET, {
      startReplyTask: (context: ReplyTaskContext) => replyTask.start(context),
      startTitleTask: (context: ReplyGenerationTaskContext) =>
        titleTask.start(context),
      reportTaskFailure: vi.fn()
    })
    onTestFinished(() => {
      replyTask.resolve()
      titleTask.resolve()
    })
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
