import { once } from "node:events"
import { connect } from "node:net"
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
  createToolCallPart,
  createUserMessage,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"
import { openConversationTestServices } from "../../support/conversationDatabase"
import { createTestFastify } from "../../support/fastifyTestApp"
import ControlledReplyTask from "../../support/controlledReplyTask"
import { waitForMicrotasks } from "../../support/microtasks"

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

  public start(): void {
    this.speakCalled = true
  }
  public sendText(text: string): void {
    this.spoken.push(text)
  }
  public sendFinish(): void {
    this.finishCalled = true
  }
  public cancel(): void {
    this.cancelled = true
  }
  /** Plays one audio frame to the socket, as voice does. */
  public sendAudio(pcm: Buffer): void {
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
  /** Injected `openVoiceSpeech` matching the route option. */
  openVoiceSpeech: VoiceConnector
}>

/** Records one binary frame towards the list. */
function addBinaryFrame(frames: Buffer[], source: unknown): void {
  if (source instanceof ArrayBuffer) frames.push(Buffer.from(source))
}

/** Creates a fake voice whose behavior the test drives. */
function createFakeVoice(): { fake: FakeVoice } {
  const speeches: FakeVoiceSpeech[] = []
  const openVoiceSpeech: VoiceConnector = (handlers) => {
    const speech = new FakeVoiceSpeech(handlers)
    speeches.push(speech)
    return Promise.resolve(speech)
  }
  return { fake: { speeches, openVoiceSpeech } }
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
async function startServer(app: FastifyInstance): Promise<string> {
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
      addBinaryFrame(frames, event.data)
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

/**
 * Opens a speech socket over plain TCP and sends a frame no client may send:
 * an unmasked text frame, which the server's socket fails on.
 *
 * @returns Settlement once the server closed the connection.
 */
async function sendUnmaskedTextFrame(
  baseUrl: string,
  path: string
): Promise<void> {
  const url = new URL(`${baseUrl}${path}`)
  const connection = connect(Number(url.port), url.hostname)
  await once(connection, "connect")
  connection.write(
    [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      ""
    ].join("\r\n")
  )
  const [handshake] = (await once(connection, "data")) as [Buffer]
  expect(handshake.toString("latin1")).toMatch(/^HTTP\/1\.1 101 /)
  connection.write(Buffer.from([0x81, 0x01, 0x61]))
  await once(connection, "close")
}

/** Options for the app under test. */
type VoiceRoutesAppOptions = Readonly<{
  /** Stored conversation the speech endpoints read. */
  conversation: Conversation | undefined
  /** Voice readiness probe; defaults to always ready. */
  isReady?: () => Promise<boolean>
  /** Voice connection opener; defaults to the real one. */
  openVoiceSpeech?: FakeVoice["openVoiceSpeech"]
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
    ...(options.openVoiceSpeech === undefined
      ? {}
      : { openVoiceSpeech: options.openVoiceSpeech })
  }
  await registerVoiceRoutes(testFastify.app, voiceOptions)
  const baseUrl = await startServer(testFastify.app)
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

/** The log entry a speech socket writes, matched by its level and message. */
function matchLogEntry(level: string, msg: string, fields: object = {}) {
  return expect.objectContaining({ level, msg, ...fields })
}

/** A text part of the fixture reply that ends inside an unclosed code fence. */
const FENCE_TEXT_PART = createTextPart({
  sequence: 4,
  round: 0,
  content: "Let me list the files:\n\n```bash\nls -la"
})

/** The tool call that follows the fenced text part. */
const LIST_FILES_CALL = createToolCallPart(
  { sequence: 5, round: 0, toolName: "list_files", argumentText: "{}" },
  { status: "succeeded", result: "a.txt b.txt notes.txt", sourceNumbers: [] }
)

/** The answer after the tool call. */
const ANSWER_TEXT_PART = createTextPart({
  sequence: 6,
  round: 1,
  content: "There are three files here."
})

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
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual(["All done."])
    expect(fake.speeches[0]?.finishCalled).toBe(true)
    fake.speeches[0]?.sendAudio(Buffer.from([1, 2, 3, 4]))
    fake.speeches[0]?.closeFromVoice(1000)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_COMPLETE)
    expect(socket.frames).toHaveLength(1)
    expect(app.log.records).toContainEqual(
      matchLogEntry("info", "Speech socket opened", {
        speech: "reply",
        from: "start"
      })
    )
  })

  it("joins a running reply at the sentence being written", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: fake.openVoiceSpeech
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

  it("speaks the answer after a stored text part that ended inside a code fence", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: {
        ...COMPLETED_CONVERSATION,
        messages: [
          USER_MESSAGE,
          createAssistantMessage(
            3,
            [FENCE_TEXT_PART, LIST_FILES_CALL, ANSWER_TEXT_PART],
            { status: "completed", finishReason: "stop" }
          )
        ]
      },
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual([
      "Let me list the files:.",
      "There are three files here."
    ])
    socket.close()
  })

  it("speaks the answer after a streamed text part that ended inside a code fence", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent(createTextDelta("re:\n\n```bash\nls -la"))
    replyTask.context.sendEvent({ type: "reply-part", part: LIST_FILES_CALL })
    replyTask.context.sendEvent({ type: "reply-part", part: ANSWER_TEXT_PART })
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual([
      "Hello there:.",
      "There are three files here."
    ])
    socket.close()
  })

  it("supersedes a speaking speech socket when a notification socket opens", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
    })
    startFixtureGeneration(app.generations)
    const speech = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    const notification = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatNotificationApi.path)
    )
    await expect(speech.closed).resolves.toBe(SPEECH_CLOSE_SUPERSEDED)
    await vi.waitFor(() => expect(fake.speeches[0]?.cancelled).toBe(true))
    await vi.waitFor(() => expect(fake.speeches[1]?.finishCalled).toBe(true))
    expect(fake.speeches[1]?.spoken).toHaveLength(1)
    notification.close()
  })

  it("notification speaks one line and relays the audio", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
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
    fake.speeches[0]?.sendAudio(Buffer.from([9]))
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
  /** Injected `openVoiceSpeech` that waits for {@link answer}. */
  openVoiceSpeech: VoiceConnector
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
    openVoiceSpeech: (dialed) => {
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
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: voice.openVoiceSpeech
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

  it("never dials voice when the UI closes its socket during the health check", async () => {
    const openVoiceSpeech = vi.fn(createFakeVoice().fake.openVoiceSpeech)
    const health = Promise.withResolvers<boolean>()
    const isReady = vi.fn(() => health.promise)
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      isReady,
      openVoiceSpeech
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(isReady).toHaveBeenCalled())
    socket.close()
    await socket.closed
    health.resolve(true)
    await waitForMicrotasks()
    expect(openVoiceSpeech).not.toHaveBeenCalled()
  })

  it("closes 1001 when the generation registry has already closed", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
    })
    await app.generations[Symbol.asyncDispose]()
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_SHUTDOWN)
    expect(fake.speeches).toHaveLength(0)
  })

  it("speaks a reply that ended while voice's handshake was pending", async () => {
    const voice = createPendingVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: voice.openVoiceSpeech
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

  it("speaks the sentence before a tool call without waiting for more text", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent(createTextDelta(" weather."))
    replyTask.context.sendEvent({ type: "reply-part", part: LIST_FILES_CALL })
    await vi.waitFor(() =>
      expect(fake.speeches[0]?.spoken).toEqual(["Hello the weather."])
    )
    socket.close()
  })

  it("reads a streamed round's text after its reasoning as the rest of the same text", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent(createTextDelta(" weather"))
    replyTask.context.sendEvent({
      type: "reply-part",
      part: createReasoningPart(7, 0, "Checking.")
    })
    replyTask.context.sendEvent({
      type: "reply-part",
      part: createTextPart({ sequence: 8, round: 0, content: " today. Bye" })
    })
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual([
      "Hello the weather today.",
      "Bye."
    ])
    socket.close()
  })

  it("reads a stored round's text after its reasoning as the rest of the same text", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: {
        ...STREAMING_CONVERSATION,
        messages: [
          USER_MESSAGE,
          createAssistantMessage(
            3,
            [TEXT_PART, createReasoningPart(7, 0, "Checking.")],
            { status: "streaming" }
          )
        ]
      },
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const { replyTask } = startFixtureGeneration(app.generations)
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.speakCalled).toBe(true))
    replyTask.context.sendEvent({
      type: "reply-part",
      part: createTextPart({ sequence: 8, round: 0, content: " weather. Bye" })
    })
    replyTask.context.sendEvent({ type: "done", finishReason: "stop" })
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    expect(fake.speeches[0]?.spoken).toEqual(["Hello the weather.", "Bye."])
    socket.close()
  })

  it("supersedes the socket of another reply and cancels its speech", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: TWO_REPLY_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    fake.speeches[0]?.closeFromVoice(1011)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_FAILED)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Voice ended a speech that failed", {
        voiceCloseCode: 1011
      })
    )
    await vi.waitFor(() =>
      expect(app.log.records).toContainEqual(
        matchLogEntry("info", "Speech socket closed", {
          code: SPEECH_CLOSE_FAILED
        })
      )
    )
  })

  it("closes 4410 and cancels the speech when the reply fails", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: STREAMING_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: () =>
        Promise.reject(new VoiceUnavailableError("refused"))
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_VOICE_UNAVAILABLE)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Voice refused a speech", {
        err: expect.objectContaining({ message: "refused" })
      })
    )
  })

  it("logs the failure of a socket that sends a frame no client may send, and its close without a close frame", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
    })
    await sendUnmaskedTextFrame(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() =>
      expect(app.log.records).toContainEqual(
        matchLogEntry("info", "Speech socket closed", { code: 1006 })
      )
    )
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Speech socket failed", {
        err: expect.objectContaining({ code: "WS_ERR_EXPECTED_MASK" })
      })
    )
  })

  it("closes 1011 and logs the cause when voice cannot be reached", async () => {
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      openVoiceSpeech: () => Promise.reject(new Error("connect ECONNREFUSED"))
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_FAILED)
    expect(app.log.records).toContainEqual(
      matchLogEntry("error", "Speech could not reach voice", {
        err: expect.objectContaining({ message: "connect ECONNREFUSED" })
      })
    )
  })

  it("closes 1011 when the conversation store cannot be read", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
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
    expect(app.log.records).toContainEqual(
      matchLogEntry("error", "Speech could not read the reply", {
        err: expect.objectContaining({ message: "The database is locked" })
      })
    )
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
      openVoiceSpeech: fake.openVoiceSpeech
    })
    const socket = openTestSocket(
      app.baseUrl,
      buildSpeechUrl(chatSpeechApi.path, "start")
    )
    await vi.waitFor(() => expect(fake.speeches[0]?.finishCalled).toBe(true))
    const frame = Buffer.alloc(64 * 1024)
    for (let count = 0; count < 160; count += 1)
      fake.speeches[0]?.sendAudio(frame)
    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_TOO_SLOW)
    expect(fake.speeches[0]?.cancelled).toBe(true)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Speech socket fell behind its audio", {
        bufferedBytes: expect.any(Number)
      })
    )
  })

  it("closes 1001 when the backend shuts down", async () => {
    const { fake } = createFakeVoice()
    const app = await createVoiceRoutesApp({
      conversation: COMPLETED_CONVERSATION,
      openVoiceSpeech: fake.openVoiceSpeech
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
      openVoiceSpeech: fake.openVoiceSpeech
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
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Speech socket refused a foreign origin", {
        origin: "https://evil.example"
      })
    )
  })
})
