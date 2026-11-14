import { llmProviderSettingsSchema } from "@lys/share"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"

/** Providers with every address at its default and only LM Studio on. */
const DEFAULT_ADDRESS_PROVIDERS = llmProviderSettingsSchema.parse({
  enabled: ["lmStudio"],
  lmStudio: { address: null },
  ollama: { address: null }
})

/** LM Studio at its default address, the first-run provider. */
export const LM_STUDIO_TARGET: LlmProviderTarget = Object.freeze(
  describeLlmProviderTarget("lmStudio", DEFAULT_ADDRESS_PROVIDERS)
)

/** Groq, a hosted provider reached with a key. */
export const GROQ_TARGET: LlmProviderTarget = Object.freeze(
  describeLlmProviderTarget("groq", DEFAULT_ADDRESS_PROVIDERS)
)
