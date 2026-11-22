/**
 * What the microphone recorder and its audio worklet agree on.
 *
 * @remarks The worklet imports this module, so it imports nothing itself.
 */

/** Name the recorder's processor is registered under in the worklet. */
export const DICTATION_RECORDER_PROCESSOR = "dictation-recorder"

/** Options the recorder gives its processor. */
export type RecorderProcessorOptions = Readonly<{
  /** Sample rate of the frames the processor sends, in hertz. */
  frameSampleRate: number
  /** Samples one frame holds. */
  frameSamples: number
}>
