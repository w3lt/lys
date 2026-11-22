import { createServer, type Socket } from "node:net"
import fastifyWebsocket from "@fastify/websocket"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { WebSocket as ServerSocket } from "ws"
import {
  openVoiceDictation,
  openVoiceSpeech,
  isVoiceReady,
  VoiceUnavailableError,
  type VoiceDictationHandlers,
  type VoiceSpeechHandlers
} from "../../../../src/modules/voice/voiceClient"
import { createTestFastify } from "../../support/fastifyTestApp"

/** What a fake voice server saw from the backend. */
type FakeVoiceServer = Readonly<{
  /** URL of its socket. */
  url: string
  /** Text messages received, parsed, in order. */
  messages: unknown[]
  /** Binary messages received, in order. */
  audio: Buffer[]
  /** Resolves with the socket once the backend connected. */
  connected: Promise<ServerSocket>
  /** Resolves once the backend's socket closed. */
  closed: Promise<void>
}>

/**
 * Records one message the fake voice received: a text message parsed, and a
 * binary one as its bytes.
 */
function addReceivedMessage(
  received: Pick<FakeVoiceServer, "messages" | "audio">,
  data: unknown,
  isBinary: boolean
): void {
  if (!isBinary) received.messages.push(JSON.parse(String(data)))
  else if (Buffer.isBuffer(data)) received.audio.push(data)
}

/**
 * Starts a fake voice speech server on an ephemeral port.
 *
 * @param refuse - Whether to refuse every upgrade with `403`.
 */
async function startFakeVoice(
  refuse: "accept" | "refuse" = "accept"
): Promise<FakeVoiceServer> {
  const { app } = createTestFastify()
  await app.register(fastifyWebsocket)
  const messages: unknown[] = []
  const audio: Buffer[] = []
  const connected = Promise.withResolvers<ServerSocket>()
  const closed = Promise.withResolvers<void>()
  app.get(
    "/",
    {
      websocket: true,
      preValidation: (_request, reply, done) => {
        if (refuse === "refuse") void reply.code(403).send()
        else done()
      }
    },
    (socket: ServerSocket) => {
      socket.on("message", (data, isBinary) =>
        addReceivedMessage({ messages, audio }, data, isBinary)
      )
      socket.on("close", () => closed.resolve())
      connected.resolve(socket)
    }
  )
  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  const port =
    typeof address === "object" && address !== null ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}/`,
    messages,
    audio,
    connected: connected.promise,
    closed: closed.promise
  }
}

/** A TCP server that accepts connections and never answers them. */
type SilentServer = Readonly<{
  /** Connections accepted so far. */
  sockets: Socket[]
  /** Port it listens on. */
  port: number
}>

/** Starts a silent server, closed with its connections when the test ends. */
async function startSilentServer(): Promise<SilentServer> {
  const sockets: Socket[] = []
  const server = createServer((socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(() => {
    sockets.forEach((socket) => socket.destroy())
    server.close()
  })
  const address = server.address()
  const port =
    typeof address === "object" && address !== null ? address.port : 0
  return { sockets, port }
}

/** Handlers that record what voice sent. */
function createRecordingHandlers(): VoiceSpeechHandlers &
  Readonly<{ frames: Buffer[]; closeCodes: number[] }> {
  const frames: Buffer[] = []
  const closeCodes: number[] = []
  return {
    frames,
    closeCodes,
    onAudio: (pcm) => frames.push(pcm),
    onClose: (code) => closeCodes.push(code)
  }
}

describe("isVoiceReady", () => {
  it("asks voice's health route and is ready on 200", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(isVoiceReady(fetchImpl)).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9090/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("is not ready while voice answers anything but 200", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    await expect(isVoiceReady(fetchImpl)).resolves.toBe(false)
  })

  it("is not ready when voice cannot be reached or times out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    })
    await expect(isVoiceReady(fetchImpl)).resolves.toBe(false)
  })
})

describe("openVoiceSpeech", () => {
  it("sends the speech messages and relays frames and the close", async () => {
    const voice = await startFakeVoice()
    const handlers = createRecordingHandlers()
    const speech = await openVoiceSpeech(handlers, voice.url)
    const socket = await voice.connected
    speech.start()
    speech.sendText("Hello there.")
    speech.sendFinish()
    await vi.waitFor(() => expect(voice.messages).toHaveLength(3))
    expect(voice.messages).toEqual([
      { type: "speak" },
      { type: "text", text: "Hello there." },
      { type: "finish" }
    ])
    socket.send(Buffer.from([1, 2, 3, 4]))
    await vi.waitFor(() => expect(handlers.frames).toHaveLength(1))
    expect([...(handlers.frames[0] ?? [])]).toEqual([1, 2, 3, 4])
    socket.close(1000)
    await vi.waitFor(() => expect(handlers.closeCodes).toEqual([1000]))
  })

  it("hangs up on cancel", async () => {
    const voice = await startFakeVoice()
    const speech = await openVoiceSpeech(createRecordingHandlers(), voice.url)
    await voice.connected
    speech.cancel()
    await expect(voice.closed).resolves.toBeUndefined()
  })

  it("fails with VoiceUnavailableError when voice refuses the handshake", async () => {
    const voice = await startFakeVoice("refuse")
    const handlers = createRecordingHandlers()
    await expect(openVoiceSpeech(handlers, voice.url)).rejects.toBeInstanceOf(
      VoiceUnavailableError
    )
    expect(handlers.closeCodes).toEqual([])
  })

  it("fails with VoiceUnavailableError when voice never answers", async () => {
    const { sockets, port } = await startSilentServer()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const handlers = createRecordingHandlers()
    const speech = openVoiceSpeech(handlers, `ws://127.0.0.1:${port}/`)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    vi.advanceTimersByTime(2_000)
    await expect(speech).rejects.toBeInstanceOf(VoiceUnavailableError)
    expect(handlers.closeCodes).toEqual([])
  })
})

