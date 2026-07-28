export type ModelCompatibilityType =
  | "gguf"
  | "safetensors"
  | "onnx"
  | "ggml"
  | "mlx_placeholder"
  | "torch_safetensors"

export type Quantization = {
  /**
   * Name of the quantization.
   */
  name: string
  /**
   * Roughly how many bits this quantization uses per value. This is not accurate and can vary from
   * the actual BPW (bits per weight) of the quantization. Gives a rough idea of the
   * quantization level.
   */
  bits: number
}

export type LlmInfo = {
  /**
   * The key of the model. Use to load the model.
   */
  modelKey: string
  /**
   * The format of the model.
   */
  format: ModelCompatibilityType
  /**
   * Machine generated name of the model.
   */
  displayName: string
  /**
   * The relative path of the model.
   */
  path: string
  /**
   * The size of the model in bytes.
   */
  sizeBytes: number
  /**
   * A string that represents the number of params in the model. May not always be available.
   */
  paramsString?: string
  /**
   * The architecture of the model. May not always be available.
   */
  architecture?: string
  /**
   * The quantization of the model. May not always be available.
   */
  quantization?: Quantization
  /**
   * Whether this model is vision-enabled (i.e. supports image input).
   */
  vision: boolean
  /**
   * Whether this model is trained natively for tool use.
   */
  trainedForToolUse: boolean
  /**
   * Maximum context length of the model.
   */
  maxContextLength: number
  /**
   * Whether the model is loaded or not (into lmstudio)
   */
  loaded: boolean
}