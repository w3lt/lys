import * as z from "zod"

/** Model file formats a provider can report for a model it runs locally. */
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

/** Validates model inventory metadata shared by list and load endpoints. */
export const llmInfoSchema = z
  .strictObject({
    /**
     * The key of the model. Use to load the model.
     */
    modelKey: z.string(),
    /**
     * The format of the model's files. Absent when the provider does not
     * report one, as for a hosted model.
     */
    format: modelCompatibilityTypeSchema.optional(),
    /**
     * Machine generated name of the model.
     */
    displayName: z.string(),
    /**
     * The relative path of the model's files. Absent when the provider does
     * not report one, as for a hosted model.
     */
    path: z.string().optional(),
    /**
     * The size of the model's files in bytes. Absent when the provider does
     * not report one, as for a hosted model.
     */
    sizeBytes: z.number().optional(),
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
    maxContextLength: z.number(),
    /**
     * Whether the model can answer a chat request now: loaded in LM Studio,
     * or served by a provider that loads its models on demand.
     */
    loaded: z.boolean(),
    /**
     * Context length the model is loaded with, in tokens: the smallest among
     * its loaded instances, the window a chat request to the model is measured
     * against. Present only on a loaded model whose instances were observed
     * when the inventory was read.
     */
    loadedContextLength: z.int().positive().optional()
  })
  .readonly()

/** Model inventory metadata inferred from the authoritative runtime schema. */
export type LlmInfo = z.infer<typeof llmInfoSchema>
