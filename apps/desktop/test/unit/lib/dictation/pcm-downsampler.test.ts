import { describe, expect, it } from "vitest"
import { PcmDownsampler } from "@/lib/dictation/pcm-downsampler"

/** Sample rate of the frames under test, in hertz. */
const OUTPUT_RATE = 16_000

/** Samples one frame under test holds: 100 ms. */
const FRAME_SAMPLES = 1_600

/**
 * Builds a sine tone.
 *
 * @param frequency - The tone's frequency, in hertz.
 * @param sampleRate - Sample rate of the tone, in hertz.
 * @param sampleCount - Samples to build.
 * @returns The tone at half of full scale.
 */
function buildTone(
  frequency: number,
  sampleRate: number,
  sampleCount: number
): Float32Array {
  return Float32Array.from(
    { length: sampleCount },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / sampleRate)
  )
}

/**
 * Converts audio in blocks, as the audio thread hands it over.
 *
 * @param input - The audio to convert.
 * @param inputRate - Its sample rate, in hertz.
 * @param blockSize - Samples per call.
 * @returns The frames the conversion sent, in order.
 */
function calculateFrames(
  input: Float32Array,
  inputRate: number,
  blockSize = 128
): Uint8Array<ArrayBuffer>[] {
  const frames: Uint8Array<ArrayBuffer>[] = []
  const downsampler = new PcmDownsampler({
    inputRate,
    outputRate: OUTPUT_RATE,
    frameSamples: FRAME_SAMPLES,
    onFrame: (frame) => frames.push(frame)
  })
  for (let start = 0; start < input.length; start += blockSize) {
    downsampler.addSamples(input.subarray(start, start + blockSize))
  }
  return frames
}

/**
 * Reads the samples of frames as floats.
 *
 * @param frames - Frames of signed 16-bit little-endian PCM.
 * @returns Every sample, in order, in [-1, 1].
 */
function readSamples(frames: readonly Uint8Array<ArrayBuffer>[]): number[] {
  return frames.flatMap((frame) => {
    const view = new DataView(frame.buffer)
    return Array.from(
      { length: frame.byteLength / 2 },
      (_, index) => view.getInt16(index * 2, true) / 32_767
    )
  })
}

/**
 * Calculates the root mean square of samples.
 *
 * @param samples - The samples.
 * @returns Their root mean square.
 */
function calculateRms(samples: readonly number[]): number {
  const squares = samples.reduce((sum, sample) => sum + sample * sample, 0)
  return Math.sqrt(squares / samples.length)
}

describe("PcmDownsampler", () => {
  it("converts one second at 48 kHz to ten frames of 1,600 samples at 16 kHz", () => {
    const frames = calculateFrames(buildTone(440, 48_000, 48_128), 48_000)

    expect(frames).toHaveLength(10)
    expect(frames.every((frame) => frame.byteLength === 3_200)).toBe(true)
  })

  it("keeps a 1 kHz tone at 48 kHz as the same tone at 16 kHz", () => {
    const samples = readSamples(
      calculateFrames(buildTone(1_000, 48_000, 48_128), 48_000)
    )
    const expected = buildTone(1_000, OUTPUT_RATE, samples.length)

    for (let index = 200; index < samples.length; index += 1) {
      expect(samples[index]).toBeCloseTo(expected[index] ?? 0, 2)
    }
  })

  it("keeps a 1 kHz tone at 44.1 kHz as the same tone at 16 kHz", () => {
    const samples = readSamples(
      calculateFrames(buildTone(1_000, 44_100, 44_228), 44_100)
    )
    const expected = buildTone(1_000, OUTPUT_RATE, samples.length)

    expect(samples).toHaveLength(16_000)
    for (let index = 200; index < samples.length; index += 1) {
      expect(samples[index]).toBeCloseTo(expected[index] ?? 0, 2)
    }
  })

  it("removes a tone the lower rate cannot carry instead of folding it into speech", () => {
    const samples = readSamples(
      calculateFrames(buildTone(12_000, 48_000, 48_128), 48_000)
    )

    expect(calculateRms(samples.slice(200))).toBeLessThan(0.005)
  })

  it("passes audio already at 16 kHz through unchanged", () => {
    const input = buildTone(3_000, OUTPUT_RATE, 3_216)
    const samples = readSamples(calculateFrames(input, OUTPUT_RATE))

    expect(samples).toHaveLength(3_200)
    samples.forEach((sample, index) => {
      expect(sample).toBeCloseTo(input[index] ?? 0, 3)
    })
  })

  it("sends the same frames whatever the size of the blocks it is given", () => {
    const input = buildTone(700, 48_000, 24_000)

    expect(calculateFrames(input, 48_000, 500)).toEqual(
      calculateFrames(input, 48_000, 128)
    )
    expect(calculateFrames(input, 48_000, 4_096)).toEqual(
      calculateFrames(input, 48_000, 128)
    )
  })

  it("clamps samples beyond full scale", () => {
    const input = new Float32Array(OUTPUT_RATE).fill(2)
    const samples = readSamples(calculateFrames(input, OUTPUT_RATE))

    expect(Math.max(...samples)).toBe(1)
  })

  it("sends no frame until enough samples arrived to fill one", () => {
    expect(calculateFrames(buildTone(440, 48_000, 4_000), 48_000)).toEqual([])
  })
})
