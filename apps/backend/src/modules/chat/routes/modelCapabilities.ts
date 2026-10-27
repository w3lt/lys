import {
  isSameLlmProviderAccess,
  type LlmProviderAccess
} from "../../llm/llmProviderAccess"
import type { DownloadedLlmModel } from "../../llm/llmRuntimeTypes"

/** What a turn needs to know about the model that answers it. */
export type ModelCapabilities = Readonly<{
  /** Whether the model sees images. */
  vision: boolean
  /** Whether the model is trained for tool use, so it can be offered tools. */
  trainedForToolUse: boolean
}>

/**
 * Finds the capabilities of one model.
 *
 * @param model - Model a request names, which is the provider's model key.
 * @returns A promise resolving to the capabilities, or to undefined when no
 * downloaded model has the key.
 * @throws If the inventory cannot be read: no provider is connected or it
 * cannot be reached, or the model-operation queue is full.
 */
export type FindModelCapabilities = (
  model: string
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
 * Finds what a model the inventory lists can do with a turn.
 *
 * @param model - Model the request names.
 * @param findModelCapabilities - Inventory lookup.
 * @returns A promise resolving to the model's capabilities, or to
 * {@link NO_MODEL_CAPABILITIES} when the inventory does not list the model.
 * @throws The lookup's failure.
 */
export async function findListedModelCapabilities(
  model: string,
  findModelCapabilities: FindModelCapabilities
): Promise<ModelCapabilities> {
  return (await findModelCapabilities(model)) ?? NO_MODEL_CAPABILITIES
}

/** Capabilities remembered for the provider they were listed by. */
type RememberedCapabilities = Readonly<{
  /** Provider whose listings the capabilities come from. */
  access: LlmProviderAccess
  /** Capabilities by model key. */
  capabilities: Map<string, ModelCapabilities>
}>

/**
 * Creates the capability lookup over the downloaded models, which remembers
 * each listed model's capabilities for the connected provider.
 *
 * @param listDownloadedLlmModels - Downloaded-model query of the LLM service;
 * borrowed for the lookup's lifetime.
 * @param findConnectedLlmProvider - Finds the provider the runtime service is
 * connected to, or undefined while none is; borrowed for the lookup's
 * lifetime.
 * @returns The lookup, which matches the model key exactly. The first lookup
 * of a model lists the downloaded models; once a listing has the model, its
 * capabilities are remembered and later lookups of it list nothing while the
 * same provider stays connected. Connecting another provider, or the same
 * one at another address or with another key, forgets every remembered
 * model. A model the listing does not have, a failed listing, a listing made
 * while no provider is connected, and a listing during which the connected
 * provider changed are not remembered, so the next lookup lists again. It
 * reads no loaded state, which the capabilities do not depend on.
 * @remarks A model's capabilities come from its provider's metadata, so they
 * are taken not to change while the backend stays connected to it; a restart
 * reads them again. Concurrent first lookups of one model may each list.
 * Concurrency model: single-owner, on the backend's event loop.
 */
export function createModelCapabilitiesLookup(
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
