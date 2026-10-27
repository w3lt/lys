import { llmProviderSettingsSchema } from "@lys/share"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"

/** LM Studio at its default address, the first-run provider. */
export const LM_STUDIO_TARGET: LlmProviderTarget = Object.freeze(
  describeLlmProviderTarget(
    llmProviderSettingsSchema.parse({
      active: "lmStudio",
      lmStudio: { address: null },
      ollama: { mode: "local", address: null }
    })
  )
)

/** Groq, a hosted provider reached with a key, which loads its own models. */
export const GROQ_TARGET: LlmProviderTarget = Object.freeze(
  describeLlmProviderTarget(
    llmProviderSettingsSchema.parse({
      active: "groq",
      lmStudio: { address: null },
      ollama: { mode: "local", address: null }
    })
  )
)
