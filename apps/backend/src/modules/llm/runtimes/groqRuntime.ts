import type { GroqApiKey } from "@lys/share"
import * as z from "zod"
import type { LlmRuntime } from "../llmRuntime"
import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LlmRuntimeAvailability,
  LoadedLlmModelInstance
} from "../llmRuntimeTypes"
import { estimateTextTokenCount } from "./estimatedTokenCount"
import LlmRuntimeAdmission from "./llmRuntimeAdmission"
import { requestProviderJson } from "./providerHttp"

/**
 * Validates one model in Groq's model list.
 *
 * @remarks Groq reports no format, size, or capabilities. `active` is absent
 * on some answers; only an explicit `false` hides the model.
 */
const groqModelSchema = z.object({
  /** Model identifier, used as the model key in chat requests. */
  id: z.string().min(1),
  /** Whether Groq currently serves the model. */
  active: z.boolean().optional(),
  /** Context window in tokens. */
  context_window: z.int().positive()
})

/** Validates Groq's model list answer. */
const groqModelListSchema = z.object({ data: z.array(groqModelSchema) })

/** One model Groq serves. */
type GroqModel = z.infer<typeof groqModelSchema>

/**
 * Implements {@link LlmRuntime} over Groq's OpenAI-compatible API.
 *
 * @remarks Groq serves every model it lists on demand, so every listed model
 * is reported as one loaded instance whose identifier is its key, and the
 * runtime offers no model loading. Groq has no tokenizer endpoint:
 * measurements use the model's context window and
 * {@link estimateTextTokenCount}. Every call
 * lists the models again; nothing is cached. The runtime holds no connection,
 * so disposal releases nothing beyond closing admission. Concurrency model:
 * single-owner; {@link LlmRuntimeAdmission} rejects overlapping calls.
 */
export default class GroqRuntime implements LlmRuntime {
  /** Base URL of Groq's OpenAI-compatible API, such as `https://api.groq.com/openai/v1`. */
  readonly #apiBaseUrl: string

  /** Key sent with every request; a secret. */
  readonly #apiKey: GroqApiKey

  /** Admits one operation at a time and closes the runtime once. */
  readonly #admission = new LlmRuntimeAdmission()

  /**
   * Retains the API's location and key without contacting it.
   *
   * @param apiBaseUrl - Base URL of Groq's OpenAI-compatible API.
   * @param apiKey - Key sent with every request.
   */
  private constructor(apiBaseUrl: string, apiKey: GroqApiKey) {
    this.#apiBaseUrl = apiBaseUrl
    this.#apiKey = apiKey
  }

  /**
   * Acquires a runtime once Groq lists its models for the key.
   *
   * @param apiBaseUrl - Base URL of Groq's OpenAI-compatible API.
   * @param apiKey - Key sent with every request; a secret.
   * @returns A ready runtime whose cleanup ownership transfers to the caller.
   * @throws `The LLM runtime is unavailable.` with the failed listing as its
   * cause, such as a refused key or an unreachable host.
   */
  public static async create(
    apiBaseUrl: string,
    apiKey: GroqApiKey
  ): Promise<GroqRuntime> {
    const runtime = new GroqRuntime(apiBaseUrl, apiKey)
    try {
      await runtime.#listGroqModels()
    } catch (cause) {
      throw new Error("The LLM runtime is unavailable.", { cause })
    }
    return runtime
  }

