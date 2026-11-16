import { describe, expect, it } from "vitest"
import { decodePcm16Le } from "@/lib/speech/pcm-player"

describe("decodePcm16Le", () => {
  it("decodes little-endian 16-bit samples to floats in [-1, 1)", () => {
    // 0x0000, 0x7FFF (max), 0x8000 (min), 0xFFFF (-1)
    const frame = new Uint8Array([
      0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff
    ])

    const samples = decodePcm16Le(frame)

    expect(samples).toHaveLength(4)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBeCloseTo(32767 / 32768, 6)
    expect(samples[2]).toBe(-1)
    expect(samples[3]).toBeCloseTo(-1 / 32768, 6)
  })

  it("drops a trailing odd byte", () => {
    const frame = new Uint8Array([0x34, 0x12, 0x99])

    expect([...decodePcm16Le(frame)]).toEqual([0x1234 / 32768])
  })

  it("decodes nothing for an empty frame", () => {
    expect(decodePcm16Le(new Uint8Array(0))).toHaveLength(0)
  })
})
