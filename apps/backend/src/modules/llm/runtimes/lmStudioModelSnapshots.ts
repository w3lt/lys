import { llmInfoSchema } from "@lys/protocol"
import * as z from "zod"
import type {
  DownloadedLlmModel,
  LoadedLlmModelInstance
} from "../llmRuntimeTypes"

/** Application metadata shape with the runtime's non-empty canonical key invariant. */
const downloadedLlmMetadataSchema = llmInfoSchema
  .unwrap()
  .omit({ loaded: true })
  .extend({ modelKey: z.string().min(1) })

/** Validates the external LM Studio discriminator and consumed metadata fields. */
const lmStudioDownloadedLlmSchema = downloadedLlmMetadataSchema
  .extend({ type: z.literal("llm") })
  .strip()
  .readonly()

/** Validates the identity observed from an external LM Studio model handle. */
const lmStudioLoadedLlmIdentitySchema = z
  .object({
    /** Canonical model key reported by the engine. */
    modelKey: z.string().min(1),
    /** Opaque loaded-instance identifier accepted by the unload command. */
    identifier: z.string().min(1)
  })
  .readonly()

/**
 * Validates vendor metadata and creates the immutable application runtime snapshot.
 *
 * @param candidate - Untrusted downloaded-model record from LM Studio.
 * @returns Newly owned metadata with copied frozen quantization; absent optional
 * values are omitted, and vendor discriminator and application loaded state are removed.
 * @throws `The LLM runtime returned invalid model metadata.` with validation cause.
 * @remarks Only schema-validated plain record entries are projected. The second
 * schema enforces the distinct output shape after omission of vendor-only fields.
 */
export function createDownloadedLlmModelSnapshot(
  candidate: unknown
): DownloadedLlmModel {
  const validation = lmStudioDownloadedLlmSchema.safeParse(candidate)
  if (!validation.success) {
    throw new Error("The LLM runtime returned invalid model metadata.", {
      cause: validation.error
    })
  }

  const metadataEntries = Object.entries(validation.data).filter(
    ([property, metadata]) => property !== "type" && metadata !== undefined
  )
  const metadata = downloadedLlmMetadataSchema.parse(
    Object.fromEntries(metadataEntries)
  )
  return Object.freeze(metadata)
}

/**
 * Copies the validated identity used to address an LM Studio loaded instance.
 *
 * @param candidate - Untrusted SDK handle or loaded inventory entry.
 * @returns A newly owned frozen identity with no handle or cleanup responsibility.
 * @throws `The LLM runtime returned an invalid model instance.` with validation cause.
 */
export function createLoadedLlmModelInstanceSnapshot(
  candidate: unknown
): LoadedLlmModelInstance {
  const validation = lmStudioLoadedLlmIdentitySchema.safeParse(candidate)
  if (!validation.success) {
    throw new Error("The LLM runtime returned an invalid model instance.", {
      cause: validation.error
    })
  }

  return Object.freeze({
    modelKey: validation.data.modelKey,
    modelIdentifier: validation.data.identifier
  })
}
