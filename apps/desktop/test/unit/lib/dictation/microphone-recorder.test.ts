import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  MicrophoneError,
  startMicrophoneRecorder,
  type MicrophoneRecorderOptions
} from "@/lib/dictation/microphone-recorder"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"

/** A microphone track, as the test drives it. */
class FakeTrack {
  /** Whether the recorder stopped the track. */
  public isStopped = false
  /** Listeners of the track's end. */
  readonly #endedListeners: (() => void)[] = []

  /** Stops the track, as the recorder does. */
  public stop(): void {
    this.isStopped = true
  }

  /**
   * Adds a listener.
   *
   * @param _type - Event type; the recorder listens for `ended` only.
   * @param listener - The listener.
   */
  public addEventListener(_type: string, listener: () => void): void {
    this.#endedListeners.push(listener)
  }

  /** Ends the track on its own, as unplugging the microphone does. */
  public end(): void {
    for (const listener of this.#endedListeners) listener()
  }
}

/** A microphone stream with one track. */
class FakeStream {
  /** The stream's track. */
  public readonly track = new FakeTrack()

  /** Lists the stream's tracks. */
  public getTracks(): FakeTrack[] {
    return [this.track]
  }
}

/** A stand-in for the platform's audio context, which jsdom lacks. */
class FakeAudioContext {
  /** Every context created, in order. */
  public static readonly created: FakeAudioContext[] = []
  /** What loading the worklet module resolves with; the test may replace it. */
  public static moduleLoad: Promise<void> = Promise.resolve()
  /** Where the recorder's node connects. */
  public readonly destination = { name: "destination" }
  /** URLs of the worklet modules loaded. */
  public readonly modules: string[] = []
  /** What the microphone's source was connected to. */
  public readonly sourceConnections: unknown[] = []
  /** The stream a source was created for. */
  public sourceStream: unknown
  /** How many times the context was resumed. */
  public resumes = 0
  /** Whether the context was closed. */
  public isClosed = false
  /** The worklet of the context. */
  public readonly audioWorklet = {
    addModule: (url: string): Promise<void> => {
      this.modules.push(url)
      return FakeAudioContext.moduleLoad
    }
  }

  /** Records the context. */
  public constructor() {
    FakeAudioContext.created.push(this)
  }

  /**
   * Creates the microphone's source.
   *
   * @param stream - The microphone's stream.
   */
  public createMediaStreamSource(stream: unknown) {
    this.sourceStream = stream
    return {
      connect: (node: unknown) => {
        this.sourceConnections.push(node)
      }
    }
  }

  /** Resumes the context. */
  public resume(): Promise<void> {
    this.resumes += 1
    return Promise.resolve()
  }

  /** Closes the context. */
  public close(): Promise<void> {
    this.isClosed = true
    return Promise.resolve()
  }
}

/** A stand-in for the recorder's worklet node. */
class FakeWorkletNode {
  /** Every node created, in order. */
  public static readonly created: FakeWorkletNode[] = []
  /** The port to the processor. */
  public readonly port: { onmessage: ((event: unknown) => void) | null } = {
    onmessage: null
  }
  /** What the node was connected to. */
  public readonly connections: unknown[] = []

  /**
   * Records the node.
   *
   * @param context - The node's context.
   * @param name - The processor's name.
   * @param options - The node's options.
   */
  public constructor(
    public readonly context: unknown,
    public readonly name: string,
    public readonly options: unknown
  ) {
    FakeWorkletNode.created.push(this)
  }

  /**
   * Connects the node.
   *
   * @param destination - Where it connects.
   */
  public connect(destination: unknown): void {
    this.connections.push(destination)
  }

