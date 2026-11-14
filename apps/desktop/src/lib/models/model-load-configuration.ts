import type { LlmInfo } from "@lys/protocol"
import {
  modelLoadConfigurationSchema,
  type ModelLoadConfiguration
} from "@lys/share"

import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "@/lib/store/settings"

import committedDefaultModelLoadConfigurationFile from "./default_model_load_configuration.json"

/**
 * Smallest context-length stop the Model pane's slider offers, in tokens.
 * Stops double from here up to the model's maximum.
 */
const MINIMUM_CONTEXT_LENGTH_STOP_TOKENS = 2048

/** Tokens per unit of the abbreviated `k` token count. */
const TOKENS_PER_KILO_UNIT = 1024

/** Model facts a load configuration is resolved against. */
export type ModelLoadTarget = {
  /** Key of the model. */
  readonly modelKey: LlmInfo["modelKey"]
  /**
   * Maximum context length the runtime reports for the model, in tokens, or
   * null when the model is not in the current inventory.
   */
  readonly maxContextLength: LlmInfo["maxContextLength"] | null
}

/** Name of one load setting. */
type ModelLoadSettingName = keyof ModelLoadConfiguration

/**
 * One change to the load settings a model has of its own.
 *
 * @remarks Applying the same change twice gives the same settings as applying
 * it once.
 */
export type ModelLoadConfigurationChange =
  | {
      /** Assigns settings to the model. */
      readonly kind: "assignment"
      /** Key of the model whose own settings change. */
      readonly modelKey: string
      /**
       * Settings to assign. A setting that is absent keeps the value the model
       * already has of its own, if any.
       */
      readonly settings: ModelLoadConfiguration
    }
  | {
      /** Removes the model's own expert count, so the default's count applies. */
      readonly kind: "expert-count-removal"
      /** Key of the model whose own expert count is removed. */
      readonly modelKey: string
    }

/** Load settings in the order the Model pane lists them. */
const MODEL_LOAD_SETTING_NAMES: readonly ModelLoadSettingName[] = Object.freeze(
  [
    "contextLength",
    "evalBatchSize",
    "flashAttention",
    "offloadKVCacheToGpu",
    "numExperts"
  ]
)

/**
 * Answers whether a load configuration sets every setting a complete one
 * requires.
 *
 * @param configuration - Validated load configuration.
 * @returns True when the context length, eval batch size, flash attention,
 * and KV cache settings are all set; the expert count is not required.
 */
function isCompleteModelLoadConfiguration(
  configuration: ModelLoadConfiguration
): configuration is CompleteModelLoadConfiguration {
  const { contextLength, evalBatchSize, flashAttention, offloadKVCacheToGpu } =
    configuration
  return [
    contextLength,
    evalBatchSize,
    flashAttention,
    offloadKVCacheToGpu
  ].every((setting) => setting !== undefined)
}

/**
 * Validates a complete load configuration read from a committed file.
 *
 * @param candidate - Content of the file, not yet validated.
 * @returns The validated configuration, frozen by the shared schema.
 * @throws The shared schema's validation error for an unknown setting, a
 * `null`, or a value the load request does not accept; otherwise an `Error`
 * when one of the four required settings is missing.
 */
function parseCompleteModelLoadConfiguration(
  candidate: unknown
): CompleteModelLoadConfiguration {
  const configuration = modelLoadConfigurationSchema.parse(candidate)
  if (!isCompleteModelLoadConfiguration(configuration)) {
    throw new Error(
      "A complete load configuration sets contextLength, evalBatchSize, flashAttention, and offloadKVCacheToGpu."
    )
  }
  return configuration
}

/**
 * Load configuration that supplies every setting neither a model's own
 * settings nor the stored default set.
 *
 * @remarks Read from the committed `default_model_load_configuration.json`,
 * which the renderer bundle embeds when it is built: editing the file changes
 * the default only after a rebuild, and the default is never written to the
 * settings file. Evaluating this module validates the file, so an invalid
 * committed default stops the renderer at startup instead of reaching a load
 * request.
 */
const COMMITTED_DEFAULT_MODEL_LOAD_CONFIGURATION: CompleteModelLoadConfiguration =
  parseCompleteModelLoadConfiguration(
    committedDefaultModelLoadConfigurationFile
  )

/**
 * Answers whether a reported maximum context length can bound a setting.
 *
 * @param maxContextLength - Maximum the runtime reports for a model, or null
 * when none is known.
 * @returns True for a whole number of at least one token.
 */
function isUsableContextLimit(
  maxContextLength: number | null
): maxContextLength is number {
  return (
    maxContextLength !== null &&
    Number.isInteger(maxContextLength) &&
    maxContextLength >= 1
  )
}

/**
 * Calculates the context length a model is loaded with.
 *
 * @param contextLength - Configured context length, in tokens.
 * @param maxContextLength - Maximum the runtime reports for the model, or
 * null when none is known.
 * @returns The configured length, lowered to the model's maximum when that
 * maximum is usable and smaller.
 */
