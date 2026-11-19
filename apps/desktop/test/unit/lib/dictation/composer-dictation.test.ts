import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  ComposerDictation,
  type DictationSocket,
  type DictationSocketHandlers,
  type DictationView
} from "@/lib/dictation/composer-dictation"
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

/** The dictation socket the dictation opened, as the test drives it. */
type FakeSocket = {
  /** Frames the dictation sent, in order. */
  readonly audio: Uint8Array[]
  /** How many times `stop` was sent. */
  stops: number
  /** Whether the dictation closed the socket. */
  isClosed: boolean
  /**
   * The dictation's handlers, to play the backend; the close is reported to
   * the dictation once.
   */
  readonly handlers: DictationSocketHandlers
}

/** The microphone the dictation asked for, as the test drives it. */
type FakeMicrophone = {
  /** What the dictation started the recording with. */
  readonly options: MicrophoneRecorderOptions
  /** Whether the recording was stopped. */
  isStopped: boolean
  /** Opens the microphone, as the platform does once access is granted. */
  open: () => void
  /** Rejects the start, as the platform does. */
  reject: (error: unknown) => void
}

/** A composer's dictation over fakes, with everything it did. */
type DictationHarness = {
  /** The composer's dictation under test. */
  readonly dictation: ComposerDictation
  /** The composer's draft. */
  draft: string
  /** Sockets opened, in order. */
  readonly sockets: FakeSocket[]
  /** Microphones asked for, in order. */
  readonly microphones: FakeMicrophone[]
  /** Views sent, in order. */
  readonly views: DictationView[]
}

/**
 * Creates a composer's dictation over a fake draft, socket, and microphone.
 *
 * @param draft - The composer's draft before the dictation.
 * @returns The harness.
 */
function createHarness(draft = ""): DictationHarness {
  const harness: DictationHarness = {
    draft,
    sockets: [],
    microphones: [],
    views: [],
    dictation: new ComposerDictation({
      getDraft: () => harness.draft,
      updateDraft: (written) => {
        harness.draft = written
      },
      startRecorder: (options) => startFakeMicrophone(harness, options),
      openSocket: (handlers) => openFakeSocket(harness, handlers),
      onViewChange: (view) => harness.views.push(view)
    })
  }
  return harness
}

/**
 * Opens a fake dictation socket that the test drives.
 *
 * @param harness - The harness that records the socket.
 * @param handlers - The dictation's handlers.
 * @returns The socket as the dictation drives it. Like the real one, it
 * reports its close once: with the code the test gives as the backend, or
 * with `1005` after the dictation closed it, and then never inside the call
 * that closed it.
 */
function openFakeSocket(
  harness: DictationHarness,
  handlers: DictationSocketHandlers
): DictationSocket {
  let isCloseSent = false

  /**
   * Reports the socket's close to the dictation, the first time only.
   *
   * @param code - The close code.
   */
  function sendClose(code: number): void {
    if (isCloseSent) return
    isCloseSent = true
    handlers.onClose(code)
  }

  const socket: FakeSocket = {
    audio: [],
    stops: 0,
    isClosed: false,
    handlers: { onText: handlers.onText, onClose: sendClose }
  }
  harness.sockets.push(socket)
  return {
    sendAudio: (frame) => socket.audio.push(frame),
    sendStop: () => {
      socket.stops += 1
    },
    close: () => {
      socket.isClosed = true
      queueMicrotask(() => {
        sendClose(1005)
      })
    }
  }
}

/**
 * Starts a fake recording that the test opens or rejects.
 *
 * @param harness - The harness that records the microphone.
 * @param options - What the dictation started the recording with.
 * @returns The recording, once the test opens the microphone.
 */
