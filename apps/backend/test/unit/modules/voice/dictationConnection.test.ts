import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  DICTATION_CLOSE_COMPLETE,
  DICTATION_CLOSE_FAILED,
  DICTATION_CLOSE_PROTOCOL_ERROR,
  DICTATION_CLOSE_SUPERSEDED,
  DICTATION_CLOSE_VOICE_UNAVAILABLE,
  DICTATION_MAX_DURATION_MS,
  SOCKET_MAX_CLIENT_MESSAGE_BYTES,
  SPEECH_CLOSE_SHUTDOWN,
  voiceDictationApi
} from "@lys/protocol"
import { updateFastifyWithHttpTransport } from "../../../../src/http"
import ReplyGenerationRegistry from "../../../../src/modules/chat/replyGenerationRegistry"
import registerVoiceRoutes from "../../../../src/modules/voice/routes"
import {
  VoiceUnavailableError,
  type VoiceDictation,
  type VoiceDictationHandlers
} from "../../../../src/modules/voice/voiceClient"
import { openConversationTestServices } from "../../support/conversationDatabase"
import { createTestFastify } from "../../support/fastifyTestApp"
import { waitForMicrotasks } from "../../support/microtasks"

/** One message of dictated audio: 100 ms of 16 kHz samples. */
const AUDIO_FRAME = Buffer.alloc(3_200, 1)

/** The message a client stops its dictation with. */
const STOP_MESSAGE = JSON.stringify({ type: "stop" })

/** Records what the fake voice was told, and plays voice back on demand. */
class FakeVoiceDictation implements VoiceDictation {
  /** Audio the backend relayed, in order. */
  public readonly audio: Buffer[] = []
  /** Whether the backend started the dictation. */
  public isStarted = false
  /** Whether the backend sent `stop`. */
  public isStopped = false
  /** Whether the backend hung up. */
  public isCancelled = false
  /** Bytes voice reports as not taken yet. */
  public bufferedBytes = 0
  readonly #handlers: VoiceDictationHandlers

  public constructor(handlers: VoiceDictationHandlers) {
    this.#handlers = handlers
  }

  public start(): void {
    this.isStarted = true
  }
  public sendAudio(pcm: Uint8Array): void {
    this.audio.push(Buffer.from(pcm))
  }
  public sendStop(): void {
    this.isStopped = true
  }
  public getBufferedBytes(): number {
    return this.bufferedBytes
  }
  public cancel(): void {
    this.isCancelled = true
  }
  /** Sends one text message to the backend, as voice does. */
  public sendText(message: unknown): void {
    this.#handlers.onText(
      typeof message === "string" ? message : JSON.stringify(message)
    )
  }
  /** Ends the voice socket with a code, as voice does. */
  public closeFromVoice(code: number): void {
    this.#handlers.onClose(code)
  }
}

/** Opens a dictation with the fake voice, as the backend would. */
type VoiceConnector = (
  handlers: VoiceDictationHandlers
) => Promise<VoiceDictation>

/** A fake voice that accepts every dictation at once. */
type FakeVoice = Readonly<{
  /** Every dictation the backend opened, in order. */
  dictations: FakeVoiceDictation[]
  /** Injected `openVoiceDictation` matching the route option. */
  openVoiceDictation: VoiceConnector
}>

/** Creates a fake voice whose behavior the test drives. */
function createFakeVoice(): FakeVoice {
  const dictations: FakeVoiceDictation[] = []
  const openVoiceDictation: VoiceConnector = (handlers) => {
    const dictation = new FakeVoiceDictation(handlers)
    dictations.push(dictation)
    return Promise.resolve(dictation)
  }
  return { dictations, openVoiceDictation }
}

/** A fake voice whose handshake the test answers. */
type PendingVoice = Readonly<{
  /** Injected `openVoiceDictation` that waits for {@link resolveHandshake}. */
  openVoiceDictation: VoiceConnector
  /** Whether the backend dialed voice. */
  isDialed: () => boolean
  /** Accepts the handshake, returning the dictation the backend received. */
  resolveHandshake: () => FakeVoiceDictation
}>

/** Creates a fake voice that holds the handshake until the test answers. */
function createPendingVoice(): PendingVoice {
  const handshake = Promise.withResolvers<VoiceDictation>()
  let handlers: VoiceDictationHandlers | undefined
  return {
    openVoiceDictation: (dialed) => {
      handlers = dialed
      return handshake.promise
    },
    isDialed: () => handlers !== undefined,
    resolveHandshake: () => {
      if (handlers === undefined) throw new Error("voice was not dialed")
      const dictation = new FakeVoiceDictation(handlers)
      handshake.resolve(dictation)
      return dictation
    }
  }
}

