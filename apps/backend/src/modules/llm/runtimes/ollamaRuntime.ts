import { modelCompatibilityTypeSchema } from "@lys/protocol"
import type { OllamaApiKey } from "@lys/share"
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

/** Validates one model in Ollama's `/api/tags` answer. */
const ollamaTagSchema = z.object({
  /** Model name, used as the model key in chat requests. */
  name: z.string().min(1),
  /** Size of the model's files in bytes; absent or 0 for a hosted model. */
  size: z.number().nonnegative().optional(),
  /** Descriptive metadata; any field may be absent. */
  details: z
    .object({
      format: z.string().optional(),
      family: z.string().optional(),
      parameter_size: z.string().optional()
    })
    .optional()
})

/** Validates Ollama's `/api/tags` answer. */
const ollamaTagListSchema = z.object({ models: z.array(ollamaTagSchema) })

/** One model Ollama lists. */
type OllamaTag = z.infer<typeof ollamaTagSchema>

/** Validates the part of Ollama's `/api/show` answer the runtime uses. */
const ollamaShowSchema = z.object({
  /**
   * What the model can do, such as `completion`, `tools`, `vision`, or
   * `embedding`; absent from a server that does not report capabilities.
   */
  capabilities: z.array(z.string()).optional(),
  /** Model metadata, whose `<architecture>.context_length` is its window. */
  model_info: z.record(z.string(), z.unknown()).optional()
})

/** The part of Ollama's description of one model the runtime uses. */
type OllamaModelDescription = z.infer<typeof ollamaShowSchema>

/** A model Ollama lists that can answer a chat request, with its description. */
type OllamaChatModel = Readonly<{
  /** The model as Ollama's list names it. */
  tag: OllamaTag
  /** Ollama's description of the model. */
  description: OllamaModelDescription
}>

/** Validates one running model in Ollama's `/api/ps` answer. */
const ollamaRunningModelSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  /** Context length the model was loaded with, in tokens. */
  context_length: z.int().positive().optional()
})

/** Validates Ollama's `/api/ps` answer. */
const ollamaRunningModelListSchema = z.object({
  models: z.array(ollamaRunningModelSchema)
})

/** Validates a context length found in a model's metadata. */
const contextLengthSchema = z.int().positive()

/** One request to Ollama's native API: a `GET`, or a `POST` with a body. */
type OllamaApiRequest =
  | Readonly<{
      /** Reads a resource; the request has no body. */
      method: "GET"
      /** API path, starting with `/api/`. */
      path: string
    }>
  | Readonly<{
      /** Sends {@link body} as JSON. */
      method: "POST"
      /** API path, starting with `/api/`. */
      path: string
      /** Value sent as the JSON body. */
      body: unknown
    }>

/** Suffix of the `model_info` key that holds a model's context window. */
const CONTEXT_LENGTH_KEY_SUFFIX = ".context_length"

/**
 * Where an Ollama runtime sends its requests: a local server, for the
 * `ollama` provider, or Ollama Cloud, for the `ollamaCloud` provider.
 *
 * @remarks A local server is reached over plain HTTP without a key and
 * reports the models it is running; Ollama Cloud is reached over HTTPS with
 * the person's key. Both answer the same native API, so one runtime serves
 * both providers.
 */
export type OllamaRuntimeTarget =
  | Readonly<{
      /** A server the person runs. */
      mode: "local"
      /** Base URL of its native API, such as `http://127.0.0.1:11434`. */
      apiBaseUrl: string
    }>
  | Readonly<{
      /** Ollama Cloud. */
      mode: "cloud"
      /** Base URL of its native API, such as `https://ollama.com`. */
      apiBaseUrl: string
      /** Key sent with every request; a secret. */
      apiKey: OllamaApiKey
    }>

