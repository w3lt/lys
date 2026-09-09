import * as z from "zod"

/** Validates the closed set of expected LLM health failure reasons. */
export const llmHealthProblemReasonSchema = z.enum([
  "model-not-found",
  "model-not-loaded",
  "runtime-unavailable",
  "probe-failed",
  "probe-timeout"
])

/** Semantic category of an expected LLM health failure. */
export type LlmHealthProblemReason = z.infer<
  typeof llmHealthProblemReasonSchema
>

/** Validates the currently supported model-unload failure reasons. */
export const llmUnloadProblemReasonSchema = z.enum([
  "model-not-found",
  "runtime-unavailable",
  "unload-failed"
])

/** Semantic category of a currently supported model-unload failure. */
export type LlmUnloadProblemReason = z.infer<
  typeof llmUnloadProblemReasonSchema
>

/** Fixed Problem Details fields owned by one LLM failure category. */
type LlmProblemDefinition = {
  /** Stable URI identifying the semantic problem category. */
  readonly type: `urn:lys:problem:llm:${string}`
  /** Stable human-readable summary of the problem category. */
  readonly title: string
  /** HTTP status associated with the problem category. */
  readonly status: 404 | 503 | 504
}

/** Fixed fields for an unknown requested model. */
const MODEL_NOT_FOUND_PROBLEM_DEFINITION = Object.freeze({
  type: "urn:lys:problem:llm:model-not-found",
  title: "Model not found",
  status: 404
} as const satisfies LlmProblemDefinition)

/** Fixed fields for a requested model that is not loaded. */
const MODEL_NOT_LOADED_PROBLEM_DEFINITION = Object.freeze({
  type: "urn:lys:problem:llm:model-not-loaded",
  title: "Model not loaded",
  status: 503
} as const satisfies LlmProblemDefinition)

/** Fixed fields for an unavailable LLM runtime. */
const RUNTIME_UNAVAILABLE_PROBLEM_DEFINITION = Object.freeze({
  type: "urn:lys:problem:llm:runtime-unavailable",
  title: "LLM runtime unavailable",
  status: 503
} as const satisfies LlmProblemDefinition)

/** Fixed fields for an unsuccessful model readiness probe. */
const PROBE_FAILED_PROBLEM_DEFINITION = Object.freeze({
  type: "urn:lys:problem:llm:probe-failed",
  title: "Model probe failed",
  status: 503
} as const satisfies LlmProblemDefinition)

/** Fixed fields for a model readiness probe that exceeded its deadline. */
const PROBE_TIMEOUT_PROBLEM_DEFINITION = Object.freeze({
  type: "urn:lys:problem:llm:probe-timeout",
  title: "Model probe timed out",
  status: 504
} as const satisfies LlmProblemDefinition)

/** Fixed fields for a requested model that could not be unloaded. */
const UNLOAD_FAILED_PROBLEM_DEFINITION = Object.freeze({
  type: "urn:lys:problem:llm:unload-failed",
  title: "Model unload failed",
  status: 503
} as const satisfies LlmProblemDefinition)

/** Complete fixed-field lookup for every supported LLM health failure. */
const LLM_HEALTH_PROBLEM_DEFINITION_BY_REASON = Object.freeze({
  "model-not-found": MODEL_NOT_FOUND_PROBLEM_DEFINITION,
  "model-not-loaded": MODEL_NOT_LOADED_PROBLEM_DEFINITION,
  "runtime-unavailable": RUNTIME_UNAVAILABLE_PROBLEM_DEFINITION,
  "probe-failed": PROBE_FAILED_PROBLEM_DEFINITION,
  "probe-timeout": PROBE_TIMEOUT_PROBLEM_DEFINITION
} satisfies Readonly<Record<LlmHealthProblemReason, LlmProblemDefinition>>)

/** Complete fixed-field lookup for every supported model-unload failure. */
const LLM_UNLOAD_PROBLEM_DEFINITION_BY_REASON = Object.freeze({
  "model-not-found": MODEL_NOT_FOUND_PROBLEM_DEFINITION,
  "runtime-unavailable": RUNTIME_UNAVAILABLE_PROBLEM_DEFINITION,
  "unload-failed": UNLOAD_FAILED_PROBLEM_DEFINITION
} satisfies Readonly<Record<LlmUnloadProblemReason, LlmProblemDefinition>>)

/** Validates occurrence-specific problem details. */
const llmProblemDetailSchema = z.string().min(1)

/** Validates an optional identifier for one problem occurrence. */
const llmProblemInstanceSchema = z.string().min(1).optional()