/** Options for the app under test. */
type DictationAppOptions = Readonly<{
  /** Voice readiness probe; defaults to always ready. */
  isReady?: () => Promise<boolean>
  /** Voice connection opener. */
  openVoiceDictation: VoiceConnector
}>

/** Creates the listening app under test with a controllable voice. */
async function createDictationApp(options: DictationAppOptions) {
  const testFastify = createTestFastify()
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate(
    "conversationHistoryReader",
    openConversationTestServices().history
  )
  testFastify.app.decorate("replyGenerations", generations)
  await registerVoiceRoutes(testFastify.app, {
    isReady: options.isReady ?? (async () => true),
    openVoiceDictation: options.openVoiceDictation
  })
  const received = { count: 0 }
  testFastify.app.websocketServer.on("connection", (socket) => {
    socket.on("message", () => {
      received.count += 1
    })
  })
  await testFastify.app.listen({ port: 0, host: "127.0.0.1" })
  const address = testFastify.app.server.address()
  const port =
    typeof address === "object" && address !== null ? address.port : 0
  return {
    ...testFastify,
    baseUrl: `ws://127.0.0.1:${port}`,
    /** Gets how many client messages the server handled so far. */
    getReceivedMessageCount: () => received.count
  }
}

/** A dictation socket the tests drive through a real loopback server. */
type TestSocket = Readonly<{
  /** Text messages the server sent, parsed, in order. */
  messages: unknown[]
  /** Resolves once the server accepted the socket. */
  opened: Promise<void>
  /** Resolves with the close code the server chose. */
  closed: Promise<number>
  /** Sends one message from the client side. */
  send: (message: string | Uint8Array) => void
  /** Closes the socket from the client side. */
  close: () => void
}>

/** Opens a dictation socket against a listening app, recording messages. */
function openTestSocket(baseUrl: string): TestSocket {
  const messages: unknown[] = []
  const opened = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<number>()
  const ws = new WebSocket(`${baseUrl}${voiceDictationApi.path}`)
  ws.addEventListener("open", () => opened.resolve())
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)))
  })
  ws.addEventListener("close", (event) => closed.resolve(event.code))
  return {
    messages,
    opened: opened.promise,
    closed: closed.promise,
    send: (message) => ws.send(message),
    close: () => ws.close()
  }
}

/** A listening app, its accepting fake voice, and one open dictation. */
async function openDictation() {
  const fake = createFakeVoice()
  const app = await createDictationApp(fake)
  const socket = openTestSocket(app.baseUrl)
  await socket.opened
  await vi.waitFor(() => expect(fake.dictations[0]?.isStarted).toBe(true))
  const voice = fake.dictations[0]
  if (voice === undefined) throw new Error("voice was not dialed")
  return { app, fake, socket, voice }
}

/** The log entry a dictation socket writes, matched by its level and message. */
function matchLogEntry(level: string, msg: string, fields: object = {}) {
  return expect.objectContaining({ level, msg, ...fields })
}

/**
 * Freezes the timers the relay uses, until the test ends.
 *
 * `vi.waitFor` advances frozen timers by its polling interval, for at most
 * its one-second timeout, so a test leaves that margin before a deadline.
 */
function useFakeRelayTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

