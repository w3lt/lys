import {
  groqApiKeySchema,
  LLM_PROVIDERS,
  type LlmModelReference
} from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  createLlmModelCapabilitiesLookup,
  createModelCapabilitiesLookup,
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

/** Groq with a synthetic key; not a real credential. */
const GROQ_ACCESS: LlmProviderAccess = Object.freeze({
  provider: "groq",
  apiKey: groqApiKeySchema.parse("gsk_synthetic_0123456789")
})

/** Finds LM Studio connected, as most cases need. */
const findLmStudioConnected = () => DEFAULT_LM_STUDIO_ACCESS

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
 * Creates each provider's source, connected as
 * {@link TEST_LLM_PROVIDER_ACCESSES} reaches it, whose listing is a spy that
 * lists no model until a case configures it.
 *
 * @returns Each provider's source and its listing spy.
 */
function createProviderSources() {
  const listings = buildLlmProviderRecord(() =>
    vi.fn(async (): Promise<readonly DownloadedLlmModel[]> => [])
  )
  const sources = buildLlmProviderRecord(
    (provider): ModelCapabilitiesSource => ({
      llmService: { listDownloadedLlmModels: listings[provider] },
      llmRuntimeService: {
        connectedLlmProviderAccess: TEST_LLM_PROVIDER_ACCESSES[provider]
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
})

describe("createModelCapabilitiesLookup", () => {
  it("answers with the matching model's capabilities, listing the downloaded models once per model", async () => {
    const listDownloadedLlmModels = vi.fn(async () => [
      TEXT_MODEL,
      VISION_MODEL
    ])
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels,
      findLmStudioConnected
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
      listDownloadedLlmModels,
      findLmStudioConnected
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
      listDownloadedLlmModels,
      findLmStudioConnected
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
      listDownloadedLlmModels,
      findLmStudioConnected
    )

    await expect(findModelCapabilities("qwen/qwen3-8b")).rejects.toBe(failure)
    await expect(findModelCapabilities("qwen/qwen3-8b")).resolves.toEqual({
      vision: false,
      trainedForToolUse: true
    })

    expect(listDownloadedLlmModels).toHaveBeenCalledTimes(2)
  })

  it("resolves to undefined for a model the inventory does not list, matching the key exactly", async () => {
    const findModelCapabilities = createModelCapabilitiesLookup(
      async () => [TEXT_MODEL],
      findLmStudioConnected
    )

    await expect(
      findModelCapabilities("qwen/qwen3-8b-2")
    ).resolves.toBeUndefined()
    await expect(
      findModelCapabilities("QWEN/QWEN3-8B")
    ).resolves.toBeUndefined()
  })

  it("rejects with the inventory read's failure", async () => {
    const failure = new Error("queue full")
    const findModelCapabilities = createModelCapabilitiesLookup(
      () => Promise.reject(failure),
      findLmStudioConnected
    )

    await expect(findModelCapabilities("qwen/qwen3-8b")).rejects.toBe(failure)
  })

  it("forgets every remembered model when another provider connects", async () => {
    let connected: LlmProviderAccess | undefined = DEFAULT_LM_STUDIO_ACCESS
    const listDownloadedLlmModels = vi.fn(async () => [TEXT_MODEL])
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels,
      () => connected
    )

    await findModelCapabilities("qwen/qwen3-8b")
    connected = GROQ_ACCESS
    listDownloadedLlmModels.mockResolvedValue([
      { ...TEXT_MODEL, trainedForToolUse: false }
    ])
    const afterSwitch = await findModelCapabilities("qwen/qwen3-8b")
    await findModelCapabilities("qwen/qwen3-8b")

    expect(afterSwitch).toEqual({ vision: false, trainedForToolUse: false })
    expect(listDownloadedLlmModels).toHaveBeenCalledTimes(2)
  })

  it("remembers nothing listed while no provider is connected or while the provider changed", async () => {
    const connections: (LlmProviderAccess | undefined)[] = [
      undefined,
      undefined,
      DEFAULT_LM_STUDIO_ACCESS,
      GROQ_ACCESS
    ]
    let connected: LlmProviderAccess | undefined = undefined
    const listDownloadedLlmModels = vi.fn(async () => [TEXT_MODEL])
    const findModelCapabilities = createModelCapabilitiesLookup(
      listDownloadedLlmModels,
      () => {
        connected = connections.shift() ?? connected
        return connected
      }
    )

    await findModelCapabilities("qwen/qwen3-8b")
    await findModelCapabilities("qwen/qwen3-8b")
    await findModelCapabilities("qwen/qwen3-8b")

    expect(listDownloadedLlmModels).toHaveBeenCalledTimes(3)
  })
})