/**
 * Implements {@link LlmRuntime} over Ollama's native API, on a local server
 * or in Ollama Cloud.
 *
 * @remarks Only chat models are listed: a model whose `/api/show`
 * capabilities lack `completion`, such as an embedding model, is left out of
 * every listing and measurement; a model is kept when Ollama reports no
 * capabilities. Ollama loads a model when a request names it, so every chat
 * model is reported as one loaded instance whose identifier is its name,
 * and the runtime offers no model loading. Ollama has no tokenizer endpoint:
 * measurements use {@link estimateTextTokenCount} and the context length a
 * local server reports for a running model, otherwise the model's own
 * window from `/api/show`. A local server that has not loaded the model yet
 * can load it with a smaller window than that. Every call reads the server
 * again; nothing is cached. The runtime holds no connection, so disposal
 * releases nothing beyond closing admission. Concurrency model:
 * single-owner; {@link LlmRuntimeAdmission} rejects overlapping calls.
 */
export default class OllamaRuntime implements LlmRuntime {
  /** Where requests go, with the key for the cloud. */
  readonly #target: OllamaRuntimeTarget

  /** Admits one operation at a time and closes the runtime once. */
  readonly #admission = new LlmRuntimeAdmission()

  /**
   * Retains where requests go without contacting Ollama.
   *
   * @param target - Local server or cloud, with its key.
   */
  private constructor(target: OllamaRuntimeTarget) {
    this.#target = target
  }

  /**
   * Acquires a runtime once Ollama lists its models.
   *
   * @param target - Local server or cloud, with its key; a secret.
   * @returns A ready runtime whose cleanup ownership transfers to the caller.
   * @throws `The LLM runtime is unavailable.` with the failed listing as its
   * cause, such as an unreachable server.
   */
  public static async create(
    target: OllamaRuntimeTarget
  ): Promise<OllamaRuntime> {
    const runtime = new OllamaRuntime(target)
    try {
      await runtime.#listOllamaTags()
    } catch (cause) {
      throw new Error("The LLM runtime is unavailable.", { cause })
    }
    return runtime
  }

