/**
 * The audio worklet of the microphone recorder: it converts the microphone's
 * audio to the dictation's frames on the audio rendering thread, and sends
 * each frame to the recorder.
 *
 * @remarks The module is loaded with `audioWorklet.addModule`, never
 * imported, because it registers its processor as it loads. It runs in the
 * worklet's global scope, which has no DOM, so it imports only modules that
 * import nothing.
 */
import { PcmDownsampler } from "./pcm-downsampler"
import {
  DICTATION_RECORDER_PROCESSOR,
  type RecorderProcessorOptions
} from "./recorder-contract"

/** Sample rate of the audio context the worklet runs in, in hertz. */
declare const sampleRate: number

/** Base class of a processor, as the worklet's global scope provides it. */
declare class AudioWorkletProcessor {
  /** Port to the processor's node on the main thread. */
  public readonly port: MessagePort
}

/** What a processor is constructed with. */
type RecorderProcessorInit = Readonly<{
  /** Options the recorder gave its node. */
  processorOptions: RecorderProcessorOptions
}>

/**
 * Registers a processor class under a name, as the worklet's global scope
 * provides it.
 *
 * @param name - Name a node asks for.
 * @param processor - The processor's class.
 */
declare function registerProcessor(
  name: string,
  processor: new (init: RecorderProcessorInit) => AudioWorkletProcessor
): void

/**
 * Sends the microphone's audio to its node as dictation frames.
 *
 * @remarks Lifecycle: the audio context creates one instance per recorder
 * node and drops it with the context. Concurrency model: confined to the
 * audio rendering thread, which calls {@link DictationRecorderProcessor.process}
 * once per block. Each frame's buffer is transferred to the node, not copied.
 */
class DictationRecorderProcessor extends AudioWorkletProcessor {
  /** Converts the context's audio to the frames. */
  readonly #downsampler: PcmDownsampler

  /**
   * Creates the processor for one recorder node.
   *
   * @param init - The node's options, with the frames' rate and size.
   */
  public constructor(init: RecorderProcessorInit) {
    super()
    this.#downsampler = new PcmDownsampler({
      inputRate: sampleRate,
      outputRate: init.processorOptions.frameSampleRate,
      frameSamples: init.processorOptions.frameSamples,
      onFrame: (frame) => {
        this.port.postMessage(frame.buffer, [frame.buffer])
      }
    })
  }

  /**
   * Takes one block of the microphone's audio.
   *
   * @param inputs - The node's inputs; the first channel of the first input
   * is the microphone, which the node mixes down to one channel.
   * @returns True, which keeps the processor alive until its context closes.
   */
  public process(inputs: readonly (readonly Float32Array[])[]): boolean {
    const channel = inputs[0]?.[0]
    if (channel !== undefined) this.#downsampler.addSamples(channel)
    return true
  }
}

registerProcessor(DICTATION_RECORDER_PROCESSOR, DictationRecorderProcessor)
