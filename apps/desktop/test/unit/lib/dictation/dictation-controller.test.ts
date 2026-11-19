import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  DictationController,
  FINAL_TEXT_WAIT_MS,
  type DictationSocketHandlers,
  type DictationView
} from "@/lib/dictation/dictation-controller"
import {
  MicrophoneError,
  type MicrophoneRecorder,
  type MicrophoneRecorderOptions
} from "@/lib/dictation/microphone-recorder"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** One frame of dictation audio. */
const FRAME = new Uint8Array(3_200)

/** The dictation socket the controller opened, as the test drives it. */
type FakeSocket = {
  /** Frames the controller sent, in order. */
  readonly audio: Uint8Array[]
  /** How many times `stop` was sent. */
  stops: number
  /** Whether the controller closed the socket. */
  isClosed: boolean
  /** The controller's handlers, to play the backend. */
  readonly handlers: DictationSocketHandlers
}

/** The microphone the controller asked for, as the test drives it. */
type FakeMicrophone = {
  /** What the controller started the recording with. */
  readonly options: MicrophoneRecorderOptions
  /** Whether the recording was stopped. */
  isStopped: boolean
  /** Opens the microphone, as the platform does once access is granted. */
  open: () => void
  /** Fails the start, as the platform does. */
  fail: (error: unknown) => void
}

/** A controller over fakes, with everything it did. */
type ControllerHarness = {
  /** The controller under test. */
  readonly controller: DictationController
  /** The composer's draft. */
  draft: string
  /** Whether Lys may listen. */
  canListen: boolean
  /** Sockets opened, in order. */
  readonly sockets: FakeSocket[]
  /** Microphones asked for, in order. */
  readonly microphones: FakeMicrophone[]
  /** Views published, in order. */
  readonly views: DictationView[]
  /** How many times voice's status was read again. */
  voiceReads: number
}

/**
 * Creates a controller over a fake draft, socket, and microphone.
 *
 * @param draft - The composer's draft before the dictation.
 * @returns The harness.
 */
function createHarness(draft = ""): ControllerHarness {
  const harness: ControllerHarness = {
    draft,
    canListen: true,
    sockets: [],
    microphones: [],
    views: [],
    voiceReads: 0,
    controller: new DictationController({
      canListen: () => harness.canListen,
      readDraft: () => harness.draft,
      writeDraft: (written) => {
        harness.draft = written
      },
      startRecorder: (options) => startFakeMicrophone(harness, options),
      openSocket: (handlers) => {
        const socket: FakeSocket = {
          audio: [],
          stops: 0,
          isClosed: false,
          handlers
        }
        harness.sockets.push(socket)
        return {
          sendAudio: (frame) => socket.audio.push(frame),
          sendStop: () => {
            socket.stops += 1
          },
          close: () => {
            socket.isClosed = true
          }
        }
      },
      updateVoiceServerInfo: () => {
        harness.voiceReads += 1
      },
      onViewChange: (view) => harness.views.push(view)
    })
  }
  return harness
}

/**
 * Starts a fake recording that the test opens or fails.
 *
 * @param harness - The harness that records the microphone.
 * @param options - What the controller started the recording with.
 * @returns The recording, once the test opens the microphone.
 */
function startFakeMicrophone(
  harness: ControllerHarness,
  options: MicrophoneRecorderOptions
): Promise<MicrophoneRecorder> {
  const started = createControlledPromise<MicrophoneRecorder>()
  const microphone: FakeMicrophone = {
    options,
    isStopped: false,
    open: () => {
      started.resolve({
        stop: () => {
          microphone.isStopped = true
        }
      })
    },
    fail: (error) => {
      started.reject(error)
    }
  }
  harness.microphones.push(microphone)
  return started.promise
}

/**
 * Starts a dictation and opens its microphone.
 *
 * @param draft - The composer's draft before the dictation.
 * @param cursor - Where the cursor is; the draft's end when omitted.
 * @returns The harness with its first socket and microphone.
 */
