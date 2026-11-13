import type { LlmModelReference } from "@lys/share"
import { useMemo } from "react"

import {
  calculateModelAvailability,
  findNewConversationModel,
  type ModelAvailability
} from "@/lib/models/model-availability"
import type { ModelAvailabilitySource } from "@/lib/models/provider-connection"
import { useLysStore } from "@/lib/store"
import {
  findShownConversationModel,
  useChatViewStore
} from "@/lib/store/chat-view"

/** A model a view shows, and whether it can answer now. */
export type ShownModelState = {
  /**
   * The model, or null when there is none. The same object while its
   * provider and key stay the same.
   */
  readonly model: LlmModelReference | null
  /** Its availability, or null when there is no model. */
  readonly availability: ModelAvailability | null
}

/**
 * Builds a reference whose identity follows its provider and key.
 *
 * @param provider - Provider of the model, or null when there is none.
 * @param modelKey - Key of the model, or null when there is none.
 * @returns The same reference for as long as both stay the same, or null
 * when either is null.
 */
function useModelReference(
  provider: LlmModelReference["provider"] | null,
  modelKey: string | null
): LlmModelReference | null {
  return useMemo(
    () =>
      provider === null || modelKey === null ? null : { provider, modelKey },
    [provider, modelKey]
  )
}

/**
 * Observes the application state that decides whether a model can answer.
 *
 * @returns The backend's state, the providers that are on, and every
 * provider's state, as of this render; a new object whenever one of them
 * changes.
 */
function useModelAvailabilitySource(): ModelAvailabilitySource {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const enabledProviders = useLysStore(
    (state) => state.settings.providers.enabled
  )
  const providerModels = useLysStore((state) => state.providerModels)
  return useMemo(
    () => ({ backendStatus, enabledProviders, providerModels }),
    [backendStatus, enabledProviders, providerModels]
  )
}

/**
 * Observes the model a new conversation uses, which the settings panes show.
 *
 * @returns The session's default model, or without one the first model that
 * can answer, in provider order, with its availability; re-rendering
 * whenever either changes. The same object until one of them changes.
 */
export function useNewConversationModel(): ShownModelState {
  const source = useModelAvailabilitySource()
  const defaultModel = useLysStore(
    (state) => state.settings.runtime.defaultModel
  )
  const found = findNewConversationModel(source, defaultModel)
  const model = useModelReference(
    found?.provider ?? null,
    found?.modelKey ?? null
  )
  return useMemo(
    () => ({
      model,
      availability:
        model === null ? null : calculateModelAvailability(source, model)
    }),
    [model, source]
  )
}

/**
 * Observes the model the composer's next message goes to.
 *
 * @returns The chat view's model pick, else the model of the shown
 * conversation's latest reply, else the model a new conversation uses, with
 * its availability; re-rendering whenever either changes. The same object
 * until one of them changes. Sending refuses any model whose availability
 * is not `loaded`.
 */
export function useConversationModel(): ShownModelState {
  const newConversationModel = useNewConversationModel()
  const shownProvider = useChatViewStore(
    (state) => findShownConversationModel(state)?.provider ?? null
  )
  const shownModelKey = useChatViewStore(
    (state) => findShownConversationModel(state)?.modelKey ?? null
  )
  const shownModel = useModelReference(shownProvider, shownModelKey)
  const source = useModelAvailabilitySource()
  return useMemo(
    () =>
      shownModel === null
        ? newConversationModel
        : {
            model: shownModel,
            availability: calculateModelAvailability(source, shownModel)
          },
    [newConversationModel, shownModel, source]
  )
}