  /**
   * Checks whether Groq lists its models for the key.
   *
   * @returns `available` after a successful listing, otherwise `unavailable`.
   * @throws The interface-defined admission failure when busy or closed.
   */
  public async getRuntimeAvailability(): Promise<LlmRuntimeAvailability> {
    return await this.#admission.runOperation(async () => {
      try {
        await this.#listGroqModels()
        return "available"
      } catch {
        return "unavailable"
      }
    })
  }

  /**
   * Implements {@link LlmRuntime.listDownloadedLlmModels} with Groq's model
   * list.
   *
   * @returns Every model Groq serves, as frozen metadata without format,
   * path, or size; `vision` false and `trainedForToolUse` true, because Groq
   * reports no capabilities and its chat models take tools.
   * @throws The interface-defined admission failure, or `The LLM runtime
   * could not list downloaded models.` with the failed listing as its cause.
   */
  public async listDownloadedLlmModels(): Promise<
    readonly DownloadedLlmModel[]
  > {
    return await this.#admission.runOperation(async () => {
      const models = await this.#listGroqModels().catch((cause: unknown) => {
        throw new Error("The LLM runtime could not list downloaded models.", {
          cause
        })
      })
      return Object.freeze(models.map(createGroqModelSnapshot))
    })
  }

  /**
   * Implements {@link LlmRuntime.listLoadedLlmModelInstances}: every model
   * Groq serves, because it serves them on demand.
   *
   * @returns One frozen instance per listed model, whose identifier is its
   * key and whose context length is its window.
   * @throws The interface-defined admission failure, or `The LLM runtime
   * could not list loaded model instances.` with the failed listing as its
   * cause.
   */
  public async listLoadedLlmModelInstances(): Promise<
    readonly LoadedLlmModelInstance[]
  > {
    return await this.#admission.runOperation(async () => {
      const models = await this.#listGroqModels().catch((cause: unknown) => {
        throw new Error(
          "The LLM runtime could not list loaded model instances.",
          { cause }
        )
      })
      return Object.freeze(
        models.map((model) =>
          Object.freeze({
            modelKey: model.id,
            modelIdentifier: model.id,
            contextLength: model.context_window
          })
        )
      )
    })
  }

  /**
   * Implements {@link LlmRuntime.findLlmContextMeasurement} with the model's
   * context window and estimated counts.
   *
   * @param model - Model key, as a chat request names it.
   * @param texts - Texts to count, each on its own.
   * @returns A frozen measurement whose context length is the model's context
   * window and whose counts are {@link estimateTextTokenCount} estimates;
   * undefined when Groq does not list the model.
   * @throws The interface-defined admission failure, or `The LLM runtime
   * could not measure the context.` with the failed listing as its cause.
   */
  public async findLlmContextMeasurement(
    model: string,
    texts: readonly string[]
  ): Promise<LlmContextMeasurement | undefined> {
    return await this.#admission.runOperation(async () => {
      const models = await this.#listGroqModels().catch((cause: unknown) => {
        throw new Error("The LLM runtime could not measure the context.", {
          cause
        })
      })
      const selected = models.find((entry) => entry.id === model)
      if (selected === undefined) return undefined
      return Object.freeze({
        contextLength: selected.context_window,
        textTokenCounts: Object.freeze(texts.map(estimateTextTokenCount))
      })
    })
  }

  /**
   * Implements the {@link LlmRuntime} disposal contract.
   *
   * @returns The shared cleanup outcome after the active operation settles.
   * @remarks The runtime holds no connection or other resource to release.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.#admission.close(() => Promise.resolve())
  }

  /**
   * Lists the models Groq currently serves.
   *
   * @returns The models whose `active` flag is not `false`, in Groq's order.
   * @throws When the request fails or the answer does not match the model
   * list shape.
   */
  async #listGroqModels(): Promise<readonly GroqModel[]> {
    const answer = await requestProviderJson({
      url: `${this.#apiBaseUrl}/models`,
      method: "GET",
      apiKey: this.#apiKey
    })
    const parsed = groqModelListSchema.safeParse(answer)
    if (!parsed.success) {
      throw new Error("Groq returned an invalid model list.")
    }
    return parsed.data.data.filter((model) => model.active !== false)
  }
}

/**
 * Builds the frozen metadata of one model Groq serves.
 *
 * @param model - Model from Groq's list.
 * @returns Metadata keyed and named by the model identifier.
 */
function createGroqModelSnapshot(model: GroqModel): DownloadedLlmModel {
  return Object.freeze({
    modelKey: model.id,
    displayName: model.id,
    vision: false,
    trainedForToolUse: true,
    maxContextLength: model.context_window
  })
}