  /**
   * Checks whether Ollama lists its models.
   *
   * @returns `available` after a successful listing, otherwise `unavailable`.
   * @throws The interface-defined admission failure when busy or closed.
   */
  public async getRuntimeAvailability(): Promise<LlmRuntimeAvailability> {
    return await this.#admission.runOperation(async () => {
      try {
        await this.#listOllamaTags()
        return "available"
      } catch {
        return "unavailable"
      }
    })
  }

  /**
   * Implements {@link LlmRuntime.listDownloadedLlmModels} with Ollama's chat
   * models.
   *
   * @returns Frozen metadata for every chat model, with `vision` and
   * `trainedForToolUse` from its capabilities and its window from its
   * metadata.
   * @throws The interface-defined admission failure; `The LLM runtime could
   * not list downloaded models.` with the failed request as its cause; or
   * `The LLM runtime returned invalid model metadata.` for a model whose
   * metadata holds no context length.
   */
  public async listDownloadedLlmModels(): Promise<
    readonly DownloadedLlmModel[]
  > {
    return await this.#admission.runOperation(async () => {
      const chatModels = await this.#listOllamaChatModels().catch(
        (cause: unknown) => {
          throw new Error("The LLM runtime could not list downloaded models.", {
            cause
          })
        }
      )
      return Object.freeze(chatModels.map(buildDownloadedOllamaModel))
    })
  }

  /**
   * Implements {@link LlmRuntime.listLoadedLlmModelInstances}: every chat
   * model, because Ollama loads them on demand.
   *
   * @returns One frozen instance per chat model, whose identifier is its name.
   * @throws The interface-defined admission failure, or `The LLM runtime
   * could not list loaded model instances.` with the failed request as its
   * cause.
   */
  public async listLoadedLlmModelInstances(): Promise<
    readonly LoadedLlmModelInstance[]
  > {
    return await this.#admission.runOperation(async () => {
      const chatModels = await this.#listOllamaChatModels().catch(
        (cause: unknown) => {
          throw new Error(
            "The LLM runtime could not list loaded model instances.",
            { cause }
          )
        }
      )
      return Object.freeze(
        chatModels.map(({ tag }) =>
          Object.freeze({ modelKey: tag.name, modelIdentifier: tag.name })
        )
      )
    })
  }

  /**
   * Implements {@link LlmRuntime.findLlmContextMeasurement} with the model's
   * window and estimated counts.
   *
   * @param model - Model name, as a chat request names it.
   * @param texts - Texts to count, each on its own.
   * @returns A frozen measurement whose context length is the one a local
   * server reports for the running model, otherwise the model's own window,
   * and whose counts are {@link estimateTextTokenCount} estimates; undefined
   * when Ollama does not list the model or it cannot chat.
   * @throws The interface-defined admission failure, or `The LLM runtime
   * could not measure the context.` with the failed request or the missing
   * window as its cause.
   */
  public async findLlmContextMeasurement(
    model: string,
    texts: readonly string[]
  ): Promise<LlmContextMeasurement | undefined> {
    return await this.#admission.runOperation(async () => {
      try {
        const tags = await this.#listOllamaTags()
        if (!tags.some((tag) => tag.name === model)) return undefined
        const description = await this.#showOllamaModel(model)
        if (!isOllamaChatModel(description)) return undefined
        return Object.freeze({
          contextLength: await this.#findServedContextLength(
            model,
            description
          ),
          textTokenCounts: Object.freeze(texts.map(estimateTextTokenCount))
        })
      } catch (cause) {
        throw new Error("The LLM runtime could not measure the context.", {
          cause
        })
      }
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
   * Lists the models Ollama has.
   *
   * @returns The models, in Ollama's order.
   * @throws When the request fails or the answer does not match the list shape.
   */
  async #listOllamaTags(): Promise<readonly OllamaTag[]> {
    const parsed = ollamaTagListSchema.safeParse(
      await this.#requestOllamaJson({ method: "GET", path: "/api/tags" })
    )
    if (!parsed.success) {
      throw new Error("Ollama returned an invalid model list.")
    }
    return parsed.data.models
  }

  /**
   * Lists the models Ollama has that can chat, each with its description,
   * asking for every description at once.
   *
   * @returns The chat models, in Ollama's order.
   * @throws When a request fails or an answer does not match its shape.
   */
  async #listOllamaChatModels(): Promise<readonly OllamaChatModel[]> {
    const tags = await this.#listOllamaTags()
    const models = await Promise.all(
      tags.map(async (tag) =>
        Object.freeze({
          tag,
          description: await this.#showOllamaModel(tag.name)
        })
      )
    )
    return models.filter(({ description }) => isOllamaChatModel(description))
  }

  /**
   * Finds the context length Ollama serves one listed chat model with.
   *
   * @param model - Listed model name.
   * @param description - Ollama's description of the model.
   * @returns The length a local server reports for the running model, or
   * the model's own window.
   * @throws When a request fails or the model's metadata holds no window.
   */
  async #findServedContextLength(
    model: string,
    description: OllamaModelDescription
  ): Promise<number> {
    if (this.#target.mode === "local") {
      const running = await this.#findRunningContextLength(model)
      if (running !== undefined) return running
    }
    const contextLength = findModelInfoContextLength(description.model_info)
    if (contextLength === undefined) {
      throw new Error(`Ollama reports no context length for ${model}.`)
    }
    return contextLength
  }

  /**
   * Finds the context length a local server is running one model with.
   *
   * @param model - Listed model name.
   * @returns The reported length, or undefined when the model is not running
   * or the server reports none.
   * @throws When the request fails or the answer does not match its shape.
   */
  async #findRunningContextLength(model: string): Promise<number | undefined> {
    const parsed = ollamaRunningModelListSchema.safeParse(
      await this.#requestOllamaJson({ method: "GET", path: "/api/ps" })
    )
    if (!parsed.success) {
      throw new Error("Ollama returned an invalid running-model list.")
    }
    return parsed.data.models.find(
      (running) => running.name === model || running.model === model
    )?.context_length
  }

  /**
   * Reads Ollama's description of one model.
   *
   * @param model - Model name.
   * @returns The capabilities and metadata the runtime uses.
   * @throws When the request fails or the answer does not match its shape.
   */
  async #showOllamaModel(model: string): Promise<OllamaModelDescription> {
    const parsed = ollamaShowSchema.safeParse(
      await this.#requestOllamaJson({
        method: "POST",
        path: "/api/show",
        body: { model }
      })
    )
    if (!parsed.success) {
      throw new Error("Ollama returned an invalid model description.")
    }
    return parsed.data
  }

  /**
   * Sends one request to Ollama's native API.
   *
   * @param request - A `GET`, or a `POST` with its body, to one API path.
   * @returns The parsed answer, unchecked.
   * @throws The failure {@link requestProviderJson} describes.
   */
  async #requestOllamaJson(request: OllamaApiRequest): Promise<unknown> {
    const { path, ...exchange } = request
    return await requestProviderJson({
      ...exchange,
      url: `${this.#target.apiBaseUrl}${path}`,
      apiKey: this.#target.mode === "cloud" ? this.#target.apiKey : undefined
    })
  }
}

