import type { LoggerInterface } from "@lmstudio/sdk"
import { GROQ_API_HOST, OLLAMA_CLOUD_API_HOST } from "@lys/protocol"
import type { AcquiredLlmRuntime } from "../llmRuntime"
import type { LlmProviderAccess } from "../llmProviderAccess"
import GroqRuntime from "./groqRuntime"
import LmStudioRuntime from "./lmStudioRuntime"
import OllamaRuntime from "./ollamaRuntime"

/**
 * Acquires the runtime that serves one provider.
 *
 * @param access - How the provider is reached; may hold a secret key.
 * @param lmStudioSdkLogger - Receives the messages of an LM Studio SDK
 * client; unused for other providers.
 * @returns A ready runtime whose cleanup ownership transfers to the caller:
 * LM Studio over `ws://<address>`, whose models Lys loads; or a provider
 * that loads a model when a request names it: a local Ollama server over
 * `http://<address>`, Ollama's cloud over `https://ollama.com`, or Groq over
 * `https://api.groq.com/openai/v1`.
 * @throws The acquisition failure of the provider's runtime, such as `The
 * LLM runtime is unavailable.` with the cause when the provider cannot be
 * reached or refuses the key; nothing stays acquired.
 */
export async function acquireLlmProviderRuntime(
  access: LlmProviderAccess,
  lmStudioSdkLogger: LoggerInterface
): Promise<AcquiredLlmRuntime> {
  switch (access.provider) {
    case "lmStudio": {
      const llmRuntime = await LmStudioRuntime.create(
        `ws://${access.address}`,
        lmStudioSdkLogger
      )
      return Object.freeze({
        modelLoading: "lys",
        llmRuntime,
        llmModelInstanceController: llmRuntime
      })
    }
    case "ollama":
      return Object.freeze({
        modelLoading: "provider",
        llmRuntime: await OllamaRuntime.create(
          access.mode === "local"
            ? { mode: "local", apiBaseUrl: `http://${access.address}` }
            : {
                mode: "cloud",
                apiBaseUrl: `https://${OLLAMA_CLOUD_API_HOST}`,
                apiKey: access.apiKey
              }
        )
      })
    case "groq":
      return Object.freeze({
        modelLoading: "provider",
        llmRuntime: await GroqRuntime.create(
          `https://${GROQ_API_HOST}/openai/v1`,
          access.apiKey
        )
      })
  }
}
