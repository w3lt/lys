import {
  LLM_PROVIDERS,
  providerAddressSchema,
  type LlmModelReference
} from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  createLlmModelCapabilitiesLookup,
  findListedModelCapabilities,
  NO_MODEL_CAPABILITIES,
  type ModelCapabilitiesSource
} from "../../../../../src/modules/chat/routes/modelCapabilities"
import { buildLlmProviderRecord } from "../../../../../src/modules/llm/llmProviderServices"
import type { LlmProviderAccess } from "../../../../../src/modules/llm/llmProviderAccess"
import type { DownloadedLlmModel } from "../../../../../src/modules/llm/llmRuntimeTypes"
import {
  createDownloadedLlmModel,
  DEFAULT_LM_STUDIO_ACCESS,
  LM_STUDIO_QWEN3_8B,
  TEST_LLM_PROVIDER_ACCESSES
} from "../../../support/llmFixtures"

/** LM Studio reached at an address other than its default. */
const OTHER_LM_STUDIO_ACCESS: LlmProviderAccess = Object.freeze({
  provider: "lmStudio",
  address: providerAddressSchema.parse("studio-box.local:4321")
})

/** A downloaded model that sees images and uses tools. */
const VISION_MODEL: DownloadedLlmModel = Object.freeze({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen2.5-vl-7b" }),
  vision: true,
  trainedForToolUse: true
})

/** {@link VISION_MODEL} on LM Studio. */
const LM_STUDIO_QWEN2_5_VL_7B: LlmModelReference = Object.freeze({
  provider: "lmStudio",
  modelKey: VISION_MODEL.modelKey
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
      findListedModelCapabilities(LM_STUDIO_QWEN3_8B, findModelCapabilities)
    ).resolves.toBe(capabilities)
    expect(findModelCapabilities).toHaveBeenCalledExactlyOnceWith(
      LM_STUDIO_QWEN3_8B
    )
  })

  it("answers with no capability for a model the inventory does not list", async () => {
    await expect(
      findListedModelCapabilities(LM_STUDIO_QWEN3_8B, async () => undefined)
    ).resolves.toBe(NO_MODEL_CAPABILITIES)
  })

  it("rejects with the lookup's failure", async () => {
    const failure = new Error("queue full")

    await expect(
      findListedModelCapabilities(LM_STUDIO_QWEN3_8B, () =>
        Promise.reject(failure)
      )
    ).rejects.toBe(failure)
  })
})

/**
 * Creates each provider's source, whose listing is a spy that lists no model
 * until a case configures it. LM Studio is connected as the case's finder
 * says, read at every lookup; every other provider is connected as
 * {@link TEST_LLM_PROVIDER_ACCESSES} reaches it.
 *
 * @param findLmStudioConnection - Finds how LM Studio is connected, or
 * undefined while it is not; LM Studio at its default address unless a case
 * varies it.
 * @returns Each provider's source and its listing spy.
 */
function createProviderSources(
  findLmStudioConnection: () => LlmProviderAccess | undefined = () =>
    DEFAULT_LM_STUDIO_ACCESS
) {
  const listings = buildLlmProviderRecord(() =>
    vi.fn(async (): Promise<readonly DownloadedLlmModel[]> => [])
  )
  const sources = buildLlmProviderRecord(
    (provider): ModelCapabilitiesSource => ({
      llmService: { listDownloadedLlmModels: listings[provider] },
      llmRuntimeService: {
        get connectedLlmProviderAccess() {
          return provider === "lmStudio"
            ? findLmStudioConnection()
            : TEST_LLM_PROVIDER_ACCESSES[provider]
        }
      }
    })
  )
  return { sources, listings }
}

