/**
 * Plays the raw PCM the backend streams for a reply, in the voice protocol's
 * format: signed 16-bit little-endian samples at
 * {@link VOICE_AUDIO_SAMPLE_RATE_HZ}, one channel.
 *
 * @remarks The player owns one output, over an {@link AudioContext} in the
 * application, created on the first resume or frame. Frames are decoded to
 * float and scheduled back to back; a frame that arrives after its turn is
 * late and plays late, which is the best a player without a buffer can do.
 * `stop()` ends every scheduled frame and forgets the timeline, so the next
 * frame starts at once. The output is resumed on each resume and each frame,
 * because a context created before a user gesture starts out suspended.
 * `close()` releases the output for good.
 */
import {
  VOICE_AUDIO_BYTES_PER_SAMPLE,
  VOICE_AUDIO_CHANNELS,
  VOICE_AUDIO_SAMPLE_RATE_HZ
} from "@lys/protocol"

/** How one PCM frame may arrive. */
export type PcmFrame = Uint8Array

/** One streaming PCM player, as the speech controller uses it. */
export type PcmPlayer = {
  /**
   * Queues one frame for playback; does nothing once the player is closed.
   *
   * @param frame - Raw bytes; must hold whole 16-bit little-endian samples.
   */
  enqueue: (frame: PcmFrame) => void
  /** Stops every scheduled frame and forgets the timeline. */
  stop: () => void
  /**
   * Creates the audio context if needed and resumes it when suspended, such
   * as one blocked before the first user gesture; does nothing once the
   * player is closed.
   */
  resume: () => void
  /** Stops every scheduled frame and closes the audio context; idempotent. */
  close: () => void
}

/**
 * Converts one raw frame to mono float samples in [-1, 1).
 *
 * @param frame - Raw bytes, two per sample, little-endian.
 * @returns The decoded samples; a trailing odd byte is dropped.
 */
export function decodePcm16Le(frame: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(
    frame.byteLength / VOICE_AUDIO_BYTES_PER_SAMPLE
  )
  const samples = new Float32Array(sampleCount)
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] =
      view.getInt16(index * VOICE_AUDIO_BYTES_PER_SAMPLE, true) / 32768
  }
  return samples
}

/** One stretch of samples scheduled on an output. */
export type ScheduledPcm = Readonly<{
  /** How long the samples play, in seconds. */
  duration: number
  /** Stops the samples, even before they started. */
  stop: () => void
}>

/** Audio output the player schedules decoded samples on. */
export type PcmOutput = Readonly<{
  /** Reads the output's clock, in seconds. */
  currentTime: () => number
  /**
   * Schedules mono samples to play at a time of the output's clock.
   *
   * @param samples - Decoded samples, in [-1, 1).
   * @param startAt - When they start, in seconds of the output's clock.
   * @param onEnded - Called once they ended or were stopped.
   * @returns The scheduled stretch.
   */
  play: (
    samples: Float32Array<ArrayBuffer>,
    startAt: number,
    onEnded: () => void
  ) => ScheduledPcm
  /** Asks a suspended output to resume. */
  resume: () => void
  /** Releases the output for good. */
  close: () => void
}>

/**
 * Asks a suspended audio context to resume.
 *
 * @param context - The output's context.
 * @remarks A refused resume leaves the context suspended, and the next
 * resume or frame asks again.
 */
function resumeSuspended(context: AudioContext): void {
  if (context.state !== "suspended") return
  context.resume().catch(() => {
    // Still suspended; the next resume or frame asks again.
  })
}

/**
 * Wraps an audio context as the player's output.
 *
 * @param context - The context; the output owns it and closes it on
 * `close()`.
 * @returns The output.
 */
export function createAudioContextOutput(context: AudioContext): PcmOutput {
  return Object.freeze({
    currentTime: () => context.currentTime,
    play: (
      samples: Float32Array<ArrayBuffer>,
      startAt: number,
      onEnded: () => void
    ): ScheduledPcm => {
      const buffer = context.createBuffer(
        VOICE_AUDIO_CHANNELS,
        samples.length,
        VOICE_AUDIO_SAMPLE_RATE_HZ
      )
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.onended = onEnded
      source.start(startAt)
      return Object.freeze({
        duration: buffer.duration,
        stop: () => {
          try {
            source.stop()
          } catch {
            // A source that already ended cannot be stopped again.
          }
        }
      })
    },
    resume: () => {
      resumeSuspended(context)
    },
    close: () => {
      context.close().catch(() => {
        // The context is already closed; nothing is held.
      })
    }
  })
}

/**
 * Creates a player over an audio output.
 *
 * @param createOutput - Factory for the output, injectable for tests;
 * defaults to one over a new platform `AudioContext`.
 * @returns The player. Nothing is created until the first resume or frame.
 */
export function createPcmPlayer(
  createOutput: () => PcmOutput = () =>
    createAudioContextOutput(new AudioContext())
): PcmPlayer {
  let output: PcmOutput | undefined
  let isClosed = false
  let nextStartTime = 0
  const scheduled = new Set<ScheduledPcm>()

  /**
   * Gets the player's output, creating it on first use.
   *
   * @returns The output.
   */
  function audioOutput(): PcmOutput {
    output ??= createOutput()
    return output
  }

  /** Stops every scheduled stretch and forgets the timeline. */
  function stop(): void {
    const stretches = [...scheduled]
    scheduled.clear()
    nextStartTime = 0
    for (const stretch of stretches) stretch.stop()
  }

  return {
    enqueue(frame: PcmFrame): void {
      if (isClosed) return
      const audio = audioOutput()
      audio.resume()
      const samples = decodePcm16Le(frame)
      if (samples.length === 0) return
      const startAt = Math.max(audio.currentTime(), nextStartTime)
      const stretch = audio.play(samples, startAt, () => {
        scheduled.delete(stretch)
      })
      nextStartTime = startAt + stretch.duration
      scheduled.add(stretch)
    },
    stop,
    resume(): void {
      if (!isClosed) audioOutput().resume()
    },
    close(): void {
      if (isClosed) return
      isClosed = true
      stop()
      output?.close()
    }
  }
}
