/**
 * Records the microphone for a dictation: it asks for the microphone, runs
 * the recorder's audio worklet over it, and hands each frame of dictation
 * audio to its caller until it is stopped.
 *
 * @remarks The microphone is open only between a start that succeeded and
 * the stop: every other path out of {@link startMicrophoneRecorder} stops
 * the microphone's tracks and closes the audio context before it returns.
 * Echo cancellation is off, because Lys never talks while she listens and
 * macOS's voice processing would lower other sound.
 */
import {
  DICTATION_AUDIO_FRAME_SAMPLES,
  DICTATION_AUDIO_SAMPLE_RATE_HZ
} from "@lys/protocol"

import {
  DICTATION_RECORDER_PROCESSOR,
  type RecorderProcessorOptions
} from "./recorder-contract"
import recorderWorkletUrl from "./recorder-worklet?worker&url"

/**
 * Why the microphone could not be opened.
 *
 * @remarks `denied`: the person or macOS refused access. `missing`: no
 * microphone is connected. `failed`: anything else.
 */
export type MicrophoneFailure = "denied" | "missing" | "failed"

/** The microphone could not be opened. */
export class MicrophoneError extends Error {
  /** Why it could not be opened. */
  public readonly kind: MicrophoneFailure

  /**
   * Creates the error.
   *
   * @param kind - Why the microphone could not be opened.
   * @param options - The failure that caused it, as its `cause`.
   */
  public constructor(kind: MicrophoneFailure, options?: ErrorOptions) {
    super(`The microphone could not be opened: ${kind}`, options)
    this.name = "MicrophoneError"
    this.kind = kind
  }
}

/** A running recording. */
export type MicrophoneRecorder = Readonly<{
  /**
   * Stops the recording and releases the microphone; idempotent. No frame is
   * handed over afterwards.
   */
  stop: () => void
}>

/** What a recording is started with. */
export type MicrophoneRecorderOptions = Readonly<{
  /**
   * Called with each frame of dictation audio, in order.
   *
   * @param frame - Signed 16-bit little-endian PCM at the dictation's sample
   * rate, one channel, {@link DICTATION_AUDIO_FRAME_SAMPLES} samples.
   */
  onFrame: (frame: Uint8Array<ArrayBuffer>) => void
  /** Called when the microphone ends on its own, as when it is unplugged. */
  onEnded: () => void
  /** Cancels a start that has not finished; a running recording ignores it. */
  signal: AbortSignal
}>

/** What the recorder asks the microphone for. */
const MICROPHONE_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({ channelCount: 1, echoCancellation: false }),
  video: false
}) satisfies MediaStreamConstraints

/**
 * Calculates why asking for the microphone failed.
 *
 * @param failure - Value `getUserMedia` rejected with, or the failure of
 * reading it.
 * @returns `denied` for a refused permission, `missing` when no microphone
 * was found, and `failed` otherwise.
 */
function calculateMicrophoneFailure(failure: unknown): MicrophoneFailure {
  const name = failure instanceof DOMException ? failure.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "denied"
  return name === "NotFoundError" ? "missing" : "failed"
}

/**
 * Asks for the microphone.
 *
 * @returns The microphone's stream, which the caller must stop.
 * @throws {MicrophoneError} When the microphone cannot be opened, with the
 * platform's failure as its cause.
 */
async function openMicrophoneStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS)
  } catch (error) {
    throw new MicrophoneError(calculateMicrophoneFailure(error), {
      cause: error
    })
  }
}

/**
 * Creates the recorder's audio context and asks it to run.
 *
 * @returns The context, which the caller must close.
 * @throws {MicrophoneError} `failed` when the platform creates none, with
 * the platform's failure as its cause.
 * @remarks A start calls this before its first wait, so the context is
 * created and asked to run inside the press that started the dictation,
 * which is when every engine lets an audio context run.
 */
function createRecorderContext(): AudioContext {
  try {
    const context = new AudioContext()
    context.resume().catch(() => {
      // The context is asked again once the microphone is open.
    })
    return context
  } catch (error) {
    throw new MicrophoneError("failed", { cause: error })
  }
}

/**
 * Releases the microphone and the audio context over it.
 *
 * @param stream - The microphone's stream, if it was opened.
 * @param context - The audio context.
 */
function closeCapture(
  stream: MediaStream | undefined,
  context: AudioContext
): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
  context.close().catch(() => {
    // The context is already closed; nothing is held.
  })
}

/**
 * Starts the recording: connects the microphone to the recorder's processor
 * and starts handing frames over.
 *
 * @param stream - The microphone's stream.
 * @param context - Audio context the recorder's worklet module is loaded in.
 * @param options - The frames' receiver and the microphone's end.
 * @returns The running recording, which owns the stream and the context.
 * @remarks The processor's silent output is connected to the context's
 * destination, so every engine keeps pulling audio through it. The context
 * is asked to run once more, because an engine that kept it suspended lets
 * it run while the microphone is open.
 */
function startRecording(
  stream: MediaStream,
  context: AudioContext,
  options: MicrophoneRecorderOptions
): MicrophoneRecorder {
  const node = new AudioWorkletNode(context, DICTATION_RECORDER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: {
      frameSampleRate: DICTATION_AUDIO_SAMPLE_RATE_HZ,
      frameSamples: DICTATION_AUDIO_FRAME_SAMPLES
    } satisfies RecorderProcessorOptions
  })
  let isStopped = false
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    if (isStopped || !(event.data instanceof ArrayBuffer)) return
    options.onFrame(new Uint8Array(event.data))
  }

  /** Reports that the microphone ended on its own, unless it was stopped. */
  function handleTrackEnded(): void {
    if (!isStopped) options.onEnded()
  }

  for (const track of stream.getTracks()) {
    track.addEventListener("ended", handleTrackEnded)
  }
  context.createMediaStreamSource(stream).connect(node)
  node.connect(context.destination)
  context.resume().catch(() => {
    // The context stays suspended, and the recording hands no frame over.
  })
  return Object.freeze({
    stop: () => {
      if (isStopped) return
      isStopped = true
      node.port.onmessage = null
      closeCapture(stream, context)
    }
  })
}

/**
 * Opens the microphone and starts recording it as dictation audio.
 *
 * @param options - The frames' receiver, the microphone's end, and the
 * signal that cancels the start.
 * @returns The running recording, once the microphone is open and frames
 * flow.
 * @throws {MicrophoneError} When the microphone cannot be opened or the
 * recording cannot be set up, with the cause attached.
 * @throws The signal's reason when the signal aborted before the recording
 * ran.
 * @remarks The audio context is created and the microphone is asked for
 * before the first wait, so a caller that starts in a press does both
 * inside that press. The microphone and the audio context are released
 * before any failure is thrown. The first call asks macOS for access to the
 * microphone.
 */
export async function startMicrophoneRecorder(
  options: MicrophoneRecorderOptions
): Promise<MicrophoneRecorder> {
  const context = createRecorderContext()
  let stream: MediaStream | undefined
  try {
    stream = await openMicrophoneStream()
    options.signal.throwIfAborted()
    await context.audioWorklet.addModule(recorderWorkletUrl)
    options.signal.throwIfAborted()
    return startRecording(stream, context, options)
  } catch (error) {
    closeCapture(stream, context)
    if (options.signal.aborted || error instanceof MicrophoneError) throw error
    throw new MicrophoneError("failed", { cause: error })
  }
}