/** Handlers that record what voice sent on a dictation. */
function createRecordingDictationHandlers(): VoiceDictationHandlers &
  Readonly<{ texts: string[]; closeCodes: number[] }> {
  const texts: string[] = []
  const closeCodes: number[] = []
  return {
    texts,
    closeCodes,
    onText: (text) => texts.push(text),
    onClose: (code) => closeCodes.push(code)
  }
}

describe("openVoiceDictation", () => {
  it("sends the dictation messages and the audio, and relays text and the close", async () => {
    const voice = await startFakeVoice()
    const handlers = createRecordingDictationHandlers()
    const dictation = await openVoiceDictation(handlers, voice.url)
    const socket = await voice.connected
    dictation.start()
    dictation.sendAudio(Buffer.from([1, 2, 3, 4]))
    dictation.sendStop()
    await vi.waitFor(() => expect(voice.messages).toHaveLength(2))
    expect(voice.messages).toEqual([{ type: "transcribe" }, { type: "stop" }])
    expect(voice.audio).toEqual([Buffer.from([1, 2, 3, 4])])
    socket.send(JSON.stringify({ type: "final", text: "Hello." }))
    await vi.waitFor(() => expect(handlers.texts).toHaveLength(1))
    expect(handlers.texts).toEqual(['{"type":"final","text":"Hello."}'])
    socket.close(1000)
    await vi.waitFor(() => expect(handlers.closeCodes).toEqual([1000]))
  })

  it("ignores a binary frame, which voice never sends on a dictation", async () => {
    const voice = await startFakeVoice()
    const handlers = createRecordingDictationHandlers()
    await openVoiceDictation(handlers, voice.url)
    const socket = await voice.connected
    socket.send(Buffer.from([1, 2]))
    socket.send("after")
    await vi.waitFor(() => expect(handlers.texts).toEqual(["after"]))
  })

  it("counts the bytes voice has not taken yet", async () => {
    const voice = await startFakeVoice()
    const dictation = await openVoiceDictation(
      createRecordingDictationHandlers(),
      voice.url
    )
    await voice.connected
    expect(dictation.getBufferedBytes()).toBe(0)
    dictation.sendAudio(Buffer.alloc(3_200))
    expect(dictation.getBufferedBytes()).toBeGreaterThanOrEqual(3_200)
  })

  it("hangs up on cancel, and drops what is sent afterwards", async () => {
    const voice = await startFakeVoice()
    const dictation = await openVoiceDictation(
      createRecordingDictationHandlers(),
      voice.url
    )
    await voice.connected
    dictation.cancel()
    dictation.sendAudio(Buffer.from([1, 2]))
    dictation.sendStop()
    await expect(voice.closed).resolves.toBeUndefined()
    expect(voice.messages).toEqual([])
    expect(voice.audio).toEqual([])
  })

  it("fails with VoiceUnavailableError when voice refuses the handshake", async () => {
    const voice = await startFakeVoice("refuse")
    const handlers = createRecordingDictationHandlers()
    await expect(
      openVoiceDictation(handlers, voice.url)
    ).rejects.toBeInstanceOf(VoiceUnavailableError)
    expect(handlers.closeCodes).toEqual([])
  })
})
