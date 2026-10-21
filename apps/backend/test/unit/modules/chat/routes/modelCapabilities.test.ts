import type { LlmInfo } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import {
  createModelCapabilitiesLookup,
  findListedModelCapabilities,
  NO_MODEL_CAPABILITIES
} from "../../../../../src/modules/chat/routes/modelCapabilities"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"

/** A downloaded model that sees images and uses tools. */
const VISION_MODEL: LlmInfo = Object.freeze({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen2.5-vl-7b" }),
  vision: true,
  trainedForToolUse: true,
  loaded: false
})

/** A downloaded text-only model. */
const TEXT_MODEL: LlmInfo = Object.freeze({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
  vision: false,
  trainedForToolUse: true,
  loaded: true
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
  it("reads the inventory on each call and answers with the matching model's capabilities", async () => {
    const listLlmModels = vi.fn(async () => [TEXT_MODEL, VISION_MODEL])
    const findModelCapabilities = createModelCapabilitiesLookup(listLlmModels)

    const vision = await findModelCapabilities("qwen/qwen2.5-vl-7b")
    const text = await findModelCapabilities("qwen/qwen3-8b")

    expect(vision).toEqual({ vision: true, trainedForToolUse: true })
    expect(Object.isFrozen(vision)).toBe(true)
    expect(text).toEqual({ vision: false, trainedForToolUse: true })
    expect(listLlmModels).toHaveBeenCalledTimes(2)
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