describe("createLlmModelCapabilitiesLookup", () => {
  it("lists only the downloaded models of the provider the model names", async () => {
    const { sources, listings } = createProviderSources()
    listings.ollama.mockResolvedValue([VISION_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    const capabilities = await findModelCapabilities({
      provider: "ollama",
      modelKey: VISION_MODEL.modelKey
    })

    expect(capabilities).toEqual({ vision: true, trainedForToolUse: true })
    expect(
      LLM_PROVIDERS.map((provider) => listings[provider].mock.calls.length)
    ).toEqual(LLM_PROVIDERS.map((provider) => (provider === "ollama" ? 1 : 0)))
  })

  it("finds and remembers the same key on two providers as two models", async () => {
    const { sources, listings } = createProviderSources()
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    listings.groq.mockResolvedValue([
      { ...TEXT_MODEL, trainedForToolUse: false }
    ])
    const groqModel: LlmModelReference = {
      provider: "groq",
      modelKey: TEXT_MODEL.modelKey
    }
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    const onLmStudio = await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    const onGroq = await findModelCapabilities(groqModel)
    await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    await findModelCapabilities(groqModel)

    expect(onLmStudio).toEqual({ vision: false, trainedForToolUse: true })
    expect(onGroq).toEqual({ vision: false, trainedForToolUse: false })
    expect(listings.lmStudio).toHaveBeenCalledOnce()
    expect(listings.groq).toHaveBeenCalledOnce()
  })

  it("rejects with the named provider's failure and still finds another provider's models", async () => {
    const { sources, listings } = createProviderSources()
    const failure = new Error("The model provider is not reachable.")
    listings.groq.mockRejectedValue(failure)
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    await expect(
      findModelCapabilities({ provider: "groq", modelKey: TEXT_MODEL.modelKey })
    ).rejects.toBe(failure)
    await expect(findModelCapabilities(LM_STUDIO_QWEN3_8B)).resolves.toEqual({
      vision: false,
      trainedForToolUse: true
    })
  })

  it("answers with the matching model's capabilities, listing the provider's downloaded models once per model", async () => {
    const { sources, listings } = createProviderSources()
    listings.lmStudio.mockResolvedValue([TEXT_MODEL, VISION_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    const vision = await findModelCapabilities(LM_STUDIO_QWEN2_5_VL_7B)
    const text = await findModelCapabilities(LM_STUDIO_QWEN3_8B)

    expect(vision).toEqual({ vision: true, trainedForToolUse: true })
    expect(Object.isFrozen(vision)).toBe(true)
    expect(text).toEqual({ vision: false, trainedForToolUse: true })
    expect(listings.lmStudio).toHaveBeenCalledTimes(2)
  })

  it("remembers a listed model's capabilities, so later lookups of it list nothing", async () => {
    const { sources, listings } = createProviderSources()
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    const first = await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    listings.lmStudio.mockResolvedValue([])
    const second = await findModelCapabilities(LM_STUDIO_QWEN3_8B)

    expect(second).toBe(first)
    expect(listings.lmStudio).toHaveBeenCalledOnce()
  })

  it("lists again for a model the inventory did not list, and remembers it once listed", async () => {
    const { sources, listings } = createProviderSources()
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    await expect(
      findModelCapabilities(LM_STUDIO_QWEN3_8B)
    ).resolves.toBeUndefined()
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    await expect(findModelCapabilities(LM_STUDIO_QWEN3_8B)).resolves.toEqual({
      vision: false,
      trainedForToolUse: true
    })
    await findModelCapabilities(LM_STUDIO_QWEN3_8B)

    expect(listings.lmStudio).toHaveBeenCalledTimes(2)
  })

  it("lists again after a failed listing", async () => {
    const { sources, listings } = createProviderSources()
    const failure = new Error("queue full")
    listings.lmStudio
      .mockResolvedValue([TEXT_MODEL])
      .mockRejectedValueOnce(failure)
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    await expect(findModelCapabilities(LM_STUDIO_QWEN3_8B)).rejects.toBe(
      failure
    )
    await expect(findModelCapabilities(LM_STUDIO_QWEN3_8B)).resolves.toEqual({
      vision: false,
      trainedForToolUse: true
    })

    expect(listings.lmStudio).toHaveBeenCalledTimes(2)
  })

  it("resolves to undefined for a model the inventory does not list, matching the key exactly", async () => {
    const { sources, listings } = createProviderSources()
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    await expect(
      findModelCapabilities({
        provider: "lmStudio",
        modelKey: "qwen/qwen3-8b-2"
      })
    ).resolves.toBeUndefined()
    await expect(
      findModelCapabilities({ provider: "lmStudio", modelKey: "QWEN/QWEN3-8B" })
    ).resolves.toBeUndefined()
  })

  it("forgets every remembered model when the provider reconnects at another address", async () => {
    let connected: LlmProviderAccess | undefined = DEFAULT_LM_STUDIO_ACCESS
    const { sources, listings } = createProviderSources(() => connected)
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    connected = OTHER_LM_STUDIO_ACCESS
    listings.lmStudio.mockResolvedValue([
      { ...TEXT_MODEL, trainedForToolUse: false }
    ])
    const afterReconnect = await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    await findModelCapabilities(LM_STUDIO_QWEN3_8B)

    expect(afterReconnect).toEqual({ vision: false, trainedForToolUse: false })
    expect(listings.lmStudio).toHaveBeenCalledTimes(2)
  })

  it("remembers nothing listed while the provider is not connected or while its connection changed", async () => {
    const connections: (LlmProviderAccess | undefined)[] = [
      undefined,
      undefined,
      DEFAULT_LM_STUDIO_ACCESS,
      OTHER_LM_STUDIO_ACCESS
    ]
    let connected: LlmProviderAccess | undefined = undefined
    const { sources, listings } = createProviderSources(() => {
      connected = connections.shift() ?? connected
      return connected
    })
    listings.lmStudio.mockResolvedValue([TEXT_MODEL])
    const findModelCapabilities = createLlmModelCapabilitiesLookup(sources)

    await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    await findModelCapabilities(LM_STUDIO_QWEN3_8B)
    await findModelCapabilities(LM_STUDIO_QWEN3_8B)

    expect(listings.lmStudio).toHaveBeenCalledTimes(3)
  })
})
