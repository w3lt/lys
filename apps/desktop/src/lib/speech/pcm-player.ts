/**
 * Plays the raw PCM the backend streams for a reply: signed 16-bit
 * little-endian samples, 24 kHz, one channel, as the voice protocol
 * defines them.
 *
 * @remarks Owns one {@link AudioContext} created on the first frame. Frames
 * are decoded to float and scheduled back to back; a frame that arrives
 * after its turn is late and plays late, which is the best a player without
 * a buffer can do. `stop()` ends every scheduled source and forgets the
 * timeline, so the next frame starts at once. The context is created on
 * first use and resumed on each frame, because a context created before a
 * user gesture starts out suspended and WebKit keeps it that way.
 */
/** Incoming PCM frames are 16-bit, little-endian, mono. */
const SAMPLE_RATE_HZ = 24_000
/** Bytes per sample in the stream. */
const BYTES_PER_SAMPLE = 2

/** How one PCM frame may arrive. */
export type PcmFrame = Uint8Array

/** One streaming PCM player, as the speech controller uses it. */
export type PcmPlayer = {
  /**
   * Queues one frame for playback.
   *
   * @param frame - Raw bytes; must hold whole 16-bit little-endian samples.
   */
  enqueue: (frame: PcmFrame) => void
  /** Stops every scheduled frame and forgets the timeline. */
  stop: () => void
  /** Resumes a suspended audio context, such as one blocked before the first user gesture. */
  resume: () => void
}

/**
 * Converts one raw frame to mono float samples in [-1, 1).
 *
 * @param frame - Raw bytes, two per sample, little-endian.
 * @returns The decoded samples; a trailing odd byte is dropped.
 */
export function decodePcm16Le(frame: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(frame.byteLength / BYTES_PER_SAMPLE)
  const samples = new Float32Array(sampleCount)
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * BYTES_PER_SAMPLE, true) / 32768
  }
  return samples
}

/**
 * Creates a player over the platform's `AudioContext`.
 *
 * @param createContext - Factory for the audio context, injectable for
 * tests; defaults to the platform constructor.
 * @returns The player. Nothing is created until the first frame arrives.
 */
export function createPcmPlayer(
  createContext: () => AudioContext = () => new AudioContext()
): PcmPlayer {
  let context: AudioContext | undefined
  let nextStartTime = 0
  const sources = new Set<AudioBufferSourceNode>()

  function audioContext(): AudioContext {
    context ??= createContext()
    return context
  }

  return {
    enqueue(frame: PcmFrame): void {
      const audio = audioContext()
      if (audio.state === "suspended")
        void audio.resume().catch(() => undefined)
      const samples = decodePcm16Le(frame)
      if (samples.length === 0) return
      const buffer = audio.createBuffer(1, samples.length, SAMPLE_RATE_HZ)
      buffer.copyToChannel(samples, 0)
      const source = audio.createBufferSource()
      source.buffer = buffer
      source.connect(audio.destination)
      const startAt = Math.max(audio.currentTime, nextStartTime)
      source.start(startAt)
      nextStartTime = startAt + buffer.duration
      sources.add(source)
      source.onended = () => {
        sources.delete(source)
      }
    },
    stop(): void {
      for (const source of sources) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // A source that already ended cannot be stopped again.
        }
      }
      sources.clear()
      nextStartTime = 0
    },
    resume(): void {
      if (context?.state === "suspended") {
        void context.resume().catch(() => undefined)
      }
    }
  }
}
