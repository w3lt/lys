import { describe, expect, it, vi } from "vitest"
import {
  createModelCapabilitiesLookup,
  findListedModelCapabilities,
  NO_MODEL_CAPABILITIES
} from "../../../../../src/modules/chat/routes/modelCapabilities"
import type { DownloadedLlmModel } from "../../../../../src/modules/llm/llmRuntimeTypes"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"

/** A downloaded model that sees images and uses tools. */
const VISION_MODEL: DownloadedLlmModel = Object.freeze({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen2.5-vl-7b" }),
  vision: true,
  trainedForToolUse: true
})

/** A downloaded text-only model. */
const TEXT_MODEL: DownloadedLlmModel = Object.freeze({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
  vision: false,
  trainedForToolUse: true
})

describe("NO_MODEL_CAPABILITIES", () => {
  it("sees no image and is offered no tool", () => {
    expect(NO_MODEL_CAPABILITIES).toEqual({
      vision: false,
      trainedForToolUse: false
    })
    expect(Object.isFrozen(NO_MODEL_CAPABILITIES)).toBe(true)
  })
})

describe("findListedModelCapabilities", () => {
  it("answers with the capabilities the inventory lists for the model", async () => {
    const capabilities = { vision: false, trainedForToolUse: true }
    const findModelCapabilities = vi.fn(async () => capabilities)

    await expect(
      findListedModelCapabilities("qwen/qwen3-8b", findModelCapabilities)
    ).resolves.toBe(capabilities)
    expect(findModelCapabilities).toHaveBeenCalledExactlyOnceWith(
      "qwen/qwen3-8b"
    )
  })

  it("answers with no capability for a model the inventory does not list", async () => {
    await expect(
      findListedModelCapabilities("qwen/qwen3-8b", async () => undefined)
    ).resolves.toBe(NO_MODEL_CAPABILITIES)
  })

  it("rejects with the lookup's failure", async () => {
    const failure = new Error("queue full")

    await expect(
      findListedModelCapabilities("qwen/qwen3-8b", () =>
        Promise.reject(failure)
      )
    ).rejects.toBe(failure)
  })
})

describe("createModelCapabilitiesLookup", () => {
  it("answers with the matching model's capabilities, listing the downloaded models once per model", async () => {
    const listDownloadedLlmModels = vi.fn(async () => [
      TEXT_MODEL,
      VISION_MODEL
    ])
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels
    )

    const vision = await findModelCapabilities("qwen/qwen2.5-vl-7b")
    const text = await findModelCapabilities("qwen/qwen3-8b")

    expect(vision).toEqual({ vision: true, trainedForToolUse: true })
    expect(Object.isFrozen(vision)).toBe(true)
    expect(text).toEqual({ vision: false, trainedForToolUse: true })
    expect(listDownloadedLlmModels).toHaveBeenCalledTimes(2)
  })

  it("remembers a listed model's capabilities, so later lookups of it list nothing", async () => {
    const listDownloadedLlmModels = vi.fn(async () => [TEXT_MODEL])
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels
    )

    const first = await findModelCapabilities("qwen/qwen3-8b")
    listDownloadedLlmModels.mockResolvedValue([])
    const second = await findModelCapabilities("qwen/qwen3-8b")

    expect(second).toBe(first)
    expect(listDownloadedLlmModels).toHaveBeenCalledOnce()
  })

  it("lists again for a model the inventory did not list, and remembers it once listed", async () => {
    const listDownloadedLlmModels = vi.fn(
      async (): Promise<readonly DownloadedLlmModel[]> => []
    )
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels
    )

    await expect(
      findModelCapabilities("qwen/qwen3-8b")
    ).resolves.toBeUndefined()
    listDownloadedLlmModels.mockResolvedValue([TEXT_MODEL])
    await expect(findModelCapabilities("qwen/qwen3-8b")).resolves.toEqual({
      vision: false,
      trainedForToolUse: true
    })
    await findModelCapabilities("qwen/qwen3-8b")

    expect(listDownloadedLlmModels).toHaveBeenCalledTimes(2)
  })

  it("lists again after a failed listing", async () => {
    const failure = new Error("queue full")
    const listDownloadedLlmModels = vi
      .fn(async (): Promise<readonly DownloadedLlmModel[]> => [TEXT_MODEL])
      .mockRejectedValueOnce(failure)
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels
    )

    await expect(findModelCapabilities("qwen/qwen3-8b")).rejects.toBe(failure)
    await expect(findModelCapabilities("qwen/qwen3-8b")).resolves.toEqual({
      vision: false,
      trainedForToolUse: true
    })

    expect(listDownloadedLlmModels).toHaveBeenCalledTimes(2)
  })

  it("resolves to undefined for a model the inventory does not list, matching the key exactly", async () => {
    const findModelCapabilities = createModelCapabilitiesLookup(async () => [
      TEXT_MODEL
    ])

    await expect(
      findModelCapabilities("qwen/qwen3-8b-2")
    ).resolves.toBeUndefined()
    await expect(
      findModelCapabilities("QWEN/QWEN3-8B")
    ).resolves.toBeUndefined()
  })

  it("rejects with the inventory read's failure", async () => {
    const failure = new Error("queue full")
    const findModelCapabilities = createModelCapabilitiesLookup(() =>
      Promise.reject(failure)
    )

    await expect(findModelCapabilities("qwen/qwen3-8b")).rejects.toBe(failure)
  })
})