describe("dictation route", () => {
  it("relays audio to voice and text to the UI, and closes 1000 after the final text", async () => {
    const { socket, voice } = await openDictation()
    socket.send(AUDIO_FRAME)
    await vi.waitFor(() => expect(voice.audio).toEqual([AUDIO_FRAME]))
    voice.sendText({ type: "partial", text: "hello" })
    await vi.waitFor(() => expect(socket.messages).toHaveLength(1))
    socket.send(STOP_MESSAGE)
    await vi.waitFor(() => expect(voice.isStopped).toBe(true))
    voice.sendText({ type: "final", text: "Hello." })
    voice.closeFromVoice(1000)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_COMPLETE)
    expect(socket.messages).toEqual([
      { type: "partial", text: "hello" },
      { type: "final", text: "Hello." }
    ])
  })

  it("keeps audio sent before voice accepted the dictation, in order", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await socket.opened
    socket.send(Buffer.alloc(2, 1))
    socket.send(Buffer.alloc(2, 2))
    await vi.waitFor(() => expect(app.getReceivedMessageCount()).toBe(2))
    await vi.waitFor(() => expect(pending.isDialed()).toBe(true))
    const voice = pending.resolveHandshake()

    await vi.waitFor(() =>
      expect(voice.audio).toEqual([Buffer.alloc(2, 1), Buffer.alloc(2, 2)])
    )
    expect(voice.isStarted).toBe(true)
    expect(voice.isStopped).toBe(false)
  })

  it("sends a stop received before voice accepted after the audio, and drops later audio", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await socket.opened
    socket.send(AUDIO_FRAME)
    socket.send(STOP_MESSAGE)
    socket.send(Buffer.alloc(2, 2))
    await vi.waitFor(() => expect(app.getReceivedMessageCount()).toBe(3))
    await vi.waitFor(() => expect(pending.isDialed()).toBe(true))
    const voice = pending.resolveHandshake()

    await vi.waitFor(() => expect(voice.isStopped).toBe(true))
    expect(voice.audio).toEqual([AUDIO_FRAME])
  })

  it("drops audio and a second stop sent after the stop", async () => {
    const { socket, voice } = await openDictation()
    socket.send(STOP_MESSAGE)
    await vi.waitFor(() => expect(voice.isStopped).toBe(true))
    socket.send(AUDIO_FRAME)
    socket.send(STOP_MESSAGE)
    voice.sendText({ type: "final", text: "" })
    voice.closeFromVoice(1000)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_COMPLETE)
    expect(voice.audio).toEqual([])
  })

  it("cancels the dictation at voice when the UI closes its socket", async () => {
    const { socket, voice } = await openDictation()
    socket.close()
    await socket.closed

    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
  })

  it("supersedes an older dictation socket and cancels its dictation", async () => {
    const { app, fake, socket, voice } = await openDictation()
    const newer = openTestSocket(app.baseUrl)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_SUPERSEDED)
    await vi.waitFor(() => expect(fake.dictations[1]?.isStarted).toBe(true))
    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
    voice.closeFromVoice(1001)
    newer.close()
    await newer.closed
    expect(app.log.records).not.toContainEqual(
      matchLogEntry("warn", "Voice ended a dictation that failed")
    )
  })

  it("never logs the audio or the text of a dictation", async () => {
    const { app, socket, voice } = await openDictation()
    socket.send(Buffer.from("spoken secret!!", "latin1").subarray(0, 14))
    await vi.waitFor(() => expect(voice.audio).toHaveLength(1))
    voice.sendText({ type: "partial", text: "dictated secret" })
    socket.send(STOP_MESSAGE)
    await vi.waitFor(() => expect(voice.isStopped).toBe(true))
    voice.sendText({ type: "final", text: "Dictated secret." })
    voice.closeFromVoice(1000)
    await socket.closed

    const log = JSON.stringify(app.log.records).toLowerCase()
    expect(log).not.toContain("secret")
  })
})

