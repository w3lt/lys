import { describe, expect, it } from "vitest"
import {
  createPcmPlayer,
  calculatePcm16LeSamples,
  type PcmOutput
} from "@/lib/speech/pcm-player"

describe("calculatePcm16LeSamples", () => {
  it("decodes little-endian 16-bit samples to floats in [-1, 1)", () => {
    // 0x0000, 0x7FFF (max), 0x8000 (min), 0xFFFF (-1)
    const frame = new Uint8Array([
      0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff
    ])

    const samples = calculatePcm16LeSamples(frame)

    expect(samples).toHaveLength(4)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBeCloseTo(32767 / 32768, 6)
    expect(samples[2]).toBe(-1)
    expect(samples[3]).toBeCloseTo(-1 / 32768, 6)
  })

  it("drops a trailing odd byte", () => {
    const frame = new Uint8Array([0x34, 0x12, 0x99])

    expect([...calculatePcm16LeSamples(frame)]).toEqual([0x1234 / 32768])
  })

  it("decodes nothing for an empty frame", () => {
    expect(calculatePcm16LeSamples(new Uint8Array(0))).toHaveLength(0)
  })
})

/** One stretch the fake output was asked to play. */
type PlayedStretch = {
  /** Samples it plays. */
  readonly samples: Float32Array<ArrayBuffer>
  /** When it starts, in seconds of the fake clock. */
  readonly startAt: number
  /** Whether it was stopped. */
  isStopped: boolean
  /** Ends it, as the platform does once it played. */
  end: () => void
}

/** A fake output with a clock the test sets. */
type FakeOutput = PcmOutput & {
  /** Stretches played, in order. */
  readonly played: PlayedStretch[]
  /** The fake clock, in seconds. */
  clock: number
  /** How many times `start` ran. */
  starts: number
  /** Whether `close` ran. */
  isClosed: boolean
}

/** Creates a fake output whose stretches last one second per 24 000 samples. */
function createFakeOutput(): FakeOutput {
  const output: FakeOutput = {
    played: [],
    clock: 0,
    starts: 0,
    isClosed: false,
    getCurrentTime: () => output.clock,
    startStretch: (samples, startAt, onEnded) => {
      const stretch: PlayedStretch = {
        samples,
        startAt,
        isStopped: false,
        end: onEnded
      }
      output.played.push(stretch)
      return {
        duration: samples.length / 24_000,
        stop: () => {
          stretch.isStopped = true
        }
      }
    },
    start: () => {
      output.starts += 1
    },
    close: () => {
      output.isClosed = true
    }
  }
  return output
}

/** A frame of `sampleCount` silent samples. */
function buildSilentFrame(sampleCount: number): Uint8Array {
  return new Uint8Array(sampleCount * 2)
}

describe("createPcmPlayer", () => {
  it("creates nothing until the first start or frame", () => {
    let created = 0
    const player = createPcmPlayer(() => {
      created += 1
      return createFakeOutput()
    })
    expect(created).toBe(0)
    player.start()
    player.addFrame(buildSilentFrame(1))
    expect(created).toBe(1)
  })

  it("schedules frames back to back and starts a late frame at once", () => {
    const output = createFakeOutput()
    const player = createPcmPlayer(() => output)
    player.addFrame(buildSilentFrame(12_000))
    player.addFrame(buildSilentFrame(24_000))
    output.clock = 5
    player.addFrame(buildSilentFrame(12_000))
    expect(output.played.map((stretch) => stretch.startAt)).toEqual([0, 0.5, 5])
  })

  it("decodes each frame's samples", () => {
    const output = createFakeOutput()
    const player = createPcmPlayer(() => output)
    player.addFrame(new Uint8Array([0x00, 0x80, 0x00, 0x00]))
    expect([...(output.played[0]?.samples ?? [])]).toEqual([-1, 0])
  })

  it("schedules nothing for a frame without a whole sample", () => {
    const output = createFakeOutput()
    const player = createPcmPlayer(() => output)
    player.addFrame(new Uint8Array([1]))
    expect(output.played).toHaveLength(0)
  })

  it("stops every scheduled frame and starts the next one at once", () => {
    const output = createFakeOutput()
    const player = createPcmPlayer(() => output)
    player.addFrame(buildSilentFrame(24_000))
    player.addFrame(buildSilentFrame(24_000))
    output.played[0]?.end()
    player.stop()
    expect(output.played.map((stretch) => stretch.isStopped)).toEqual([
      false,
      true
    ])
    output.clock = 0.25
    player.addFrame(buildSilentFrame(24_000))
    expect(output.played[2]?.startAt).toBe(0.25)
  })

  it("resumes the output on every start and frame", () => {
    const output = createFakeOutput()
    const player = createPcmPlayer(() => output)
    player.start()
    player.addFrame(buildSilentFrame(1))
    expect(output.starts).toBe(2)
  })

  it("closes the output once, stopping its frames, and ignores later frames", () => {
    const output = createFakeOutput()
    const player = createPcmPlayer(() => output)
    player.addFrame(buildSilentFrame(24_000))
    player.close()
    player.close()
    expect(output.isClosed).toBe(true)
    expect(output.played[0]?.isStopped).toBe(true)
    player.addFrame(buildSilentFrame(24_000))
    player.start()
    expect(output.played).toHaveLength(1)
    expect(output.starts).toBe(1)
  })

  it("closes nothing when it never created its output", () => {
    let created = 0
    const player = createPcmPlayer(() => {
      created += 1
      return createFakeOutput()
    })
    player.close()
    expect(created).toBe(0)
  })
})