  /**
   * Posts a message from the processor.
   *
   * @param data - The message's data.
   */
  public sendMessage(data: unknown): void {
    this.port.onmessage?.({ data })
  }
}

/** What the fake platform answers a microphone request with. */
type FakeMicrophone = {
  /** The pending answer. */
  readonly answer: ControlledPromise<FakeStream>
  /** Constraints the recorder asked with. */
  readonly constraints: unknown[]
}

/**
 * Installs a fake platform: the microphone, the audio context, and the
 * worklet node.
 *
 * @returns The microphone request, which the test answers.
 */
function startFakePlatform(): FakeMicrophone {
  const microphone: FakeMicrophone = {
    answer: createControlledPromise<FakeStream>(),
    constraints: []
  }
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: (constraints: unknown) => {
        microphone.constraints.push(constraints)
        return microphone.answer.promise
      }
    }
  })
  vi.stubGlobal("AudioContext", FakeAudioContext)
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode)
  return microphone
}

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
  const microphone = startFakePlatform()
  const stream = new FakeStream()
  microphone.answer.resolve(stream)
  const probe = createRecordingProbe()
  const recorder = await startMicrophoneRecorder(probe.options)
  const [context] = FakeAudioContext.created
  const [node] = FakeWorkletNode.created
  if (context === undefined || node === undefined)
    throw new Error("the recording built no audio graph")
  return { microphone, stream, probe, recorder, context, node }
}

beforeEach(() => {
  FakeAudioContext.created.length = 0
  FakeAudioContext.moduleLoad = Promise.resolve()
  FakeWorkletNode.created.length = 0
})

describe("startMicrophoneRecorder", () => {
  it("asks for one channel of the microphone without echo cancellation", async () => {
    const { microphone } = await startRecording()

    expect(microphone.constraints).toEqual([
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
      const microphone = startFakePlatform()
      const refusal = new DOMException("refused", name)
      microphone.answer.reject(refusal)

      const failure = await startMicrophoneRecorder(
        createRecordingProbe().options
      ).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(MicrophoneError)
      expect(failure).toMatchObject({ kind, cause: refusal })
      expect(FakeAudioContext.created).toEqual([])
    }
  )

  it("fails when the platform has no microphone API", async () => {
    vi.stubGlobal("navigator", {})

    await expect(
      startMicrophoneRecorder(createRecordingProbe().options)
    ).rejects.toMatchObject({ name: "MicrophoneError", kind: "failed" })
  })

  it("releases the microphone and the audio context when the worklet module cannot be loaded", async () => {
    const microphone = startFakePlatform()
    const stream = new FakeStream()
    const cause = new Error("no module")
    FakeAudioContext.moduleLoad = Promise.reject(cause)
    microphone.answer.resolve(stream)

    await expect(
      startMicrophoneRecorder(createRecordingProbe().options)
    ).rejects.toMatchObject({ name: "MicrophoneError", kind: "failed", cause })
    expect(stream.track.isStopped).toBe(true)
    expect(FakeAudioContext.created[0]?.isClosed).toBe(true)
  })

  it("releases a microphone that opens after the start was cancelled, and builds nothing", async () => {
    const microphone = startFakePlatform()
    const stream = new FakeStream()
    const probe = createRecordingProbe()
    const started = startMicrophoneRecorder(probe.options)
    probe.abort.abort()
    microphone.answer.resolve(stream)

    await expect(started).rejects.toBe(probe.abort.signal.reason)
    expect(stream.track.isStopped).toBe(true)
    expect(FakeAudioContext.created).toEqual([])
  })

  it("releases everything when the start is cancelled while the worklet module loads", async () => {
    const microphone = startFakePlatform()
    const stream = new FakeStream()
    const moduleLoad = createControlledPromise<void>()
    FakeAudioContext.moduleLoad = moduleLoad.promise
    const probe = createRecordingProbe()
    const started = startMicrophoneRecorder(probe.options)
    microphone.answer.resolve(stream)
    await waitForMicrotasks()
    probe.abort.abort()
    moduleLoad.resolve()

    await expect(started).rejects.toBe(probe.abort.signal.reason)
    expect(stream.track.isStopped).toBe(true)
    expect(FakeAudioContext.created[0]?.isClosed).toBe(true)
    expect(FakeWorkletNode.created).toEqual([])
  })
})