describe("dictation route refusals", () => {
  it("closes 4503 without dialing voice when voice is not ready", async () => {
    const openVoiceDictation = vi.fn(createFakeVoice().openVoiceDictation)
    const app = await createDictationApp({
      isReady: async () => false,
      openVoiceDictation
    })
    const socket = openTestSocket(app.baseUrl)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_VOICE_UNAVAILABLE)
    expect(openVoiceDictation).not.toHaveBeenCalled()
  })

  it("closes 4503 when voice refuses the dictation handshake", async () => {
    const app = await createDictationApp({
      openVoiceDictation: () =>
        Promise.reject(new VoiceUnavailableError("refused"))
    })
    const socket = openTestSocket(app.baseUrl)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_VOICE_UNAVAILABLE)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Voice refused a dictation", {
        err: expect.objectContaining({ message: "refused" })
      })
    )
  })

  it("closes 1011 and logs the cause when the handshake with voice fails for another reason than a refusal", async () => {
    const app = await createDictationApp({
      openVoiceDictation: () => Promise.reject(new Error("connect ECONNRESET"))
    })
    const socket = openTestSocket(app.baseUrl)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
    expect(app.log.records).toContainEqual(
      matchLogEntry("error", "Dictation could not reach voice", {
        err: expect.objectContaining({ message: "connect ECONNRESET" })
      })
    )
  })

  it("never dials voice when the UI closes its socket during the health check", async () => {
    const openVoiceDictation = vi.fn(createFakeVoice().openVoiceDictation)
    const health = Promise.withResolvers<boolean>()
    const isReady = vi.fn(() => health.promise)
    const app = await createDictationApp({ isReady, openVoiceDictation })
    const socket = openTestSocket(app.baseUrl)
    await vi.waitFor(() => expect(isReady).toHaveBeenCalled())
    socket.close()
    await socket.closed
    health.resolve(true)
    await waitForMicrotasks()

    expect(openVoiceDictation).not.toHaveBeenCalled()
  })

  it("cancels a dictation voice accepts after the UI closed its socket", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await vi.waitFor(() => expect(pending.isDialed()).toBe(true))
    socket.close()
    await socket.closed
    const voice = pending.resolveHandshake()

    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
    expect(voice.isStarted).toBe(false)
  })

  it("closes 1002 for a bad text message sent before voice accepted, and cancels the dictation voice accepts later", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await socket.opened
    socket.send("not a dictation message")

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_PROTOCOL_ERROR)
    await vi.waitFor(() => expect(pending.isDialed()).toBe(true))
    const voice = pending.resolveHandshake()
    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
    expect(voice.isStarted).toBe(false)
  })

  it.each(['{"type":"transcribe"}', '{"type":"stop","extra":1}', "stop"])(
    "closes 1002 and cancels the dictation for the text message %s",
    async (message) => {
      const { app, socket, voice } = await openDictation()
      socket.send(message)

      await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_PROTOCOL_ERROR)
      expect(voice.isCancelled).toBe(true)
      expect(app.log.records).toContainEqual(
        matchLogEntry(
          "warn",
          "Dictation socket sent a text message that is not stop"
        )
      )
    }
  )

  it.each([
    ["empty", 0],
    ["not whole samples", 3]
  ])(
    "closes 1002, relaying nothing, for audio that is %s",
    async (_fault, byteLength) => {
      const { app, socket, voice } = await openDictation()
      socket.send(Buffer.alloc(byteLength))

      await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_PROTOCOL_ERROR)
      expect(voice.audio).toEqual([])
      expect(voice.isCancelled).toBe(true)
      expect(app.log.records).toContainEqual(
        matchLogEntry(
          "warn",
          "Dictation socket sent audio that is empty or not whole samples"
        )
      )
    }
  )

  it("closes 1002 for empty audio sent before voice accepted, and hands voice none of it", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await socket.opened
    socket.send(Buffer.alloc(0))

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_PROTOCOL_ERROR)
    await vi.waitFor(() => expect(pending.isDialed()).toBe(true))
    const voice = pending.resolveHandshake()
    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
    expect(voice.audio).toEqual([])
  })

  it("relays a message of exactly the size limit", async () => {
    const { socket, voice } = await openDictation()
    const audio = Buffer.alloc(SOCKET_MAX_CLIENT_MESSAGE_BYTES, 1)
    socket.send(audio)

    await vi.waitFor(() => expect(voice.audio).toEqual([audio]))
  })

  it("closes 1009 for a message one byte over the size limit", async () => {
    const { socket, voice } = await openDictation()
    socket.send(Buffer.alloc(SOCKET_MAX_CLIENT_MESSAGE_BYTES + 1))

    await expect(socket.closed).resolves.toBe(1009)
    expect(voice.audio).toEqual([])
    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
  })

  it("refuses a foreign origin before the upgrade with 403, and not the desktop's", async () => {
    const app = await createDictationApp(createFakeVoice())
    const url = `${app.baseUrl.replace(/^ws:/, "http:")}${voiceDictationApi.path}`
    const foreign = await fetch(url, {
      headers: { origin: "https://evil.example" }
    })
    const desktop = await fetch(url, {
      headers: { origin: "http://localhost:1420" }
    })

    expect(foreign.status).toBe(403)
    expect(desktop.status).not.toBe(403)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Voice socket refused a foreign origin", {
        origin: "https://evil.example"
      })
    )
  })
})