function calculateLoadedContextLength(
  contextLength: number,
  maxContextLength: number | null
): number {
  return isUsableContextLimit(maxContextLength)
    ? Math.min(contextLength, maxContextLength)
    : contextLength
}

/**
 * Builds the load configuration used for a model that has no settings of its
 * own.
 *
 * @param settings - Stored default and per-model load settings.
 * @returns A newly owned configuration. Each setting is the stored default's
 * value when the settings file sets one and the committed default's value
 * otherwise; the expert count is absent when neither sets one.
 */
export function buildDefaultModelLoadConfiguration(
  settings: LoadConfigurationSettings
): CompleteModelLoadConfiguration {
  const stored = settings.default
  const committed = COMMITTED_DEFAULT_MODEL_LOAD_CONFIGURATION
  const numExperts = stored.numExperts ?? committed.numExperts
  return {
    contextLength: stored.contextLength ?? committed.contextLength,
    evalBatchSize: stored.evalBatchSize ?? committed.evalBatchSize,
    flashAttention: stored.flashAttention ?? committed.flashAttention,
    offloadKVCacheToGpu:
      stored.offloadKVCacheToGpu ?? committed.offloadKVCacheToGpu,
    ...(numExperts === undefined ? {} : { numExperts })
  }
}

/**
 * Builds the load configuration one model is loaded with.
 *
 * @param settings - Stored default and per-model load settings.
 * @param model - Key of the model and its maximum context length, if known.
 * @returns A newly owned configuration. Each setting is the model's own value
 * when it has one, then the stored default's, then the committed default's;
 * the expert count is absent when none of them sets one. The context length
 * never exceeds the model's maximum when the runtime reports a usable one.
 */
export function buildModelLoadConfiguration(
  settings: LoadConfigurationSettings,
  model: ModelLoadTarget
): CompleteModelLoadConfiguration {
  const own = settings.models.get(model.modelKey)
  const defaultConfiguration = buildDefaultModelLoadConfiguration(settings)
  const numExperts = own?.numExperts ?? defaultConfiguration.numExperts
  return {
    contextLength: calculateLoadedContextLength(
      own?.contextLength ?? defaultConfiguration.contextLength,
      model.maxContextLength
    ),
    evalBatchSize: own?.evalBatchSize ?? defaultConfiguration.evalBatchSize,
    flashAttention: own?.flashAttention ?? defaultConfiguration.flashAttention,
    offloadKVCacheToGpu:
      own?.offloadKVCacheToGpu ?? defaultConfiguration.offloadKVCacheToGpu,
    ...(numExperts === undefined ? {} : { numExperts })
  }
}

/**
 * Finds the value one setting has after an assignment.
 *
 * @typeParam TSetting - Setting being read; it selects the value's type.
 * @param setting - Setting to read.
 * @param assigned - Settings the assignment holds.
 * @param own - Settings the model has of its own, or undefined for none.
 * @returns The assigned value, otherwise the model's own value, otherwise
 * undefined.
 */
function findAssignedSetting<TSetting extends ModelLoadSettingName>(
  setting: TSetting,
  assigned: ModelLoadConfiguration,
  own: ModelLoadConfiguration | undefined
): ModelLoadConfiguration[TSetting] {
  return assigned[setting] ?? own?.[setting]
}

/**
 * Builds a load configuration that has an entry only for each set setting.
 *
 * @param settings - Settings whose values may be undefined.
 * @returns A newly owned configuration without the undefined settings, so
 * that an unset setting is absent rather than present and empty.
 */
function buildSetModelLoadConfiguration(
  settings: ModelLoadConfiguration
): ModelLoadConfiguration {
  const {
    contextLength,
    evalBatchSize,
    flashAttention,
    offloadKVCacheToGpu,
    numExperts
  } = settings
  // One setting is added per step, so that an unset setting stays absent.
  const configurationWithContextLength: ModelLoadConfiguration =
    contextLength === undefined ? {} : { contextLength }
  const configurationWithEvalBatchSize: ModelLoadConfiguration =
    evalBatchSize === undefined
      ? configurationWithContextLength
      : { ...configurationWithContextLength, evalBatchSize }
  const configurationWithFlashAttention: ModelLoadConfiguration =
    flashAttention === undefined
      ? configurationWithEvalBatchSize
      : { ...configurationWithEvalBatchSize, flashAttention }
  const configurationWithKvCachePlacement: ModelLoadConfiguration =
    offloadKVCacheToGpu === undefined
      ? configurationWithFlashAttention
      : { ...configurationWithFlashAttention, offloadKVCacheToGpu }
  return numExperts === undefined
    ? configurationWithKvCachePlacement
    : { ...configurationWithKvCachePlacement, numExperts }
}