/** Validates an unknown-model Problem Details body. */
const llmModelNotFoundProblemObjectSchema = z.strictObject({
  type: z.literal(MODEL_NOT_FOUND_PROBLEM_DEFINITION.type),
  title: z.literal(MODEL_NOT_FOUND_PROBLEM_DEFINITION.title),
  status: z.literal(MODEL_NOT_FOUND_PROBLEM_DEFINITION.status),
  detail: llmProblemDetailSchema,
  instance: llmProblemInstanceSchema
})

/** Validates a model-not-loaded Problem Details body. */
const llmModelNotLoadedProblemObjectSchema = z.strictObject({
  type: z.literal(MODEL_NOT_LOADED_PROBLEM_DEFINITION.type),
  title: z.literal(MODEL_NOT_LOADED_PROBLEM_DEFINITION.title),
  status: z.literal(MODEL_NOT_LOADED_PROBLEM_DEFINITION.status),
  detail: llmProblemDetailSchema,
  instance: llmProblemInstanceSchema
})

/** Validates a runtime-unavailable Problem Details body. */
const llmRuntimeUnavailableProblemObjectSchema = z.strictObject({
  type: z.literal(RUNTIME_UNAVAILABLE_PROBLEM_DEFINITION.type),
  title: z.literal(RUNTIME_UNAVAILABLE_PROBLEM_DEFINITION.title),
  status: z.literal(RUNTIME_UNAVAILABLE_PROBLEM_DEFINITION.status),
  detail: llmProblemDetailSchema,
  instance: llmProblemInstanceSchema
})

/** Validates an unsuccessful-probe Problem Details body. */
const llmProbeFailedProblemObjectSchema = z.strictObject({
  type: z.literal(PROBE_FAILED_PROBLEM_DEFINITION.type),
  title: z.literal(PROBE_FAILED_PROBLEM_DEFINITION.title),
  status: z.literal(PROBE_FAILED_PROBLEM_DEFINITION.status),
  detail: llmProblemDetailSchema,
  instance: llmProblemInstanceSchema
})

/** Validates a timed-out-probe Problem Details body. */
const llmProbeTimeoutProblemObjectSchema = z.strictObject({
  type: z.literal(PROBE_TIMEOUT_PROBLEM_DEFINITION.type),
  title: z.literal(PROBE_TIMEOUT_PROBLEM_DEFINITION.title),
  status: z.literal(PROBE_TIMEOUT_PROBLEM_DEFINITION.status),
  detail: llmProblemDetailSchema,
  instance: llmProblemInstanceSchema
})

/** Validates an unsuccessful model-unload Problem Details body. */
const llmUnloadFailedProblemObjectSchema = z.strictObject({
  type: z.literal(UNLOAD_FAILED_PROBLEM_DEFINITION.type),
  title: z.literal(UNLOAD_FAILED_PROBLEM_DEFINITION.title),
  status: z.literal(UNLOAD_FAILED_PROBLEM_DEFINITION.status),
  detail: llmProblemDetailSchema,
  instance: llmProblemInstanceSchema
})

/** Immutable schema for an unknown-model Problem Details body. */
export const llmModelNotFoundProblemSchema =
  llmModelNotFoundProblemObjectSchema.readonly()

/** Immutable schema for a model-not-loaded Problem Details body. */
export const llmModelNotLoadedProblemSchema =
  llmModelNotLoadedProblemObjectSchema.readonly()

/** Immutable schema for a runtime-unavailable Problem Details body. */
export const llmRuntimeUnavailableProblemSchema =
  llmRuntimeUnavailableProblemObjectSchema.readonly()

/** Immutable schema for an unsuccessful-probe Problem Details body. */
export const llmProbeFailedProblemSchema =
  llmProbeFailedProblemObjectSchema.readonly()

/** Immutable schema for a timed-out-probe Problem Details body. */
export const llmProbeTimeoutProblemSchema =
  llmProbeTimeoutProblemObjectSchema.readonly()

/** Immutable schema for an unsuccessful model-unload Problem Details body. */
export const llmUnloadFailedProblemSchema =
  llmUnloadFailedProblemObjectSchema.readonly()

/** Validates every documented Problem Details body from LLM health checks. */
export const llmHealthProblemSchema = z
  .discriminatedUnion("type", [
    llmModelNotFoundProblemObjectSchema,
    llmModelNotLoadedProblemObjectSchema,
    llmRuntimeUnavailableProblemObjectSchema,
    llmProbeFailedProblemObjectSchema,
    llmProbeTimeoutProblemObjectSchema
  ])
  .readonly()