function startFakeMicrophone(
  harness: DictationHarness,
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
    reject: (error) => {
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
  harness.dictation.handleButtonPress(cursor)
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

/**
 * Replaces the platform's `reportError` until the test ends.
 *
 * @returns The replacement, which records what is reported.
 */
function startErrorReportSpy(): ReturnType<typeof vi.fn> {
  const reportError = vi.fn()
  vi.stubGlobal("reportError", reportError)
  return reportError
}

/** Freezes timers until the test ends. */
function startFakeTimers(): void {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

describe("ComposerDictation start", () => {
  it("opens the socket and asks for the microphone on the first press, and listens once it is open", async () => {
    const harness = createHarness()
    harness.dictation.handleButtonPress(0)

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

  it("sends each frame of the open microphone to the socket", async () => {
    const { socket, microphone } = await startListening()
    microphone.options.onFrame(FRAME)
    microphone.options.onFrame(FRAME)

    expect(socket.audio).toEqual([FRAME, FRAME])
  })

  it("cancels the start on a second press before the microphone is open, and releases a microphone that opens late", async () => {
    const harness = createHarness()
    harness.dictation.handleButtonPress(0)
    harness.dictation.handleButtonPress(0)

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
    ["missing", "microphone-missing"]
  ] as const)(
    "ends with a notice, and reports nothing, when the microphone is %s",
    async (kind, notice) => {
      const reportError = startErrorReportSpy()
      const harness = createHarness("typed")
      harness.dictation.handleButtonPress(5)
      harness.microphones[0]?.reject(new MicrophoneError(kind))
      await waitForMicrotasks()

      expect(harness.views.at(-1)).toEqual({
        status: "idle",
        notice,
        isAtDraftEnd: false
      })
      expect(harness.sockets[0]?.isClosed).toBe(true)
      expect(harness.draft).toBe("typed")
      expect(reportError).not.toHaveBeenCalled()
    }
  )

  it("ends with the microphone-failed notice and reports the failure, with its cause, when the microphone could not be started", async () => {
    const reportError = startErrorReportSpy()
    const harness = createHarness("typed")
    const failure = new MicrophoneError("failed", {
      cause: new Error("worklet")
    })
    harness.dictation.handleButtonPress(5)
    harness.microphones[0]?.reject(failure)
    await waitForMicrotasks()

    expect(harness.views.at(-1)).toEqual({
      status: "idle",
      notice: "microphone-failed",
      isAtDraftEnd: false
    })
    expect(harness.sockets[0]?.isClosed).toBe(true)
    expect(harness.draft).toBe("typed")
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("ends with the microphone-failed notice and reports a failure that is not a microphone error", async () => {
    const reportError = startErrorReportSpy()
    const harness = createHarness()
    const failure = new Error("worklet")
    harness.dictation.handleButtonPress(0)
    harness.microphones[0]?.reject(failure)
    await waitForMicrotasks()

    expect(harness.views.at(-1)?.notice).toBe("microphone-failed")
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("reports nothing for a microphone that fails after the start was cancelled", async () => {
    const reportError = startErrorReportSpy()
    const harness = createHarness()
    harness.dictation.handleButtonPress(0)
    harness.dictation.handleButtonPress(0)
    harness.microphones[0]?.reject(new Error("aborted"))
    await waitForMicrotasks()

    expect(harness.views.at(-1)).toEqual({
      status: "idle",
      notice: undefined,
      isAtDraftEnd: false
    })
    expect(reportError).not.toHaveBeenCalled()
  })

  it("clears the last notice when the next dictation starts", async () => {
    const harness = createHarness()
    harness.dictation.handleButtonPress(0)
    harness.microphones[0]?.reject(new MicrophoneError("denied"))
    await waitForMicrotasks()
    harness.dictation.handleButtonPress(0)

    expect(harness.views.at(-1)).toEqual({
      status: "starting",
      notice: undefined,
      isAtDraftEnd: true
    })
  })

  it("says whether the dictation writes at the draft's end", () => {
    const harness = createHarness("Hello world")
    harness.dictation.handleButtonPress(5)

    expect(harness.views.at(-1)?.isAtDraftEnd).toBe(false)
  })
})

describe("ComposerDictation text", () => {
  it("writes each update where the cursor was, keeping what was typed", async () => {
    const { harness, socket } = await startListening("Dear Ana, bye", 9)
    sendUpdate(socket, "partial", "thanks for")
    expect(harness.draft).toBe("Dear Ana, thanks for bye")
    sendUpdate(socket, "partial", "Thanks for the note.")

    expect(harness.draft).toBe("Dear Ana, Thanks for the note. bye")
  })

  it("stops on a press while listening: releases the microphone, sends stop, and waits for the final text", async () => {
    const { harness, socket, microphone } = await startListening()
    harness.dictation.handleButtonPress(0)

    expect(microphone.isStopped).toBe(true)
    expect(socket.stops).toBe(1)
    expect(socket.isClosed).toBe(false)
    expect(harness.views.at(-1)?.status).toBe("stopping")
  })

  it("sends no frame after the stop", async () => {
    const { harness, socket, microphone } = await startListening()
    harness.dictation.stop()
    microphone.options.onFrame(FRAME)

    expect(socket.audio).toEqual([])
  })

  it("writes the final text and ends without a notice", async () => {
    const { harness, socket } = await startListening("Note:")
    sendUpdate(socket, "partial", "by milk")
    harness.dictation.stop()
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
    harness.dictation.stop()
    harness.dictation.handleButtonPress(0)

    expect(socket.stops).toBe(1)
    expect(harness.sockets).toHaveLength(1)
    expect(harness.views.at(-1)?.status).toBe("stopping")
  })

  it("keeps the last partial and ends when no final text arrives in five seconds", async () => {
    startFakeTimers()
    const { harness, socket } = await startListening()
    sendUpdate(socket, "partial", "so far")
    harness.dictation.stop()
    vi.advanceTimersByTime(4_999)
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
    harness.dictation.stop()
    sendUpdate(socket, "final", "Done.")
    sendUpdate(socket, "partial", "late")
    socket.handlers.onClose(1000)

    expect(harness.draft).toBe("Done.")
    expect(harness.views.at(-1)?.notice).toBeUndefined()
  })

  it.each(["not json", '{"type":"partial"}', '{"type":"speak","text":"x"}'])(
    "ends with the stopped notice, and reports the failure without the text, for the message %s",
    async (message) => {
      const reportError = startErrorReportSpy()
      const { harness, socket, microphone } = await startListening("typed")
      socket.handlers.onText(message)

      expect(harness.draft).toBe("typed")
      expect(microphone.isStopped).toBe(true)
      expect(harness.views.at(-1)?.notice).toBe("stopped")
      expect(reportError).toHaveBeenCalledExactlyOnceWith(
        new Error(
          "The dictation socket sent a message that is not a dictation message."
        )
      )
    }
  )
})

describe("ComposerDictation endings", () => {
  it.each([
    [4503, "voice-not-ready"],
    [1011, "voice-stopped"],
    [1006, "stopped"],
    [4409, "stopped"],
    [1001, "stopped"]
  ] as const)(
    "keeps the text so far and ends with a notice when the socket closes with %i",
    async (code, notice) => {
      const { harness, socket, microphone } = await startListening()
      sendUpdate(socket, "partial", "so far")
      socket.handlers.onClose(code)

      expect(harness.draft).toBe("so far")
      expect(microphone.isStopped).toBe(true)
      expect(harness.views.at(-1)).toEqual({
        status: "idle",
        notice,
        isAtDraftEnd: false
      })
    }
  )

  it("ends a start with the voice-not-ready notice when the socket closes with 4503, and cancels the microphone", async () => {
    const harness = createHarness()
    harness.dictation.handleButtonPress(0)
    harness.sockets[0]?.handlers.onClose(4503)

    expect(harness.views.at(-1)?.notice).toBe("voice-not-ready")
    expect(harness.microphones[0]?.options.signal.aborted).toBe(true)
  })

  it("ends the wait for the final text when the socket closes first", async () => {
    startFakeTimers()
    const { harness, socket } = await startListening()
    harness.dictation.stop()
    socket.handlers.onClose(1011)
    vi.advanceTimersByTime(5_000)

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
    harness.dictation.cancel()
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

  it("changes nothing when the socket of a cancelled dictation reports its close", async () => {
    const { harness, socket } = await startListening("typed")
    harness.dictation.cancel()
    harness.dictation.handleButtonPress(0)
    const views = harness.views.length
    await waitForMicrotasks()

    expect(socket.isClosed).toBe(true)
    expect(harness.sockets).toHaveLength(2)
    expect(harness.views).toHaveLength(views)
    expect(harness.views.at(-1)).toMatchObject({
      status: "starting",
      notice: undefined
    })
  })

  it("clears a notice on cancel while nothing runs", async () => {
    const { harness, socket } = await startListening()
    socket.handlers.onClose(1011)
    harness.dictation.cancel()

    expect(harness.views.at(-1)?.notice).toBeUndefined()
  })

  it("cancels when something else changed the draft, and not for its own writes", async () => {
    const { harness, socket, microphone } = await startListening("typed")
    sendUpdate(socket, "partial", "words")
    harness.dictation.handleDraftChange(harness.draft)
    expect(harness.views.at(-1)?.status).toBe("listening")
    harness.dictation.handleDraftChange("")

    expect(microphone.isStopped).toBe(true)
    expect(harness.views.at(-1)?.status).toBe("idle")
  })

  it("does nothing on stop, cancel, or a draft change while nothing runs", () => {
    const harness = createHarness()
    harness.dictation.stop()
    harness.dictation.cancel()
    harness.dictation.handleDraftChange("typed")

    expect(harness.views).toEqual([])
  })

  it("starts a new dictation after one ended, on its own socket", async () => {
    const { harness, socket } = await startListening()
    harness.dictation.stop()
    sendUpdate(socket, "final", "One.")
    harness.dictation.handleButtonPress(harness.draft.length)
    harness.microphones[1]?.open()
    await waitForMicrotasks()
    const second = harness.sockets[1]
    if (second === undefined) throw new Error("no second socket")
    sendUpdate(second, "partial", "Two.")

    expect(harness.draft).toBe("One. Two.")
  })
})
