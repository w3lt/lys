import { LLM_PROVIDER_NAMES, type LlmModelReference } from "@lys/share"

import type { ModelRequestState } from "@/lib/store/model-runtime"

import type { LocalModelDescriptor } from "./inventory"
import type { ModelAvailability } from "./model-availability"

/** Visual tone the status indicator uses for a residency state. */
export type ModelResidencyTone = "active" | "pending" | "idle"

/** Supporting line while the loaded weights are not observed. */
const UNOBSERVED_RESIDENCY_META =
  "refresh the model inventory to check loaded weights"

/**
 * Finds the transition one row's model is in.
 *
 * @param request - Request in flight for the row's provider.
 * @param model - Model the row represents.
 * @returns `loading` or `unloading` while that request loads or unloads the
 * row's model, otherwise null.
 */
function findRowTransition(
  request: ModelRequestState,
  model: LocalModelDescriptor
): "loading" | "unloading" | null {
  return (request.status === "loading" || request.status === "unloading") &&
    request.modelKey === model.modelKey
    ? request.status
    : null
}

/**
 * Selects the status tone for a shown model.
 *
 * @param availability - Availability of the shown model, or null when no
 * model is shown.
 * @returns The tone name consumed by the status indicator's styles: active
 * while the model is loaded, pending while it loads or unloads, idle
 * otherwise.
 */
export function readModelResidencyTone(
  availability: ModelAvailability | null
): ModelResidencyTone {
  switch (availability?.status) {
    case "loaded":
      return "active"
    case "loading":
    case "unloading":
      return "pending"
    default:
      return "idle"
  }
}

/**
 * Selects the status tone for one model row.
 *
 * @param request - Request in flight for the row's provider.
 * @param model - Inventory entry the row represents.
 * @returns Pending while the row's model loads or unloads, active while it is
 * loaded, idle otherwise.
 */
export function readModelRowTone(
  request: ModelRequestState,
  model: LocalModelDescriptor
): ModelResidencyTone {
  if (findRowTransition(request, model) !== null) return "pending"
  return model.loaded ? "active" : "idle"
}

/**
 * Formats the residency heading shown on the runtime pane's model card.
 *
 * @param availability - Availability of the shown model, or null when no
 * model is shown.
 * @returns The heading naming the state the weights are in.
 */
export function formatModelResidencyHeading(
  availability: ModelAvailability | null
): string {
  if (availability === null) return "No model loaded"
  switch (availability.status) {
    case "loaded":
      return "Model loaded"
    case "loading":
      return "Loading weights"
    case "unloading":
      return "Unloading"
    case "not-loaded":
      return "No model loaded"
    case "not-listed":
      return "Model not listed"
    case "backend-not-running":
    case "provider-off":
    case "provider-connecting":
    case "provider-unreachable":
    case "inventory-unread":
    case "inventory-failed":
      return "Model state unavailable"
  }
}

/**
 * Formats the supporting line under the residency heading.
 *
 * @param model - Shown model: the default, or without one the first loaded
 * model; null when there is neither.
 * @param availability - Availability of the shown model, or null when no
 * model is shown.
 * @returns The observed weights, or why the model is not in memory and what
 * to do about it.
 */
export function formatModelResidencyMeta(
  model: LlmModelReference | null,
  availability: ModelAvailability | null
): string {
  if (model === null || availability === null) {
    return "no default model chosen · pick one in Model"
  }
  const providerName = LLM_PROVIDER_NAMES[model.provider]
  switch (availability.status) {
    case "loaded":
      return `${model.modelKey} · loaded in ${providerName}`
    case "loading":
      return model.modelKey
    case "unloading":
      return `releasing ${model.modelKey}`
    case "backend-not-running":
      return "start the backend first"
    case "provider-off":
      return `${providerName} is off · turn it on in Providers`
    case "provider-connecting":
      return `connecting to ${providerName}`
    case "provider-unreachable":
      return `${providerName} is not reachable`
    case "inventory-unread":
    case "inventory-failed":
      return UNOBSERVED_RESIDENCY_META
    case "not-listed":
      return `${model.modelKey} is not listed by ${providerName}`
    case "not-loaded":
      return `${model.modelKey} is default · not in memory`
  }
}

/**
 * Formats the tag shown at the end of one model row.
 *
 * @param request - Request in flight for the row's provider.
 * @param model - Weights the row represents.
 * @returns `loading` or `unloading` while the row's model is in transition,
 * `loaded` while it is loaded, otherwise its disk size, or `not loaded` when
 * the provider reports no size.
 */
export function formatModelRowTag(
  request: ModelRequestState,
  model: LocalModelDescriptor
): string {
  const transition = findRowTransition(request, model)
  if (transition !== null) return transition
  if (model.loaded) return "loaded"
  return formatOnDiskTag(model)
}

/**
 * Formats the tag shown at the end of one row in the composer's weights menu.
 *
 * @param request - Request in flight for the row's provider.
 * @param model - Weights the row represents.
 * @param isSelected - Whether the row is the conversation's model.
 * @returns The row's live condition when it has one, otherwise whether it is
 * merely the conversation's model, otherwise its on-disk size, or
 * `not loaded` when the provider reports no size. A resident tag reports
 * loaded weights for this row.
 */
export function formatComposerModelRowTag(
  request: ModelRequestState,
  model: LocalModelDescriptor,
  isSelected: boolean
): string {
  const transition = findRowTransition(request, model)
  if (transition !== null) return transition
  if (model.loaded) return "resident"
  if (isSelected) return "selected"

  return formatOnDiskTag(model)
}

/**
 * Formats the tag of a model that is not loaded.
 *
 * @param model - Weights the row represents.
 * @returns Its disk size, or `not loaded` when the provider reports no size.
 */
function formatOnDiskTag(model: LocalModelDescriptor): string {
  return model.sizeLabel === undefined
    ? "not loaded"
    : `${model.sizeLabel} on disk`
}
