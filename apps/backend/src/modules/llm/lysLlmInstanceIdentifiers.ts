import { randomBytes } from "node:crypto"
import type { LoadedLlmModelInstance } from "./llmRuntimeTypes"

/** Text between the requested model and the random part of an identifier. */
const LYS_INSTANCE_IDENTIFIER_MARKER = "@lys-"

/** Random bytes in the random part; each byte is two hex digits. */
const LYS_INSTANCE_SUFFIX_BYTES = 3

/**
 * Builds the LM Studio identifier of an instance Lys is about to load.
 *
 * @param modelKeyOrAlias - Model selection the load request names.
 * @param suffix - Random part of the identifier.
 * @returns `<modelKeyOrAlias>@lys-<suffix>`, such as
 * `qwen/qwen3-8b@lys-7f3c9a`.
 */
export function buildLysLlmInstanceIdentifier(
  modelKeyOrAlias: string,
  suffix: string
): string {
  return `${modelKeyOrAlias}${LYS_INSTANCE_IDENTIFIER_MARKER}${suffix}`
}

/**
 * Creates the random part of a new instance identifier.
 *
 * @returns Six lowercase hex digits from three random bytes.
 */
export function createRandomLysInstanceSuffix(): string {
  return randomBytes(LYS_INSTANCE_SUFFIX_BYTES).toString("hex")
}

/**
 * Finds the saved identifiers whose instances are still loaded.
 *
 * @param savedIdentifiers - Identifiers saved for the instances Lys loaded.
 * @param loadedModelInstances - Snapshot of the instances loaded now.
 * @returns A new set of the saved identifiers some loaded instance has.
 */
export function findLoadedLysLlmInstanceIdentifiers(
  savedIdentifiers: ReadonlySet<string>,
  loadedModelInstances: readonly LoadedLlmModelInstance[]
): Set<string> {
  return new Set(
    loadedModelInstances
      .map(({ modelIdentifier }) => modelIdentifier)
      .filter((modelIdentifier) => savedIdentifiers.has(modelIdentifier))
  )
}
