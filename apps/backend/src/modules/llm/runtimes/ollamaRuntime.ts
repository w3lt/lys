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

/** One model a local Ollama server is running. */
type OllamaRunningModel = z.infer<typeof ollamaRunningModelSchema>

/** Validates a context length found in a model's metadata. */
const contextLengthSchema = z.int().positive()

/**
 * Most `/api/show` requests one listing has in flight at once, so a server
 * with many models, or Ollama Cloud's catalog, is not asked for every
 * description at the same moment.
 */
const MAXIMUM_CONCURRENT_OLLAMA_DESCRIPTIONS = 4

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
 * capabilities. Ollama decides which models are in memory, and the runtime
 * offers no model loading. A local server's loaded instances are the chat
 * models its `/api/ps` lists, measured with the context length it reports
 * for each; a model it is not running has no measurement, because Ollama
 * would load it with a window of its own choosing, often smaller than the
 * model's. Ollama Cloud reports every chat model as loaded, measured with
 * the model's own window from `/api/show`. Each instance's identifier is the
 * model's name. Ollama has no tokenizer endpoint, so counts are
 * {@link estimateTextTokenCount} estimates. Every call reads the server
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
   * Implements {@link LlmRuntime.listLoadedLlmModelInstances}: the chat
   * models a local server is running, or every chat model of Ollama Cloud.
   *
   * @returns One frozen instance per loaded chat model, whose identifier is
   * its name, with the context length a local server reports for it, or the
   * model's own window in Ollama Cloud, when known.
   * @throws The interface-defined admission failure, or `The LLM runtime
   * could not list loaded model instances.` with the failed request as its
   * cause.
   */
  public async listLoadedLlmModelInstances(): Promise<
    readonly LoadedLlmModelInstance[]
  > {
    return await this.#admission.runOperation(async () => {
      const instances = await this.#listLoadedOllamaInstances().catch(
        (cause: unknown) => {
          throw new Error(
            "The LLM runtime could not list loaded model instances.",
            { cause }
          )
        }
      )
      return Object.freeze(instances)
    })
  }

  /**
   * Implements {@link LlmRuntime.findLlmContextMeasurement} with the window
   * the model is served with and estimated counts.
   *
   * @param model - Model name, as a chat request names it.
   * @param texts - Texts to count, each on its own.
   * @returns A frozen measurement whose context length is the one a local
   * server reports for the running model, or the model's own window in
   * Ollama Cloud, and whose counts are {@link estimateTextTokenCount}
   * estimates; undefined when Ollama does not list the model or it cannot
   * chat, and when a local server is not running it or reports no length
   * for it.
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
        const contextLength = await this.#findServedContextLength(
          model,
          description
        )
        if (contextLength === undefined) return undefined
        return Object.freeze({
          contextLength,
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
   * with at most {@link MAXIMUM_CONCURRENT_OLLAMA_DESCRIPTIONS} descriptions
   * asked for at once.
   *
   * @returns The chat models, in Ollama's order.
   * @throws When a request fails or an answer does not match its shape,
   * once the descriptions already asked for have settled.
   */
  async #listOllamaChatModels(): Promise<readonly OllamaChatModel[]> {
    const tags = await this.#listOllamaTags()
    const models = await mapWithConcurrencyLimit(
      tags,
      MAXIMUM_CONCURRENT_OLLAMA_DESCRIPTIONS,
      async (tag) =>
        Object.freeze({
          tag,
          description: await this.#showOllamaModel(tag.name)
        })
    )
    return models.filter(({ description }) => isOllamaChatModel(description))
  }

  /**
   * Lists the chat models Ollama serves now, as loaded instances.
   *
   * @returns One frozen instance per chat model a local server is running,
   * with the context length it reports, or per chat model of Ollama Cloud,
   * with the model's own window; in Ollama's order.
   * @throws When a request fails or an answer does not match its shape.
   */
  async #listLoadedOllamaInstances(): Promise<LoadedLlmModelInstance[]> {
    const chatModels = await this.#listOllamaChatModels()
    if (this.#target.mode === "cloud") {
      return chatModels.map(({ tag, description }) =>
        buildOllamaInstance(
          tag.name,
          findModelInfoContextLength(description.model_info)
        )
      )
    }
    const runningModels = await this.#listRunningOllamaModels()
    return chatModels.flatMap(({ tag }) => {
      const running = runningModels.find((candidate) =>
        isRunningOllamaModel(candidate, tag.name)
      )
      return running === undefined
        ? []
        : [buildOllamaInstance(tag.name, running.context_length)]
    })
  }

  /**
   * Finds the context length Ollama serves one listed chat model with.
   *
   * @param model - Listed model name.
   * @param description - Ollama's description of the model.
   * @returns The length a local server reports for the running model, or
   * undefined when it is not running it or reports no length; the model's
   * own window in Ollama Cloud.
   * @throws When a request fails, or Ollama Cloud's metadata of the model
   * holds no window.
   */
  async #findServedContextLength(
    model: string,
    description: OllamaModelDescription
  ): Promise<number | undefined> {
    if (this.#target.mode === "local") {
      const runningModels = await this.#listRunningOllamaModels()
      return runningModels.find((running) =>
        isRunningOllamaModel(running, model)
      )?.context_length
    }
    const contextLength = findModelInfoContextLength(description.model_info)
    if (contextLength === undefined) {
      throw new Error(`Ollama reports no context length for ${model}.`)
    }
    return contextLength
  }

  /**
   * Lists the models a local server is running.
   *
   * @returns The running models, each with the context length the server
   * reports for it, if any.
   * @throws When the request fails or the answer does not match its shape.
   */
  async #listRunningOllamaModels(): Promise<readonly OllamaRunningModel[]> {
    const parsed = ollamaRunningModelListSchema.safeParse(
      await this.#requestOllamaJson({ method: "GET", path: "/api/ps" })
    )
    if (!parsed.success) {
      throw new Error("Ollama returned an invalid running-model list.")
    }
    return parsed.data.models
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
 * Maps items through an asynchronous call with a bounded number of calls in
 * flight.
 *
 * @typeParam Item - Item type.
 * @typeParam Result - Result type.
 * @param items - Items to map.
 * @param limit - Most calls in flight at once; a positive integer.
 * @param map - Call for one item.
 * @returns The results, in item order, once every call has settled.
 * @throws The first failure to settle, once every started call has settled;
 * no call starts after a failure.
 * @remarks Workers share one iterator over the items, so each item is taken
 * by exactly one worker.
 */
