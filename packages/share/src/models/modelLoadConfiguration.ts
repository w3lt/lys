import * as z from "zod"

/**
 * Inclusive maximum of a whole-number load setting: the largest unsigned
 * 32-bit integer.
 *
 * @remarks The desktop host stores these settings as non-zero unsigned 32-bit
 * integers, so the stored and the transmitted representations accept the same
 * range, 1 to this value. Values up to it are persisted in the settings file
 * and transmitted in load requests. Lowering it makes stored settings above
 * the new value unreadable.
 */
export const MAXIMUM_MODEL_LOAD_SETTING_VALUE = 4_294_967_295

/**
 * Validates a whole-number load setting: an integer from 1 to
 * {@link MAXIMUM_MODEL_LOAD_SETTING_VALUE}, both inclusive.
 */
const modelLoadCountSchema = z
  .int()
  .min(1)
  .max(MAXIMUM_MODEL_LOAD_SETTING_VALUE)

/**
 * Validates the settings LM Studio applies when it loads one model.
 *
 * @remarks Every setting is optional; LM Studio decides a setting that is
 * absent. A set context length has one further effect: the LM Studio SDK then
 * sends auto-fit as off for that load. Auto-fit is LM Studio's own choice of
 * context length and model placement from the available resources, and the
 * SDK refuses it together with a context length. An explicit `null` and an
 * unknown setting are rejected. The schema does not know the model, so it does
 * not compare the context length with the model's own maximum; the runtime
 * that loads the model does.
 */
export const modelLoadConfigurationSchema = z
  .strictObject({
    /**
     * Context window the model is loaded with, in tokens. Setting it also
     * turns LM Studio's auto-fit off for the load.
     */
    contextLength: modelLoadCountSchema.optional(),
    /** Prompt tokens evaluated together in one batch. */
    evalBatchSize: modelLoadCountSchema.optional(),
    /** Whether the model is loaded with flash attention. */
    flashAttention: z.boolean().optional(),
    /** Whether the KV cache is kept in GPU memory rather than in RAM. */
    offloadKVCacheToGpu: z.boolean().optional(),
    /** Experts active per token; only mixture-of-experts models use it. */
    numExperts: modelLoadCountSchema.optional()
  })
  .readonly()

/** Settings applied to one model load, inferred from the authoritative schema. */
export type ModelLoadConfiguration = z.infer<
  typeof modelLoadConfigurationSchema
>