/**
 * Builds a model's own settings after a change, setting by setting.
 *
 * @param own - Settings the model has of its own, or undefined for none.
 * @param change - Change to apply to them.
 * @returns A newly owned entry. An assigned setting replaces the model's own
 * value, a setting the assignment leaves out keeps it, and a removal drops
 * only the expert count.
 */
function buildOwnModelLoadConfiguration(
  own: ModelLoadConfiguration | undefined,
  change: ModelLoadConfigurationChange
): ModelLoadConfiguration {
  const assigned = change.kind === "assignment" ? change.settings : {}
  return buildSetModelLoadConfiguration({
    contextLength: findAssignedSetting("contextLength", assigned, own),
    evalBatchSize: findAssignedSetting("evalBatchSize", assigned, own),
    flashAttention: findAssignedSetting("flashAttention", assigned, own),
    offloadKVCacheToGpu: findAssignedSetting(
      "offloadKVCacheToGpu",
      assigned,
      own
    ),
    numExperts:
      change.kind === "expert-count-removal"
        ? undefined
        : findAssignedSetting("numExperts", assigned, own)
  })
}

/**
 * Builds the stored load settings after one change to a model's own settings.
 *
 * @param settings - Current stored load settings; they are not modified.
 * @param change - Model and settings to assign, or the expert count to remove.
 * @returns Newly owned settings with the same default and the other models'
 * entries. The changed model's entry is rebuilt, and it is left out when it
 * would hold no setting.
 */
export function buildLoadConfigurationSettings(
  settings: LoadConfigurationSettings,
  change: ModelLoadConfigurationChange
): LoadConfigurationSettings {
  const own = buildOwnModelLoadConfiguration(
    settings.models.get(change.modelKey),
    change
  )
  const models = new Map(settings.models)
  if (Object.keys(own).length === 0) {
    models.delete(change.modelKey)
  } else {
    models.set(change.modelKey, own)
  }
  return { default: settings.default, models }
}

/**
 * Answers whether two load configurations hold the same settings.
 *
 * @param first - One configuration.
 * @param second - The other configuration.
 * @returns True when every setting is equal or absent in both.
 */
export function isModelLoadConfigurationEqual(
  first: ModelLoadConfiguration,
  second: ModelLoadConfiguration
): boolean {
  return MODEL_LOAD_SETTING_NAMES.every(
    (setting) => first[setting] === second[setting]
  )
}

/**
 * Answers whether two stored load settings values are equal by value.
 *
 * @param first - One settings value.
 * @param second - The other settings value.
 * @returns True when the defaults are equal and both have equal settings for
 * the same model keys, whatever the order of their entries.
 */
export function isLoadConfigurationSettingsEqual(
  first: LoadConfigurationSettings,
  second: LoadConfigurationSettings
): boolean {
  if (first.models.size !== second.models.size) return false
  if (!isModelLoadConfigurationEqual(first.default, second.default)) {
    return false
  }
  return [...first.models].every(([modelKey, firstOwn]) => {
    const secondOwn = second.models.get(modelKey)
    return (
      secondOwn !== undefined &&
      isModelLoadConfigurationEqual(firstOwn, secondOwn)
    )
  })
}

/**
 * Lists the context lengths the slider stops at for one model.
 *
 * @param maxContextLength - Maximum the runtime reports for the model.
 * @returns Ascending lengths in tokens: powers of two from 2,048 below the
 * maximum, then the maximum itself. A maximum of at most 2,048 is the only
 * stop, and an unusable maximum gives no stop.
 */
export function listContextLengthStops(
  maxContextLength: number
): readonly number[] {
  if (!isUsableContextLimit(maxContextLength)) return []
  const stops: number[] = []
  for (
    let stop = MINIMUM_CONTEXT_LENGTH_STOP_TOKENS;
    stop < maxContextLength;
    stop *= 2
  ) {
    stops.push(stop)
  }
  return [...stops, maxContextLength]
}

/**
 * Calculates the slider position that shows a context length.
 *
 * @param stops - Ascending slider stops, in tokens.
 * @param contextLength - Context length to show, in tokens.
 * @returns The index of the last stop that does not exceed the length, or
 * zero when the length is below every stop.
 */
export function calculateContextLengthStopIndex(
  stops: readonly number[],
  contextLength: number
): number {
  const reachedStopCount = stops.filter((stop) => stop <= contextLength).length
  return Math.max(0, reachedStopCount - 1)
}

/**
 * Formats a token count the way the Model pane abbreviates it.
 *
 * @param tokens - Whole number of tokens.
 * @returns The plain number below 1,024 tokens; above it, the count in units
 * of 1,024 tokens with a `k` suffix and one decimal unless it is whole, so
 * 8,192 reads `8k` and 10,000 reads `9.8k`.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < TOKENS_PER_KILO_UNIT) return String(tokens)
  const kiloUnits = tokens / TOKENS_PER_KILO_UNIT
  return `${Number.isInteger(kiloUnits) ? kiloUnits : kiloUnits.toFixed(1)}k`
}
