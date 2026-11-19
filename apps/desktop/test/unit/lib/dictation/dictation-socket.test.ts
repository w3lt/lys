import { beforeEach, describe, expect, it, vi } from "vitest"
import { openDictationSocket } from "@/lib/dictation/dictation-socket"

/** One WebSocket the module under test opened. */
class FakeWebSocket {
  /** State of a socket that is still connecting. */
  public static readonly CONNECTING = 0
  /** State of an open socket. */
  public static readonly OPEN = 1
  /** State of a closed socket. */
  public static readonly CLOSED = 3
  /** Every socket opened, in order. */
  public static readonly opened: FakeWebSocket[] = []
  /** The socket's state. */
  public readyState = FakeWebSocket.CONNECTING
  /** Messages sent, in order. */
  public readonly sent: unknown[] = []
  /** Whether `close` ran. */
  public isClosed = false
  /** Its listeners, by event type. */
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>()

  /**
   * Records the socket.
   *
   * @param url - The URL it was opened with.
   */
  public constructor(public readonly url: string) {
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

  /**
   * Sends a message.
   *
   * @param message - The message.
   */
  public send(message: unknown): void {
    this.sent.push(message)
  }

  /** Closes the socket from the client side. */
  public close(): void {
    this.isClosed = true
  }

  /**
   * Delivers an event to its listeners, as the platform does.
   *
   * @param type - Event type.
   * @param event - The event.
   */
  public sendEvent(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  /** Opens the socket, as the platform does once it connected. */
  public open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.sendEvent("open")
  }
}

/**
 * Opens a dictation socket over the fake platform.
 *
 * @returns The socket, its fake, and what its handlers received.
 */
function openSocket() {
  const texts: string[] = []
  const closeCodes: number[] = []
  const socket = openDictationSocket("ws://127.0.0.1:1/dictation", {
    onText: (text) => texts.push(text),
    onClose: (code) => closeCodes.push(code)
  })
  const [platform] = FakeWebSocket.opened
  if (platform === undefined) throw new Error("no socket was opened")
  return { socket, platform, texts, closeCodes }
}

/** One frame of dictation audio. */
const FRAME = new Uint8Array([1, 2, 3, 4])

beforeEach(() => {
  FakeWebSocket.opened.length = 0
  vi.stubGlobal("WebSocket", FakeWebSocket)
})

describe("openDictationSocket", () => {
  it("opens the URL it is given", () => {
    expect(openSocket().platform.url).toBe("ws://127.0.0.1:1/dictation")
  })

  it("sends audio and the stop message on an open socket", () => {
    const { socket, platform } = openSocket()
    platform.open()
    socket.sendAudio(FRAME)
    socket.sendStop()

    expect(platform.sent).toEqual([FRAME, '{"type":"stop"}'])
  })

  it("keeps what is sent while it connects, and sends it in order once it opens", () => {
    const { socket, platform } = openSocket()
    socket.sendAudio(FRAME)
    socket.sendStop()
    expect(platform.sent).toEqual([])
    platform.open()

    expect(platform.sent).toEqual([FRAME, '{"type":"stop"}'])
  })

  it("keeps at most five seconds of audio while it connects", () => {
    const { socket, platform } = openSocket()
    for (let count = 0; count < 60; count += 1) socket.sendAudio(FRAME)
    platform.open()

    expect(platform.sent).toHaveLength(50)
  })

  it("drops what is sent once it is closed", () => {
    const { socket, platform } = openSocket()
    platform.readyState = FakeWebSocket.CLOSED
    socket.sendAudio(FRAME)
    socket.sendStop()
    platform.open()

    expect(platform.sent).toEqual([])
  })

  it("reports each text message, and ignores a binary one", () => {
    const { platform, texts } = openSocket()
    platform.sendEvent("message", { data: '{"type":"partial","text":"a"}' })
    platform.sendEvent("message", { data: new ArrayBuffer(2) })

    expect(texts).toEqual(['{"type":"partial","text":"a"}'])
  })

  it("reports the close with its code", () => {
    const { platform, closeCodes } = openSocket()
    platform.sendEvent("close", { code: 4503 })

    expect(closeCodes).toEqual([4503])
  })

  it("closes the platform's socket", () => {
    const { socket, platform } = openSocket()
    socket.close()

    expect(platform.isClosed).toBe(true)
  })
})
