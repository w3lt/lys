import type { LlmInfo } from "@lys/protocol"

/** Backend inventory metadata with presentation-only labels for model selectors. */
export type LocalModelDescriptor = LlmInfo & {
  /** Available parameter, quantization, and on-disk size metadata. */
  readonly detail: string
  /**
   * Decimal gigabytes on disk, not runtime memory consumption; undefined when
   * the provider reports no size, as for a hosted model.
   */
  readonly sizeLabel: string | undefined
}

/**
 * Adds display labels to validated backend metadata without inventing missing values.
 * @param model - One immutable backend inventory entry.
 * @returns Metadata and labels used by the settings and composer selectors.
 */
export function buildModelDescriptor(model: LlmInfo): LocalModelDescriptor {
  const sizeLabel =
    model.sizeBytes === undefined
      ? undefined
      : `${(model.sizeBytes / 1_000_000_000).toFixed(1)} GB`
  const detail = [model.paramsString, model.quantization?.name, sizeLabel]
    .filter((label) => label !== undefined)
    .join(" · ")
  return { ...model, detail, sizeLabel }
}
