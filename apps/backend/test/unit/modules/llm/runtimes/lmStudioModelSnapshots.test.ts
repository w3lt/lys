import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  createDownloadedLlmModelSnapshot,
  createLoadedLlmModelInstanceSnapshot
} from "../../../../../src/modules/llm/runtimes/lmStudioModelSnapshots"
import {
  createDownloadedLlmModel,
  createLmStudioLlmRecord
} from "../../../support/llmFixtures"

describe("createDownloadedLlmModelSnapshot", () => {
  it("projects LM Studio metadata without the vendor discriminator", () => {
    const record = createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })

    const snapshot = createDownloadedLlmModelSnapshot(record)

    expect(snapshot).toEqual({
      modelKey: "qwen/qwen3-8b",
      format: "gguf",
      displayName: "Display qwen/qwen3-8b",
      path: "qwen/qwen3-8b/model.gguf",
      sizeBytes: 4096,
      paramsString: "7B",
      architecture: "llama",
      quantization: { name: "Q4_K_M", bits: 4 },
      vision: false,
      trainedForToolUse: false,
      maxContextLength: 8192
    })
    expect(snapshot).not.toHaveProperty("type")
    expect(snapshot).not.toHaveProperty("loaded")
  })

  it("removes vendor fields the application does not consume", () => {
    const record = {
      ...createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" }),
      publisher: "qwen",
      indexedModelIdentifier: "qwen/qwen3-8b@q4"
    }

    const snapshot = createDownloadedLlmModelSnapshot(record)

    expect(snapshot).not.toHaveProperty("publisher")
    expect(snapshot).not.toHaveProperty("indexedModelIdentifier")
  })

  it("omits optional metadata the runtime did not report", () => {
    const snapshot = createDownloadedLlmModelSnapshot({
      ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
      type: "llm",
      paramsString: undefined
    })

    expect(Object.keys(snapshot)).not.toContain("paramsString")
    expect(Object.keys(snapshot)).not.toContain("architecture")
    expect(Object.keys(snapshot)).not.toContain("quantization")
  })

  it("returns a new frozen snapshot with a copied frozen quantization", () => {
    const record = createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })

    const snapshot = createDownloadedLlmModelSnapshot(record)

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.quantization)).toBe(true)
    expect(snapshot.quantization).not.toBe(record.quantization)
  })

  it.each([
    [
      "a record from another model domain",
      { ...createLmStudioLlmRecord({ modelKey: "embed" }), type: "embedding" }
    ],
    [
      "an empty model key",
      { ...createLmStudioLlmRecord({ modelKey: "qwen" }), modelKey: "" }
    ],
    [
      "an unknown model format",
      { ...createLmStudioLlmRecord({ modelKey: "qwen" }), format: "zip" }
    ],
    ["a value that is not a record", "qwen/qwen3-8b"]
  ])("rejects %s as invalid model metadata", (_label, candidate) => {
    let caught: unknown
    try {
      createDownloadedLlmModelSnapshot(candidate)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({
      message: "The LLM runtime returned invalid model metadata.",
      cause: expect.any(z.ZodError)
    })
  })
})

describe("createLoadedLlmModelInstanceSnapshot", () => {
  it("copies the canonical key and instance identifier from an SDK handle", () => {
    const handle = {
      modelKey: "qwen/qwen3-8b",
      identifier: "qwen/qwen3-8b:2",
      path: "qwen/qwen3-8b/model.gguf",
      unload: async () => undefined
    }

    const snapshot = createLoadedLlmModelInstanceSnapshot(handle)

    expect(snapshot).toEqual({
      modelKey: "qwen/qwen3-8b",
      modelIdentifier: "qwen/qwen3-8b:2"
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it.each([
    ["an empty model key", { modelKey: "", identifier: "id" }],
    ["an empty identifier", { modelKey: "qwen", identifier: "" }],
    ["a missing identifier", { modelKey: "qwen" }],
    ["a value that is not a handle", null]
  ])("rejects %s as an invalid model instance", (_label, candidate) => {
    let caught: unknown
    try {
      createLoadedLlmModelInstanceSnapshot(candidate)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({
      message: "The LLM runtime returned an invalid model instance.",
      cause: expect.any(z.ZodError)
    })
  })
})
