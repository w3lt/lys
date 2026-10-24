import * as z from "zod"

/** Model formats understood by the shared LM Studio inventory contract. */
export const modelCompatibilityTypeSchema = z.enum([
  "gguf",
  "safetensors",
  "onnx",
  "ggml",
  "mlx_placeholder",
  "torch_safetensors"
])

/** Closed model-format domain inferred from {@link modelCompatibilityTypeSchema}. */
export type ModelCompatibilityType = z.infer<
  typeof modelCompatibilityTypeSchema
>

/** Validates approximate quantization metadata reported for a model. */
export const quantizationSchema = z
  .strictObject({
    /**
     * Name of the quantization.
     */
    name: z.string(),
    /**
     * Roughly how many bits this quantization uses per value. This is not accurate and can vary from
     * the actual BPW (bits per weight) of the quantization. Gives a rough idea of the
     * quantization level.
     */
    bits: z.number()
  })
  .readonly()

/** Quantization metadata accepted by the model inventory contract. */
export type Quantization = z.infer<typeof quantizationSchema>

/**
 * Validates the metadata of a downloaded model, shared by every model entry
 * of the list and load endpoints.
 */
export const llmMetadataSchema = z
  .strictObject({
    /**
     * The key of the model. Use to load the model.
     */
    modelKey: z.string(),
    /**
     * The format of the model.
     */
    format: modelCompatibilityTypeSchema,
    /**
     * Machine generated name of the model.
     */
    displayName: z.string(),
    /**
     * The relative path of the model.
     */
    path: z.string(),
    /**
     * The size of the model in bytes.
     */
    sizeBytes: z.number(),
    /**
     * A string that represents the number of params in the model. May not always be available.
     */
    paramsString: z.string().optional(),
    /**
     * The architecture of the model. May not always be available.
     */
    architecture: z.string().optional(),
    /**
     * The quantization of the model. May not always be available.
     */
    quantization: quantizationSchema.optional(),
    /**
     * Whether this model is vision-enabled (i.e. supports image input).
     */
    vision: z.boolean(),
    /**
     * Whether this model is trained natively for tool use.
     */
    trainedForToolUse: z.boolean(),
    /**
     * Maximum context length of the model.
     */
    maxContextLength: z.number()
  })
  .readonly()

/** Metadata of a downloaded model, inferred from {@link llmMetadataSchema}. */
export type LlmMetadata = z.infer<typeof llmMetadataSchema>

/** Validates the entry of a model with no instance loaded in LM Studio. */
const notLoadedLlmInfoSchema = llmMetadataSchema.unwrap().extend({
  /** No instance of the model is loaded. */
  loaded: z.literal(false)
})

/** Validates the entry of a model with at least one instance loaded. */
const loadedLlmInfoSchema = llmMetadataSchema.unwrap().extend({
  /** At least one instance of the model is loaded in LM Studio. */
  loaded: z.literal(true),
  /**
   * Whether at least one of the loaded instances is one Lys loaded, the only
   * kind Lys unloads; false when another program loaded them all.
   */
  loadedByLys: z.boolean(),
  /**
   * Context length the model is loaded with, in tokens: the smallest among
   * its loaded instances, the window a chat request to the model is measured
   * against. Absent when its instances were gone by the time the inventory
   * measured them.
   */
  loadedContextLength: z.int().positive().optional()
})

/**
 * Validates one model entry of the list and load endpoints: a model with no
 * loaded instance, or a loaded one, which says whether Lys loaded one of its
 * instances and the context length it is loaded with.
 */
export const llmInfoSchema = z
  .discriminatedUnion("loaded", [notLoadedLlmInfoSchema, loadedLlmInfoSchema])
  .readonly()

/** One model entry, inferred from {@link llmInfoSchema}. */
export type LlmInfo = z.infer<typeof llmInfoSchema>

/** Entry of a model with at least one loaded instance. */
export type LoadedLlmInfo = Extract<LlmInfo, { readonly loaded: true }>
