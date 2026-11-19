import { describe, expect, it } from "vitest"
import { openDictationSocket } from "@/lib/dictation/dictation-socket"
import {
  FakeWebSocket,
  getDictationSocket,
  startDictationPlatformFake
} from "../../support/dictationPlatformFake"

/**
 * Opens a dictation socket over the fake platform.
 *
 * @returns The socket, its fake, and what its handlers received.
 */
function openSocket() {
  const texts: string[] = []
  const closeCodes: number[] = []
  const fake = startDictationPlatformFake()
  const socket = openDictationSocket("ws://127.0.0.1:1/dictation", {
    onText: (text) => texts.push(text),
    onClose: (code) => closeCodes.push(code)
  })
  return { socket, platform: getDictationSocket(fake), texts, closeCodes }
}

/** One frame of dictation audio. */
const FRAME = new Uint8Array([1, 2, 3, 4])

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