/**
 * Answers whether a model can answer a chat request.
 *
 * @param description - Ollama's description of the model.
 * @returns True when its capabilities include `completion`, or when Ollama
 * reports no capabilities; false for a model such as an embedding model.
 */
function isOllamaChatModel(description: OllamaModelDescription): boolean {
  return (
    description.capabilities === undefined ||
    description.capabilities.includes("completion")
  )
}

/**
 * Builds the frozen metadata of one chat model.
 *
 * @param chatModel - The model and its description.
 * @returns Metadata keyed and named by the model name.
 * @throws `The LLM runtime returned invalid model metadata.` when the
 * description holds no context length.
 */
function buildDownloadedOllamaModel({
  tag,
  description
}: OllamaChatModel): DownloadedLlmModel {
  const maxContextLength = findModelInfoContextLength(description.model_info)
  if (maxContextLength === undefined) {
    throw new Error("The LLM runtime returned invalid model metadata.", {
      cause: new Error(`Ollama reports no context length for ${tag.name}.`)
    })
  }
  const capabilities = description.capabilities ?? []
  const format = modelCompatibilityTypeSchema.safeParse(tag.details?.format)
  return Object.freeze({
    modelKey: tag.name,
    displayName: tag.name,
    ...(format.success ? { format: format.data } : {}),
    ...(tag.size !== undefined && tag.size > 0 ? { sizeBytes: tag.size } : {}),
    ...(tag.details?.parameter_size
      ? { paramsString: tag.details.parameter_size }
      : {}),
    ...(tag.details?.family ? { architecture: tag.details.family } : {}),
    vision: capabilities.includes("vision"),
    trainedForToolUse: capabilities.includes("tools"),
    maxContextLength
  })
}

/**
 * Finds a model's context window in its `/api/show` metadata.
 *
 * @param modelInfo - The answer's `model_info`, if any.
 * @returns The positive whole value of the key that ends in
 * `.context_length`, or undefined when there is none.
 */
function findModelInfoContextLength(
  modelInfo: Readonly<Record<string, unknown>> | undefined
): number | undefined {
  for (const [key, value] of Object.entries(modelInfo ?? {})) {
    if (!key.endsWith(CONTEXT_LENGTH_KEY_SUFFIX)) continue
    const parsed = contextLengthSchema.safeParse(value)
    if (parsed.success) return parsed.data
  }
  return undefined
}
