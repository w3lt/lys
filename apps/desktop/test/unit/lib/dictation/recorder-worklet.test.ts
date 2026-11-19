import { describe, expect, it, vi } from "vitest"
import { DICTATION_RECORDER_PROCESSOR } from "@/lib/dictation/recorder-contract"

/** A message the processor posted to its node. */
type PostedMessage = Readonly<{
  /** The message's data. */
  data: unknown
  /** Objects transferred with it. */
  transfer: readonly unknown[]
}>

/** Stand-in for the worklet's processor base class. */
class FakeAudioWorkletProcessor {
  /** Messages posted to the node, in order. */
  public static readonly posted: PostedMessage[] = []
  /** The port to the node. */
  public readonly port = {
    postMessage: (data: unknown, transfer: readonly unknown[]) => {
      FakeAudioWorkletProcessor.posted.push({ data, transfer })
    }
  }
}

/** The processor the worklet module registers, as the test drives it. */
type RecorderProcessor = Readonly<{
  /** Takes one block of input. */
  process: (inputs: readonly (readonly Float32Array[])[]) => boolean
}>

/** Constructor of the registered processor. */
type RecorderProcessorClass = new (init: {
  processorOptions: { frameSampleRate: number; frameSamples: number }
}) => RecorderProcessor

/**
 * Loads the worklet module in a fake worklet scope at 48 kHz.
 *
 * @returns The name and the class the module registered.
 */
async function loadWorkletModule() {
  const registerProcessor =
    vi.fn<(name: string, processor: RecorderProcessorClass) => void>()
  FakeAudioWorkletProcessor.posted.length = 0
  vi.stubGlobal("AudioWorkletProcessor", FakeAudioWorkletProcessor)
  vi.stubGlobal("registerProcessor", registerProcessor)
  vi.stubGlobal("sampleRate", 48_000)
  vi.resetModules()
  await import("@/lib/dictation/recorder-worklet")
  const registration = registerProcessor.mock.calls[0]
  if (registration === undefined) throw new Error("nothing was registered")
  return { name: registration[0], Processor: registration[1] }
}

describe("recorder worklet", () => {
  it("registers its processor under the recorder's name", async () => {
    const { name } = await loadWorkletModule()

    expect(name).toBe(DICTATION_RECORDER_PROCESSOR)
  })

  it("posts each frame of 16 kHz audio to its node and transfers its buffer", async () => {
    const { Processor } = await loadWorkletModule()
    const processor = new Processor({
      processorOptions: { frameSampleRate: 16_000, frameSamples: 1_600 }
    })
    const block = new Float32Array(128).fill(0.25)
    for (let count = 0; count < 40; count += 1) processor.process([[block]])

    expect(FakeAudioWorkletProcessor.posted).toHaveLength(1)
    const [message] = FakeAudioWorkletProcessor.posted
    expect(message?.data).toBeInstanceOf(ArrayBuffer)
    expect(message?.data).toHaveProperty("byteLength", 3_200)
    expect(message?.transfer).toEqual([message?.data])
  })

  it("stays alive, and posts nothing, while its input has no channel", async () => {
    const { Processor } = await loadWorkletModule()
    const processor = new Processor({
      processorOptions: { frameSampleRate: 16_000, frameSamples: 1_600 }
    })

    expect(processor.process([[]])).toBe(true)
    expect(processor.process([])).toBe(true)
    expect(FakeAudioWorkletProcessor.posted).toEqual([])
  })
})
