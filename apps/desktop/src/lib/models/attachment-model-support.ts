import type { LlmInfo } from "@lys/protocol"

/** What a loaded model can take as attachments. */
export type AttachmentModelSupport = Readonly<{
  /** Whether the model sees the images sent with a message. */
  vision: boolean
  /**
   * Whether the model was trained to call tools, which reading an attached
   * text file takes.
   */
  trainedForToolUse: boolean
}>

/**
 * Calculates what a loaded model can take as attachments.
 *
 * @param loadedModel - Inventory entry of the model, which says whether it
 * has vision and was trained for tool use, while it is loaded; undefined
 * while it is not, or there is no model.
 * @returns The loaded model's support, and undefined otherwise.
 */
export function calculateAttachmentModelSupport(
  loadedModel: LlmInfo | undefined
): AttachmentModelSupport | undefined {
  if (loadedModel === undefined) return undefined

  return Object.freeze({
    vision: loadedModel.vision,
    trainedForToolUse: loadedModel.trainedForToolUse
  })
}