async function mapWithConcurrencyLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  map: (item: Item) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = []
  const failures: unknown[] = []
  const entries = items.entries()
  /** Maps the next untaken item until none is left or a call failed. */
  async function runWorker(): Promise<void> {
    for (const [index, item] of entries) {
      try {
        results[index] = await map(item)
      } catch (failure) {
        failures.push(failure)
      }
      if (failures.length > 0) return
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runWorker)
  )
  if (failures.length > 0) throw failures[0]
  return results
}

/**
 * Builds the loaded instance of one Ollama model.
 *
 * @param model - Model name, its key and identifier.
 * @param contextLength - Window it is served with, when known.
 * @returns The frozen instance, without a context length when none is known.
 */
function buildOllamaInstance(
  model: string,
  contextLength: number | undefined
): LoadedLlmModelInstance {
  return Object.freeze(
    contextLength === undefined
      ? { modelKey: model, modelIdentifier: model }
      : { modelKey: model, modelIdentifier: model, contextLength }
  )
}

/**
 * Answers whether a running model is the listed model of a name.
 *
 * @param running - Model `/api/ps` lists.
 * @param model - Listed model name.
 * @returns True when either of its names is that name.
 */
function isRunningOllamaModel(
  running: OllamaRunningModel,
  model: string
): boolean {
  return running.name === model || running.model === model
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
