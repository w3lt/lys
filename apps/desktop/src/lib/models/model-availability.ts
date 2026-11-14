import type { LlmInfo, LlmModelLoading } from "@lys/protocol"
import { LLM_PROVIDERS, type LlmModelReference } from "@lys/share"

import {
  calculateProviderAvailability,
  type ModelAvailabilitySource
} from "./provider-connection"

/**
 * Whether one model can answer a chat request now, and why not.
 *
 * @remarks Closed and ordered by prerequisite: the backend must run, the
 * model's provider must be on and connected, no load or unload of the model
 * may be in flight, the provider's inventory must be read and list the
 * model, and the model must be loaded. Only `loaded` lets a message be sent
 * to the model; every other result names what is missing, and nothing is
 * sent to another model instead.
 */
export type ModelAvailability =
  | {
      /** The backend is not running. */
      readonly status: "backend-not-running"
    }
  | {
      /** The model's provider is turned off. */
      readonly status: "provider-off"
    }
  | {
      /**
       * The backend is connecting to the provider, or its status is not
       * known yet.
       */
      readonly status: "provider-connecting"
    }
  | {
      /** The backend cannot reach the provider. */
      readonly status: "provider-unreachable"
    }
  | {
      /** The provider's inventory has not been read yet. */
      readonly status: "inventory-unread"
    }
  | {
      /** The provider's latest inventory read failed. */
      readonly status: "inventory-failed"
    }
  | {
      /** The provider's inventory does not list the model. */
      readonly status: "not-listed"
    }
  | {
      /** The provider lists the model, and it is not loaded. */
      readonly status: "not-loaded"
      /**
       * Who loads it: `lys` when Lys can load it through the backend,
       * `provider` when the provider decides which models are in memory.
       */
      readonly modelLoading: LlmModelLoading
      /** The model as the provider lists it. */
      readonly model: LlmInfo
    }
  | {
      /** Lys is loading the model. */
      readonly status: "loading"
    }
  | {
      /** Lys is unloading the model. */
      readonly status: "unloading"
    }
  | {
      /** The model is loaded and can answer. */
      readonly status: "loaded"
      /** The model as the provider lists it, with what it can do. */
      readonly model: LlmInfo
    }

/**
 * Calculates whether one model can answer a chat request now.
 *
 * @param source - Backend state, the providers that are on, and what the
 * desktop knows of every provider.
 * @param reference - Model to check.
 * @returns The first unmet prerequisite in the order {@link ModelAvailability}
 * lists them, or `loaded` with the model's inventory entry.
 */
export function calculateModelAvailability(
  source: ModelAvailabilitySource,
  reference: LlmModelReference
): ModelAvailability {
  switch (calculateProviderAvailability(source, reference.provider)) {
    case "backend-offline":
      return { status: "backend-not-running" }
    case "provider-off":
      return { status: "provider-off" }
    case "provider-connecting":
      return { status: "provider-connecting" }
    case "provider-unreachable":
      return { status: "provider-unreachable" }
    case "available":
      break
  }
  const { request, inventory } = source.providerModels[reference.provider]
  if (
    (request.status === "loading" || request.status === "unloading") &&
    request.modelKey === reference.modelKey
  ) {
    return { status: request.status }
  }
  switch (inventory.status) {
    case "unavailable":
      return { status: "inventory-unread" }
    case "failed":
      return { status: "inventory-failed" }
    case "ready":
      break
  }
  const model = inventory.models.find(
    (listed) => listed.modelKey === reference.modelKey
  )
  if (model === undefined) return { status: "not-listed" }
  return model.loaded
    ? { status: "loaded", model }
    : { status: "not-loaded", modelLoading: inventory.modelLoading, model }
}

/**
 * Reads the inventory entry of a model that can answer.
 *
 * @param availability - Availability of the model, or null when there is no
 * model.
 * @returns The entry of a loaded model, which tells what it can take; undefined
 * for any other availability.
 */
export function findLoadedModelInfo(
  availability: ModelAvailability | null
): LlmInfo | undefined {
  return availability?.status === "loaded" ? availability.model : undefined
}

/**
 * Finds the first model that can answer, in provider order.
 *
 * @param source - Backend state, the providers that are on, and what the
 * desktop knows of every provider.
 * @returns The first loaded model of the first provider, in the order LM
 * Studio, Ollama, Ollama Cloud, Groq, that has one whose availability is
 * `loaded`, each provider's models taken in inventory order; null when no
 * model can answer.
 */
export function findFirstLoadedModel(
  source: ModelAvailabilitySource
): LlmModelReference | null {
  for (const provider of LLM_PROVIDERS) {
    const { inventory } = source.providerModels[provider]
    if (inventory.status !== "ready") continue
    for (const model of inventory.models) {
      const reference: LlmModelReference = {
        provider,
        modelKey: model.modelKey
      }
      if (calculateModelAvailability(source, reference).status === "loaded") {
        return reference
      }
    }
  }
  return null
}

/**
 * Finds the model a new conversation uses.
 *
 * @param source - Backend state, the providers that are on, and what the
 * desktop knows of every provider.
 * @param defaultModel - Default model of the session, or null when none is
 * set.
 * @returns The default model whatever its availability, since a message is
 * never sent to another model in its place; without one, the first model
 * that can answer, as {@link findFirstLoadedModel} finds it; null when there
 * is neither.
 */
export function findNewConversationModel(
  source: ModelAvailabilitySource,
  defaultModel: LlmModelReference | null
): LlmModelReference | null {
  return defaultModel ?? findFirstLoadedModel(source)
}
