import * as z from "zod"

export const modelCompatibilityTypeSchema = z.enum([
  "gguf",
  "safetensors",
  "onnx",
  "ggml",
  "mlx_placeholder",
  "torch_safetensors"
])

export type ModelCompatibilityType = z.infer<
  typeof modelCompatibilityTypeSchema
>

export const quantizationSchema = z.strictObject({
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

export type Quantization = z.infer<typeof quantizationSchema>

export const llmInfoSchema = z.strictObject({
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
  maxContextLength: z.number(),
  /**
   * Whether the model is loaded or not (into lmstudio)
   */
  loaded: z.boolean()
})

export type LlmInfo = z.infer<typeof llmInfoSchema>