async function startListening(draft = "", cursor = draft.length) {
  const harness = createHarness(draft)
  harness.controller.toggle(cursor)
  const [socket] = harness.sockets
  const [microphone] = harness.microphones
  if (socket === undefined || microphone === undefined)
    throw new Error("the dictation did not start")
  microphone.open()
  await waitForMicrotasks()
  return { harness, socket, microphone }
}

/**
 * Sends one dictation message from the fake backend.
 *
 * @param socket - The socket to send on.
 * @param type - Kind of update.
 * @param text - Everything dictated so far.
 */
function sendUpdate(
  socket: FakeSocket,
  type: "partial" | "final",
  text: string
): void {
  socket.handlers.onText(JSON.stringify({ type, text }))
}

/** Freezes timers until the test ends. */
function startFakeTimers(): void {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

describe("DictationController start", () => {
  it("opens the socket and asks for the microphone on the first press, and listens once it is open", async () => {
    const harness = createHarness()
    harness.controller.toggle(0)

    expect(harness.sockets).toHaveLength(1)
    expect(harness.microphones).toHaveLength(1)
    expect(harness.views.at(-1)?.status).toBe("starting")
    harness.microphones[0]?.open()
    await waitForMicrotasks()
    expect(harness.views.at(-1)).toEqual({
      status: "listening",
      notice: undefined,
      isAtDraftEnd: true
    })
  })

  it("starts nothing while Lys may not listen", () => {
    const harness = createHarness()
    harness.canListen = false
    harness.controller.toggle(0)

    expect(harness.sockets).toEqual([])
    expect(harness.microphones).toEqual([])
    expect(harness.views).toEqual([])
  })

  it("sends each frame of the open microphone to the socket", async () => {
    const { socket, microphone } = await startListening()
    microphone.options.onFrame(FRAME)
    microphone.options.onFrame(FRAME)

    expect(socket.audio).toEqual([FRAME, FRAME])
  })

  it("cancels the start on a second press before the microphone is open, and releases a microphone that opens late", async () => {
    const harness = createHarness()
    harness.controller.toggle(0)
    harness.controller.toggle(0)

    expect(harness.views.at(-1)?.status).toBe("idle")
    expect(harness.sockets[0]?.isClosed).toBe(true)
    expect(harness.microphones[0]?.options.signal.aborted).toBe(true)
    harness.microphones[0]?.open()
    await waitForMicrotasks()
    expect(harness.microphones[0]?.isStopped).toBe(true)
    expect(harness.views.at(-1)?.status).toBe("idle")
  })

  it.each([
    ["denied", "microphone-denied"],
    ["missing", "microphone-missing"],
    ["failed", "microphone-failed"]
  ] as const)(
    "ends with a notice when the microphone is %s",
    async (kind, notice) => {
      const harness = createHarness("typed")
      harness.controller.toggle(5)
      harness.microphones[0]?.fail(new MicrophoneError(kind))
      await waitForMicrotasks()

      expect(harness.views.at(-1)).toEqual({
        status: "idle",
        notice,
        isAtDraftEnd: false
      })
      expect(harness.sockets[0]?.isClosed).toBe(true)
      expect(harness.draft).toBe("typed")
    }
  )

  it("ends with the microphone-failed notice for a failure that is not a microphone error", async () => {
    const harness = createHarness()
    harness.controller.toggle(0)
    harness.microphones[0]?.fail(new Error("worklet"))
    await waitForMicrotasks()

    expect(harness.views.at(-1)?.notice).toBe("microphone-failed")
  })

  it("clears the last notice when the next dictation starts", async () => {
    const harness = createHarness()
    harness.controller.toggle(0)
    harness.microphones[0]?.fail(new MicrophoneError("denied"))
    await waitForMicrotasks()
    harness.controller.toggle(0)

    expect(harness.views.at(-1)).toEqual({
      status: "starting",
      notice: undefined,
      isAtDraftEnd: true
    })
  })

  it("says whether the dictation writes at the draft's end", () => {
    const harness = createHarness("Hello world")
    harness.controller.toggle(5)

    expect(harness.views.at(-1)?.isAtDraftEnd).toBe(false)
  })
})

describe("DictationController text", () => {
  it("writes each update where the cursor was, keeping what was typed", async () => {
    const { harness, socket } = await startListening("Dear Ana, bye", 9)
    sendUpdate(socket, "partial", "thanks for")
    expect(harness.draft).toBe("Dear Ana, thanks for bye")
    sendUpdate(socket, "partial", "Thanks for the note.")

    expect(harness.draft).toBe("Dear Ana, Thanks for the note. bye")
  })

  it("stops on a press while listening: releases the microphone, sends stop, and waits for the final text", async () => {
    const { harness, socket, microphone } = await startListening()
    harness.controller.toggle(0)

    expect(microphone.isStopped).toBe(true)
    expect(socket.stops).toBe(1)
    expect(socket.isClosed).toBe(false)
    expect(harness.views.at(-1)?.status).toBe("stopping")
  })

  it("sends no frame after the stop", async () => {
    const { harness, socket, microphone } = await startListening()
    harness.controller.stop()
    microphone.options.onFrame(FRAME)

    expect(socket.audio).toEqual([])
  })

  it("writes the final text and ends without a notice", async () => {
    const { harness, socket } = await startListening("Note:")
    sendUpdate(socket, "partial", "by milk")
    harness.controller.stop()
    sendUpdate(socket, "final", "Buy milk.")

    expect(harness.draft).toBe("Note: Buy milk.")
    expect(socket.isClosed).toBe(true)
    expect(harness.views.at(-1)).toEqual({
      status: "idle",
      notice: undefined,
      isAtDraftEnd: false
    })
  })

  it("ignores a press while the final text is awaited", async () => {
    const { harness, socket } = await startListening()
    harness.controller.stop()
    harness.controller.toggle(0)

    expect(socket.stops).toBe(1)
    expect(harness.sockets).toHaveLength(1)
    expect(harness.views.at(-1)?.status).toBe("stopping")
  })

  it("keeps the last partial and ends when no final text arrives in five seconds", async () => {
    startFakeTimers()
    const { harness, socket } = await startListening()
    sendUpdate(socket, "partial", "so far")
    harness.controller.stop()
    vi.advanceTimersByTime(FINAL_TEXT_WAIT_MS - 1)
    expect(harness.views.at(-1)?.status).toBe("stopping")
    vi.advanceTimersByTime(1)

    expect(harness.draft).toBe("so far")
    expect(socket.isClosed).toBe(true)
    expect(harness.views.at(-1)).toEqual({
      status: "idle",
      notice: undefined,
      isAtDraftEnd: false
    })
  })

  it("releases the microphone when the final text arrives while listening, as at the time limit", async () => {
    const { harness, socket, microphone } = await startListening()
    sendUpdate(socket, "final", "All of it.")

    expect(microphone.isStopped).toBe(true)
    expect(harness.draft).toBe("All of it.")
    expect(harness.views.at(-1)?.status).toBe("idle")
  })

  it("writes nothing for a message that arrives after the dictation ended", async () => {
    const { harness, socket } = await startListening()
    harness.controller.stop()
    sendUpdate(socket, "final", "Done.")
    sendUpdate(socket, "partial", "late")
    socket.handlers.onClose(1000)

    expect(harness.draft).toBe("Done.")
    expect(harness.views.at(-1)?.notice).toBeUndefined()
  })

  it.each(["not json", '{"type":"partial"}', '{"type":"speak","text":"x"}'])(
    "ends with the stopped notice for the message %s",
    async (message) => {
      const { harness, socket, microphone } = await startListening("typed")
      socket.handlers.onText(message)

      expect(harness.draft).toBe("typed")
      expect(microphone.isStopped).toBe(true)
      expect(harness.views.at(-1)?.notice).toBe("stopped")
    }
  )
})

describe("DictationController endings", () => {
  it.each([
    [4503, "voice-not-ready", 1],
    [1011, "voice-stopped", 1],
    [1006, "stopped", 0],
    [4409, "stopped", 0],
    [1001, "stopped", 0]
  ] as const)(
    "keeps the text so far and ends with a notice when the socket closes with %i",
    async (code, notice, voiceReads) => {
      const { harness, socket, microphone } = await startListening()
      sendUpdate(socket, "partial", "so far")
      socket.handlers.onClose(code)

      expect(harness.draft).toBe("so far")
      expect(microphone.isStopped).toBe(true)
      expect(harness.voiceReads).toBe(voiceReads)
      expect(harness.views.at(-1)).toEqual({
        status: "idle",
        notice,
        isAtDraftEnd: false
      })
    }
  )

  it("ends a start with the voice-not-ready notice when the socket closes with 4503, and cancels the microphone", async () => {
    const harness = createHarness()
    harness.controller.toggle(0)
    harness.sockets[0]?.handlers.onClose(4503)

    expect(harness.views.at(-1)?.notice).toBe("voice-not-ready")
    expect(harness.microphones[0]?.options.signal.aborted).toBe(true)
  })

  it("ends the wait for the final text when the socket closes first", async () => {
    startFakeTimers()
    const { harness, socket } = await startListening()
    harness.controller.stop()
    socket.handlers.onClose(1011)
    vi.advanceTimersByTime(FINAL_TEXT_WAIT_MS)

    expect(harness.views.at(-1)).toEqual({
      status: "idle",
      notice: "voice-stopped",
      isAtDraftEnd: false
    })
    expect(harness.views.filter((view) => view.status === "idle")).toHaveLength(
      1
    )
  })

  it("stops as a press does, with the stopped notice, when the microphone ends on its own", async () => {
    const { harness, socket, microphone } = await startListening()
    microphone.options.onEnded()

    expect(socket.stops).toBe(1)
    expect(harness.views.at(-1)).toEqual({
      status: "stopping",
      notice: "stopped",
      isAtDraftEnd: true
    })
    sendUpdate(socket, "final", "Heard.")
    expect(harness.draft).toBe("Heard.")
    expect(harness.views.at(-1)?.notice).toBe("stopped")
  })

  it("cancels at once: releases everything, clears the notice, and writes nothing more", async () => {
    const { harness, socket, microphone } = await startListening("typed")
    harness.controller.cancel()
    sendUpdate(socket, "partial", "late")
    microphone.options.onFrame(FRAME)

    expect(microphone.isStopped).toBe(true)
    expect(socket.isClosed).toBe(true)
    expect(socket.stops).toBe(0)
    expect(socket.audio).toEqual([])
    expect(harness.draft).toBe("typed")
    expect(harness.views.at(-1)).toEqual({
      status: "idle",
      notice: undefined,
      isAtDraftEnd: false
    })
  })

  it("clears a notice on cancel while nothing runs", async () => {
    const { harness, socket } = await startListening()
    socket.handlers.onClose(1011)
    harness.controller.cancel()

    expect(harness.views.at(-1)?.notice).toBeUndefined()
  })

  it("cancels when something else changed the draft, and not for its own writes", async () => {
    const { harness, socket, microphone } = await startListening("typed")
    sendUpdate(socket, "partial", "words")
    harness.controller.handleDraftChange(harness.draft)
    expect(harness.views.at(-1)?.status).toBe("listening")
    harness.controller.handleDraftChange("")

    expect(microphone.isStopped).toBe(true)
    expect(harness.views.at(-1)?.status).toBe("idle")
  })

  it("does nothing on stop, cancel, or a draft change while nothing runs", () => {
    const harness = createHarness()
    harness.controller.stop()
    harness.controller.cancel()
    harness.controller.handleDraftChange("typed")

    expect(harness.views).toEqual([])
  })

  it("starts a new dictation after one ended, on its own socket", async () => {
    const { harness, socket } = await startListening()
    harness.controller.stop()
    sendUpdate(socket, "final", "One.")
    harness.controller.toggle(harness.draft.length)
    harness.microphones[1]?.open()
    await waitForMicrotasks()
    const second = harness.sockets[1]
    if (second === undefined) throw new Error("no second socket")
    sendUpdate(second, "partial", "Two.")

    expect(harness.draft).toBe("One. Two.")
  })
})
