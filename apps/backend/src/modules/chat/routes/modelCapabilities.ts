import type { LlmInfo } from "@lys/protocol"

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
 * @param model - Model a request names, which is LM Studio's model key.
 * @returns A promise resolving to the capabilities, or to undefined when no
 * downloaded model has the key.
 * @throws If the inventory cannot be read: LM Studio cannot be reached, or
 * the model-operation queue is full.
 */
export type FindModelCapabilities = (
  model: string
) => Promise<ModelCapabilities | undefined>

/**
 * Capabilities applied when no attachment is involved, so nothing is read
 * from LM Studio, or when the model is not in the inventory: the model sees
 * no image and is offered no attachment reader.
 */
export const NO_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  vision: false,
  trainedForToolUse: false
})

/**
 * Finds what the model can do with a turn's attachments.
 *
 * @param model - Model the request names.
 * @param hasAttachments - Whether the turn involves an attachment.
 * @param findModelCapabilities - Inventory lookup.
 * @returns A promise resolving to the model's capabilities; to
 * {@link NO_MODEL_CAPABILITIES} without reading the inventory when the turn
 * involves no attachment, and when the inventory does not list the model.
 * @throws The lookup's failure.
 */
export async function findAttachmentModelCapabilities(
  model: string,
  hasAttachments: boolean,
  findModelCapabilities: FindModelCapabilities
): Promise<ModelCapabilities> {
  if (!hasAttachments) return NO_MODEL_CAPABILITIES
  return (await findModelCapabilities(model)) ?? NO_MODEL_CAPABILITIES
}

/**
 * Creates the capability lookup over an inventory query.
 *
 * @param listLlmModels - Inventory query of the LLM service; borrowed for the
 * lookup's lifetime.
 * @returns The lookup, which reads the whole inventory on each call and
 * matches the model key exactly.
 */
export function createModelCapabilitiesLookup(
  listLlmModels: () => Promise<readonly LlmInfo[]>
): FindModelCapabilities {
  return async (model) => {
    const info = (await listLlmModels()).find(
      (entry) => entry.modelKey === model
    )
    return info === undefined
      ? undefined
      : Object.freeze({
          vision: info.vision,
          trainedForToolUse: info.trainedForToolUse
        })
  }
}