/** Validates every currently documented Problem Details body from model unloads. */
export const llmUnloadProblemSchema = z
  .discriminatedUnion("type", [
    llmModelNotFoundProblemObjectSchema,
    llmRuntimeUnavailableProblemObjectSchema,
    llmUnloadFailedProblemObjectSchema
  ])
  .readonly()

/** Immutable Problem Details body returned for an expected LLM health failure. */
export type LlmHealthProblem = z.infer<typeof llmHealthProblemSchema>

/** Immutable Problem Details body returned for a model-unload failure. */
export type LlmUnloadProblem = z.infer<typeof llmUnloadProblemSchema>

/**
 * Model-unload Problem Details variant selected by its semantic reason.
 *
 * @typeParam Reason - Failure reason whose exact Problem Details variant is selected.
 */
export type LlmUnloadProblemForReason<Reason extends LlmUnloadProblemReason> =
  Extract<LlmUnloadProblem, { readonly type: `urn:lys:problem:llm:${Reason}` }>

/** Validates input used to create one LLM health problem occurrence. */
export const llmHealthProblemCreationInputSchema = z
  .strictObject({
    /** Semantic failure category that determines the stable problem fields. */
    reason: llmHealthProblemReasonSchema,
    /** Occurrence-specific explanation safe to expose to the API client. */
    detail: llmProblemDetailSchema,
    /** Optional unique identifier for this problem occurrence. */
    instance: llmProblemInstanceSchema
  })
  .readonly()

/** Trusted input used to create one LLM health problem occurrence. */
export type LlmHealthProblemCreationInput = z.infer<
  typeof llmHealthProblemCreationInputSchema
>

/** Validates input used to create one model-unload problem occurrence. */
export const llmUnloadProblemCreationInputSchema = z
  .strictObject({
    /** Semantic failure category that determines the stable problem fields. */
    reason: llmUnloadProblemReasonSchema,
    /** Occurrence-specific explanation safe to expose to the API client. */
    detail: llmProblemDetailSchema,
    /** Optional unique identifier for this problem occurrence. */
    instance: llmProblemInstanceSchema
  })
  .readonly()

/** Trusted input used to create one model-unload problem occurrence. */
export type LlmUnloadProblemCreationInput = z.infer<
  typeof llmUnloadProblemCreationInputSchema
>

/**
 * Model-unload problem creation input narrowed to one semantic reason.
 *
 * @typeParam Reason - Failure reason accepted by the narrowed input.
 */
export type LlmUnloadProblemCreationInputForReason<
  Reason extends LlmUnloadProblemReason
> = Omit<LlmUnloadProblemCreationInput, "reason"> & {
  /** Semantic failure category that determines the exact return variant. */
  readonly reason: Reason
}

/**
 * Creates an immutable Problem Details body for an expected LLM health failure.
 *
 * @param input - Failure category and occurrence-specific client-safe fields.
 * @returns A validated body whose type, title, and status match the category.
 * @throws If the supplied category, detail, or instance is invalid.
 */
export function createLlmHealthProblem(
  input: LlmHealthProblemCreationInput
): LlmHealthProblem {
  const verifiedInput = llmHealthProblemCreationInputSchema.parse(input)
  const problemDefinition =
    LLM_HEALTH_PROBLEM_DEFINITION_BY_REASON[verifiedInput.reason]

  return llmHealthProblemSchema.parse({
    type: problemDefinition.type,
    title: problemDefinition.title,
    status: problemDefinition.status,
    detail: verifiedInput.detail,
    ...(verifiedInput.instance === undefined
      ? {}
      : { instance: verifiedInput.instance })
  })
}

/**
 * Creates an immutable Problem Details body for a model-unload failure.
 *
 * @param input - Failure category and occurrence-specific client-safe fields.
 * @returns A validated body whose fixed fields match the failure category.
 * @throws If the supplied category, detail, or instance is invalid.
 */
export function createLlmUnloadProblem<
  const Reason extends LlmUnloadProblemReason
>(
  input: LlmUnloadProblemCreationInputForReason<Reason>
): LlmUnloadProblemForReason<Reason>
export function createLlmUnloadProblem(
  input: LlmUnloadProblemCreationInput
): LlmUnloadProblem {
  const verifiedInput = llmUnloadProblemCreationInputSchema.parse(input)
  const problemDefinition =
    LLM_UNLOAD_PROBLEM_DEFINITION_BY_REASON[verifiedInput.reason]

  return llmUnloadProblemSchema.parse({
    type: problemDefinition.type,
    title: problemDefinition.title,
    status: problemDefinition.status,
    detail: verifiedInput.detail,
    ...(verifiedInput.instance === undefined
      ? {}
      : { instance: verifiedInput.instance })
  })
}
