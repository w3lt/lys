import type { LlmProvider } from "@lys/share"
import type LlmRuntimeService from "./llmRuntimeService"
import type LlmService from "./llmService"

/**
 * The runtime connection and the model policy of one provider.
 *
 * @remarks Each provider has its own pair, so one provider's connection,
 * queue, and failures never reach another's.
 */
export type LlmProviderServices = Readonly<{
  /** Connection to the provider and the queue of its model operations. */
  llmRuntimeService: LlmRuntimeService
  /** Model inventory, lifecycle, and health policy over that queue. */
  llmService: LlmService
}>

/** One value for each provider, keyed by the provider. */
export type LlmProviderRecord<Value> = Readonly<Record<LlmProvider, Value>>

/**
 * Builds one value for each provider, in provider order.
 *
 * @typeParam Value - Value built for each provider.
 * @param buildValue - Builds the value of one provider; called once per
 * provider, in provider order.
 * @returns A frozen record holding every provider's value.
 */
export function buildLlmProviderRecord<Value>(
  buildValue: (provider: LlmProvider) => Value
): LlmProviderRecord<Value> {
  return Object.freeze({
    lmStudio: buildValue("lmStudio"),
    ollama: buildValue("ollama"),
    ollamaCloud: buildValue("ollamaCloud"),
    groq: buildValue("groq")
  })
}
