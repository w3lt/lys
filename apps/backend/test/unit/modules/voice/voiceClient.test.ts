import { createServer, type Socket } from "node:net"
import fastifyWebsocket from "@fastify/websocket"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { WebSocket as ServerSocket } from "ws"
import {
  connectVoiceSpeech,
  isVoiceReady,
  VoiceUnavailableError,
  type VoiceSpeechHandlers
} from "../../../../src/modules/voice/voiceClient"
import { createTestFastify } from "../../support/fastifyTestApp"

/** What a fake voice server saw from the backend. */
type FakeVoiceServer = Readonly<{
  /** URL of its speech socket. */
  url: string
  /** Text messages received, parsed, in order. */
  messages: unknown[]
  /** Resolves with the socket once the backend connected. */
  connected: Promise<ServerSocket>
  /** Resolves once the backend's socket closed. */
  closed: Promise<void>
}>

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
      socket.on("message", (data) => messages.push(JSON.parse(String(data))))
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

describe("connectVoiceSpeech", () => {
  it("sends the speech messages and relays frames and the close", async () => {
    const voice = await startFakeVoice()
    const handlers = createRecordingHandlers()
    const speech = await connectVoiceSpeech(handlers, voice.url)
    const socket = await voice.connected
    speech.speak()
    speech.speakText("Hello there.")
    speech.finish()
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
    const speech = await connectVoiceSpeech(
      createRecordingHandlers(),
      voice.url
    )
    await voice.connected
    speech.cancel()
    await expect(voice.closed).resolves.toBeUndefined()
  })

  it("fails with VoiceUnavailableError when voice refuses the handshake", async () => {
    const voice = await startFakeVoice("refuse")
    const handlers = createRecordingHandlers()
    await expect(
      connectVoiceSpeech(handlers, voice.url)
    ).rejects.toBeInstanceOf(VoiceUnavailableError)
    expect(handlers.closeCodes).toEqual([])
  })

  it("fails with VoiceUnavailableError when voice never answers", async () => {
    const { sockets, port } = await startSilentServer()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const handlers = createRecordingHandlers()
    const speech = connectVoiceSpeech(handlers, `ws://127.0.0.1:${port}/`)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    vi.advanceTimersByTime(2_000)
    await expect(speech).rejects.toBeInstanceOf(VoiceUnavailableError)
    expect(handlers.closeCodes).toEqual([])
  })
})
