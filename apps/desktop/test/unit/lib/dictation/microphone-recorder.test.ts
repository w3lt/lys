import { describe, expect, it, vi } from "vitest"
import {
  MicrophoneError,
  startMicrophoneRecorder,
  type MicrophoneRecorderOptions
} from "@/lib/dictation/microphone-recorder"
import {
  FakeMicrophoneStream,
  startDictationPlatformFake
} from "../../support/dictationPlatformFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** What a test's recording was started with, and what it reported. */
type RecordingProbe = {
  /** Options the recording was started with. */
  readonly options: MicrophoneRecorderOptions
  /** Frames handed over, in order. */
  readonly frames: Uint8Array[]
  /** How many times the microphone's end was reported. */
  ends: number
  /** Cancels the start. */
  readonly abort: AbortController
}

/**
 * Builds the options of a recording that records what it reports.
 *
 * @returns The probe.
 */
function createRecordingProbe(): RecordingProbe {
  const abort = new AbortController()
  const probe: RecordingProbe = {
    frames: [],
    ends: 0,
    abort,
    options: {
      signal: abort.signal,
      onFrame: (frame) => probe.frames.push(frame),
      onEnded: () => {
        probe.ends += 1
      }
    }
  }
  return probe
}

/**
 * Starts a recording on a fake platform whose microphone opens at once.
 *
 * @returns The running recording with its fakes.
 */
async function startRecording() {
  const platform = startDictationPlatformFake()
  const probe = createRecordingProbe()
  const recorder = await startMicrophoneRecorder(probe.options)
  const [stream] = platform.streams
  const [context] = platform.contexts
  const [node] = platform.nodes
  if (stream === undefined || context === undefined || node === undefined)
    throw new Error("the recording built no audio graph")
  return { platform, stream, probe, recorder, context, node }
}

describe("startMicrophoneRecorder", () => {
  it("asks for one channel of the microphone without echo cancellation", async () => {
    const { platform } = await startRecording()

    expect(platform.microphoneRequests).toEqual([
      { audio: { channelCount: 1, echoCancellation: false }, video: false }
    ])
  })

  it("runs the recorder's processor over the microphone, for 16 kHz frames of 1,600 samples", async () => {
    const { stream, context, node } = await startRecording()

    expect(context.modules).toHaveLength(1)
    expect(context.modules[0]).toContain("recorder-worklet")
    expect(node.name).toBe("dictation-recorder")
    expect(node.options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { frameSampleRate: 16_000, frameSamples: 1_600 }
    })
    expect(context.sourceStream).toBe(stream)
    expect(context.sourceConnections).toEqual([node])
    expect(node.connections).toEqual([context.destination])
    expect(context.resumes).toBe(1)
  })

  it("hands each frame the processor posts to its caller", async () => {
    const { probe, node } = await startRecording()
    const frame = new Uint8Array([1, 2, 3, 4])
    node.sendMessage(frame.buffer)
    node.sendMessage("not a frame")

    expect(probe.frames).toEqual([frame])
  })

  it("releases the microphone and the audio context on stop, and hands no frame over afterwards", async () => {
    const { probe, recorder, stream, context, node } = await startRecording()
    const { onmessage } = node.port
    recorder.stop()
    recorder.stop()
    onmessage?.({ data: new ArrayBuffer(4) })

    expect(stream.track.isStopped).toBe(true)
    expect(context.isClosed).toBe(true)
    expect(node.port.onmessage).toBeNull()
    expect(probe.frames).toEqual([])
  })

  it("reports a microphone that ends on its own, and not one it stopped", async () => {
    const { probe, recorder, stream } = await startRecording()
    stream.track.end()
    expect(probe.ends).toBe(1)
    recorder.stop()
    stream.track.end()

    expect(probe.ends).toBe(1)
  })

  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "missing"],
    ["NotReadableError", "failed"]
  ] as const)(
    "fails with the cause when the platform refuses with %s",
    async (name, kind) => {
      const platform = startDictationPlatformFake()
      const refusal = new DOMException("refused", name)
      platform.openMicrophone = () => Promise.reject(refusal)

      const failure = await startMicrophoneRecorder(
        createRecordingProbe().options
      ).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(MicrophoneError)
      expect(failure).toMatchObject({ kind, cause: refusal })
      expect(platform.contexts).toEqual([])
    }
  )

  it("fails when the platform has no microphone API", async () => {
    vi.stubGlobal("navigator", {})

    await expect(
      startMicrophoneRecorder(createRecordingProbe().options)
    ).rejects.toMatchObject({ name: "MicrophoneError", kind: "failed" })
  })

  it("releases the microphone and the audio context when the worklet module cannot be loaded", async () => {
    const platform = startDictationPlatformFake()
    const cause = new Error("no module")
    platform.loadWorkletModule = () => Promise.reject(cause)

    await expect(
      startMicrophoneRecorder(createRecordingProbe().options)
    ).rejects.toMatchObject({ name: "MicrophoneError", kind: "failed", cause })
    expect(platform.streams[0]?.track.isStopped).toBe(true)
    expect(platform.contexts[0]?.isClosed).toBe(true)
  })

  it("releases a microphone that opens after the start was cancelled, and builds nothing", async () => {
    const platform = startDictationPlatformFake()
    const answer = createControlledPromise<FakeMicrophoneStream>()
    platform.openMicrophone = () => answer.promise
    const stream = new FakeMicrophoneStream()
    const probe = createRecordingProbe()
    const started = startMicrophoneRecorder(probe.options)
    probe.abort.abort()
    answer.resolve(stream)

    await expect(started).rejects.toBe(probe.abort.signal.reason)
    expect(stream.track.isStopped).toBe(true)
    expect(platform.contexts).toEqual([])
  })

  it("releases everything when the start is cancelled while the worklet module loads", async () => {
    const platform = startDictationPlatformFake()
    const moduleLoad = createControlledPromise<void>()
    platform.loadWorkletModule = () => moduleLoad.promise
    const probe = createRecordingProbe()
    const started = startMicrophoneRecorder(probe.options)
    await waitForMicrotasks()
    probe.abort.abort()
    moduleLoad.resolve()

    await expect(started).rejects.toBe(probe.abort.signal.reason)
    expect(platform.streams[0]?.track.isStopped).toBe(true)
    expect(platform.contexts[0]?.isClosed).toBe(true)
    expect(platform.nodes).toEqual([])
  })
})
