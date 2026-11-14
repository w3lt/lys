import type { LlmModelReference } from "@lys/share"
import {
  isSameLlmProviderAccess,
  type LlmProviderAccess
} from "../../llm/llmProviderAccess"
import {
  buildLlmProviderRecord,
  type LlmProviderRecord
} from "../../llm/llmProviderServices"
import type LlmRuntimeService from "../../llm/llmRuntimeService"
import type { DownloadedLlmModel } from "../../llm/llmRuntimeTypes"
import type LlmService from "../../llm/llmService"

/** What a turn needs to know about the model that answers it. */
export type ModelCapabilities = Readonly<{
  /** Whether the model sees images. */
  vision: boolean
  /** Whether the model is trained for tool use, so it can be offered tools. */
  trainedForToolUse: boolean
}>

/**
 * Finds the capabilities of one model on one provider.
 *
 * @param model - Key the provider lists the model under.
 * @returns A promise resolving to the capabilities, or to undefined when no
 * model the provider has downloaded has the key.
 * @throws If the inventory cannot be read: the provider is not connected or
 * cannot be reached, or its model-operation queue is full.
 */
type FindModelCapabilities = (
  model: string
) => Promise<ModelCapabilities | undefined>

/**
 * Finds the capabilities of one model on the provider a request names.
 *
 * @param model - Model a request names: its provider and its key there.
 * @returns A promise resolving to the capabilities, or to undefined when no
 * model that provider has downloaded has the key.
 * @throws If that provider's inventory cannot be read: it is not connected
 * or cannot be reached, or its model-operation queue is full.
 */
export type FindLlmModelCapabilities = (
  model: LlmModelReference
) => Promise<ModelCapabilities | undefined>

/**
 * Capabilities applied when the model is not in the inventory: the model sees
 * no image and is offered no tool the backend adds for it.
 */
export const NO_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  vision: false,
  trainedForToolUse: false
})

/**
 * Finds what a model its provider's inventory lists can do with a turn.
 *
 * @param model - Model the request names, and its provider.
 * @param findModelCapabilities - Inventory lookup.
 * @returns A promise resolving to the model's capabilities, or to
 * {@link NO_MODEL_CAPABILITIES} when the provider's inventory does not list
 * the model.
 * @throws The lookup's failure.
 */
export async function findListedModelCapabilities(
  model: LlmModelReference,
  findModelCapabilities: FindLlmModelCapabilities
): Promise<ModelCapabilities> {
  return (await findModelCapabilities(model)) ?? NO_MODEL_CAPABILITIES
}

/** What the capability lookup reads from one provider's services. */
export type ModelCapabilitiesSource = Readonly<{
  /** Lists the provider's downloaded models. */
  llmService: Pick<LlmService, "listDownloadedLlmModels">
  /** Tells how the provider is reached while it is connected. */
  llmRuntimeService: Pick<LlmRuntimeService, "connectedLlmProviderAccess">
}>

/**
 * Creates the capability lookup of models on every provider, one
 * {@link createModelCapabilitiesLookup} lookup for each provider.
 *
 * @param sources - Each provider's services; borrowed for the lookup's
 * lifetime.
 * @returns The lookup, which asks only the named provider's lookup for the
 * model's key, so the same key on two providers names two models whose
 * capabilities are listed and remembered apart.
 */
export function createLlmModelCapabilitiesLookup(
  sources: LlmProviderRecord<ModelCapabilitiesSource>
): FindLlmModelCapabilities {
  const findProviderModelCapabilities = buildLlmProviderRecord((provider) =>
    createModelCapabilitiesLookup(
      () => sources[provider].llmService.listDownloadedLlmModels(),
      () => sources[provider].llmRuntimeService.connectedLlmProviderAccess
    )
  )
  return async (model) =>
    await findProviderModelCapabilities[model.provider](model.modelKey)
}

/** Capabilities remembered for the provider they were listed by. */
type RememberedCapabilities = Readonly<{
  /** Provider whose listings the capabilities come from. */
  access: LlmProviderAccess
  /** Capabilities by model key. */
  capabilities: Map<string, ModelCapabilities>
}>

/**
 * Creates the capability lookup over one provider's downloaded models, which
 * remembers each listed model's capabilities for that provider as connected.
 *
 * @param listDownloadedLlmModels - Downloaded-model query of the provider's
 * LLM service; borrowed for the lookup's lifetime.
 * @param findConnectedLlmProvider - Finds how the provider's runtime service
 * is connected, or undefined while it is not; borrowed for the lookup's
 * lifetime.
 * @returns The lookup, which matches the model key exactly. The first lookup
 * of a model lists the downloaded models; once a listing has the model, its
 * capabilities are remembered and later lookups of it list nothing while the
 * provider stays connected the same way. Reconnecting the provider at
 * another address or with another key forgets every remembered model. A
 * model the listing does not have, a failed listing, a listing made while
 * the provider is not connected, and a listing during which its connection
 * changed are not remembered, so the next lookup lists again. It reads no
 * loaded state, which the capabilities do not depend on.
 * @remarks A model's capabilities come from its provider's metadata, so they
 * are taken not to change while the backend stays connected to it; a restart
 * reads them again. Concurrent first lookups of one model may each list.
 * Concurrency model: single-owner, on the backend's event loop.
 */
function createModelCapabilitiesLookup(
  listDownloadedLlmModels: () => Promise<readonly DownloadedLlmModel[]>,
  findConnectedLlmProvider: () => LlmProviderAccess | undefined
): FindModelCapabilities {
  let remembered: RememberedCapabilities | undefined = undefined
  return async (model) => {
    const listedBy = findConnectedLlmProvider()
    if (
      remembered !== undefined &&
      (listedBy === undefined ||
        !isSameLlmProviderAccess(remembered.access, listedBy))
    ) {
      remembered = undefined
    }
    const known = remembered?.capabilities.get(model)
    if (known !== undefined) return known
    const info = (await listDownloadedLlmModels()).find(
      (entry) => entry.modelKey === model
    )
    if (info === undefined) return undefined
    const capabilities = Object.freeze({
      vision: info.vision,
      trainedForToolUse: info.trainedForToolUse
    })
    const connected = findConnectedLlmProvider()
    if (
      listedBy !== undefined &&
      connected !== undefined &&
      isSameLlmProviderAccess(listedBy, connected)
    ) {
      if (
        remembered === undefined ||
        !isSameLlmProviderAccess(remembered.access, listedBy)
      ) {
        remembered = Object.freeze({
          access: listedBy,
          capabilities: new Map()
        })
      }
      remembered.capabilities.set(model, capabilities)
    }
    return capabilities
  }
}