describe("dictation route failures and limits", () => {
  it.each([1011, 1000])(
    "closes 1011 when voice closes with %i before a final text",
    async (voiceCloseCode) => {
      const { app, socket, voice } = await openDictation()
      voice.closeFromVoice(voiceCloseCode)

      await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
      expect(app.log.records).toContainEqual(
        matchLogEntry("warn", "Voice ended a dictation that failed", {
          voiceCloseCode
        })
      )
    }
  )

  it.each([
    ["not json", "Voice sent a message that is not a dictation message"],
    [
      { type: "partial" },
      "Voice sent a message that is not a dictation message"
    ],
    [
      { type: "final", text: "Early." },
      "Voice sent a final text before the dictation stopped"
    ]
  ])(
    "closes 1011 and cancels the dictation when voice sends %j",
    async (message, logged) => {
      const { app, socket, voice } = await openDictation()
      voice.sendText(message)

      await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
      expect(voice.isCancelled).toBe(true)
      expect(socket.messages).toEqual([])
      expect(app.log.records).toContainEqual(matchLogEntry("error", logged))
    }
  )

  it("relays a text of 100,000 characters, the most a dictation message may carry", async () => {
    const { socket, voice } = await openDictation()
    const text = "a".repeat(100_000)
    voice.sendText({ type: "partial", text })

    await vi.waitFor(() =>
      expect(socket.messages).toEqual([{ type: "partial", text }])
    )
  })

  it("closes 1011, relaying nothing, when voice sends a text of 100,001 characters", async () => {
    const { app, socket, voice } = await openDictation()
    voice.sendText({ type: "partial", text: "a".repeat(100_001) })

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
    expect(voice.isCancelled).toBe(true)
    expect(socket.messages).toEqual([])
    expect(app.log.records).toContainEqual(
      matchLogEntry(
        "error",
        "Voice sent a message that is not a dictation message"
      )
    )
  })

  it("relays audio while exactly 1,000,000 bytes wait for voice", async () => {
    const { socket, voice } = await openDictation()
    voice.bufferedBytes = 1_000_000
    socket.send(AUDIO_FRAME)

    await vi.waitFor(() => expect(voice.audio).toEqual([AUDIO_FRAME]))
  })

  it("closes 1011 when voice falls behind the audio", async () => {
    const { app, socket, voice } = await openDictation()
    voice.bufferedBytes = 1_000_001
    socket.send(AUDIO_FRAME)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
    expect(voice.audio).toEqual([])
    expect(voice.isCancelled).toBe(true)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Voice fell behind a dictation's audio", {
        bufferedBytes: 1_000_001
      })
    )
  })

  it("closes 1011 when the UI falls behind the text", async () => {
    const { app, socket, voice } = await openDictation()
    const text = "word ".repeat(20_000)
    for (let count = 0; count < 40; count += 1)
      voice.sendText({ type: "partial", text })

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
    expect(voice.isCancelled).toBe(true)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Dictation socket fell behind its text", {
        bufferedBytes: expect.any(Number)
      })
    )
  })

  it("hands voice exactly five seconds of audio that waited for it", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await socket.opened
    for (let count = 0; count < 50; count += 1) socket.send(AUDIO_FRAME)
    await vi.waitFor(() => expect(app.getReceivedMessageCount()).toBe(50))
    await vi.waitFor(() => expect(pending.isDialed()).toBe(true))
    const voice = pending.resolveHandshake()

    await vi.waitFor(() => expect(voice.audio).toHaveLength(50))
    expect(voice.isStarted).toBe(true)
    expect(voice.isCancelled).toBe(false)
  })

  it("closes 1011 when more audio waits for voice than five seconds of it", async () => {
    const pending = createPendingVoice()
    const app = await createDictationApp(pending)
    const socket = openTestSocket(app.baseUrl)
    await socket.opened
    for (let count = 0; count < 51; count += 1) socket.send(AUDIO_FRAME)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Dictation audio waited too long for voice")
    )
    const voice = pending.resolveHandshake()
    await vi.waitFor(() => expect(voice.isCancelled).toBe(true))
    expect(voice.audio).toEqual([])
  })

  it("stops the dictation at voice once it reaches five minutes", async () => {
    useFakeRelayTimers()
    const { app, socket, voice } = await openDictation()
    vi.advanceTimersByTime(DICTATION_MAX_DURATION_MS - 10_000)
    expect(voice.isStopped).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(voice.isStopped).toBe(true)
    voice.sendText({ type: "final", text: "Long." })
    voice.closeFromVoice(1000)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_COMPLETE)
    expect(app.log.records).toContainEqual(
      matchLogEntry("info", "Dictation reached its time limit")
    )
  })

  it("closes 1011 when voice sends no final text within ten seconds of the stop", async () => {
    useFakeRelayTimers()
    const { app, socket, voice } = await openDictation()
    socket.send(STOP_MESSAGE)
    await vi.waitFor(() => expect(voice.isStopped).toBe(true))
    vi.advanceTimersByTime(8_000)
    expect(voice.isCancelled).toBe(false)
    vi.advanceTimersByTime(2_000)

    await expect(socket.closed).resolves.toBe(DICTATION_CLOSE_FAILED)
    expect(voice.isCancelled).toBe(true)
    expect(app.log.records).toContainEqual(
      matchLogEntry("warn", "Voice sent no final text in time")
    )
  })

  it("closes 1001 when the backend shuts down", async () => {
    const { app, socket, voice } = await openDictation()
    await app.app.close()

    await expect(socket.closed).resolves.toBe(SPEECH_CLOSE_SHUTDOWN)
    expect(voice.isCancelled).toBe(true)
  })
})
