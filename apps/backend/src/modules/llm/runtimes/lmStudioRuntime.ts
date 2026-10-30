import {
  LMStudioClient,
  type LLM,
  type LLMLoadModelConfig,
  type LoggerInterface
} from "@lmstudio/sdk"
import type { ModelLoadConfiguration } from "@lys/share"
import * as z from "zod"
import type { LlmModelInstanceController } from "../llmModelInstanceController"
import type { LlmRuntime } from "../llmRuntime"
import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LlmRuntimeAvailability,
  LoadedLlmModelInstance
} from "../llmRuntimeTypes"
import LlmRuntimeAdmission from "./llmRuntimeAdmission"
import {
  createDownloadedLlmModelSnapshot,
  createLoadedLlmModelInstanceSnapshot
} from "./lmStudioModelSnapshots"

/** Validates a context length LM Studio reports for a loaded instance. */
const lmStudioContextLengthSchema = z.int().positive()

/** Validates the token count LM Studio returns for one text. */
const lmStudioTokenCountSchema = z.int().nonnegative()

/**
 * Owns one LM Studio client to implement {@link LlmRuntime} and
 * {@link LlmModelInstanceController} with terminal cleanup.
 *
 * @remarks Concurrency
 * model: single-owner; the owning service confines calls, and
 * {@link LlmRuntimeAdmission} rejects operational overlap before SDK access.
 * There is no runtime waiting queue. The owned disposal stack is the client's
 * sole release registration; the client field borrows that protected resource.
 * Model operations retain the interface's application-owned completion-only
 * lifetime. Cleanup closes SDK connections without unloading engine models.
 */
export default class LmStudioRuntime
  implements LlmRuntime, LlmModelInstanceController
{
  /** SDK client borrowed from this runtime's exclusively owned disposal stack. */
  readonly #client: LMStudioClient

  /** Sole owner of the SDK client's required release operation. */
  readonly #clientLifetime: AsyncDisposableStack

  /** Admits one operation at a time and closes the runtime once. */
  readonly #admission = new LlmRuntimeAdmission()

  /**
   * Retains an already protected SDK client without starting external work.
   *
   * @param client - Client whose sole cleanup registration belongs to clientLifetime.
   * @param clientLifetime - Protected client lifetime transferred exclusively to this runtime.
   */
  private constructor(
    client: LMStudioClient,
    clientLifetime: AsyncDisposableStack
  ) {
    this.#client = client
    this.#clientLifetime = clientLifetime
  }

  /**
   * Acquires a ready SDK adapter for an available configured endpoint.
   *
   * @param lmsBaseUrl - WebSocket endpoint validated by the SDK before acquisition.
   * @param sdkLogger - Receives the messages the SDK client logs, such as why
   * it could not connect; borrowed for the runtime's lifetime.
   * @returns A ready runtime whose cleanup ownership transfers to the caller.
   * @throws `The LLM runtime is unavailable.` with the SDK query failure as its
   * cause, or an SDK construction failure. Acquired resources are released before
   * rejection.
   * @throws An `AggregateError` containing the acquisition failure followed by
   * the cleanup failure if releasing acquired resources also fails.
   * @remarks Acquisition completes only after the SDK readiness query settles.
   * The SDK offers no safe deadline or cancellation for this query.
   */
  public static async create(
    lmsBaseUrl: string,
    sdkLogger: LoggerInterface
  ): Promise<LmStudioRuntime> {
    const clientLifetime = new AsyncDisposableStack()
    try {
      const client = clientLifetime.use(
        new LMStudioClient({ baseUrl: lmsBaseUrl, logger: sdkLogger })
      )
      const availabilityQuery = client.system.getLMStudioVersion()
      try {
        await availabilityQuery
      } catch (cause) {
        throw new Error("The LLM runtime is unavailable.", { cause })
      }
      return new LmStudioRuntime(client, clientLifetime)
    } catch (creationError) {
      try {
        await clientLifetime.disposeAsync()
      } catch (cleanupError) {
        throw new AggregateError(
          [creationError, cleanupError],
          "LLM runtime creation and cleanup both failed.",
          { cause: cleanupError }
        )
      }
      throw creationError
    }
  }

  /**
   * Checks whether the attached LM Studio engine answers its readiness query.
   *
   * @returns The interface-defined availability after the completion-only query settles.
   * @throws The interface-defined admission failure when the runtime is busy or closed.
   */
  public async getRuntimeAvailability(): Promise<LlmRuntimeAvailability> {
    return await this.#admission.runOperation(async () => {
      const availabilityQuery = this.#client.system.getLMStudioVersion()
      try {
        await availabilityQuery
        return "available"
      } catch {
        return "unavailable"
      }
    })
  }

  /**
   * Implements {@link LlmRuntime.listDownloadedLlmModels} through SDK inventory.
   *
   * @returns The interface-defined immutable metadata after vendor normalization.
   * @throws The interface-defined admission, query, or metadata failure.
   */
  public async listDownloadedLlmModels(): Promise<
    readonly DownloadedLlmModel[]
  > {
    return await this.#admission.runOperation(async () => {
      const models = await this.#client.system
        .listDownloadedModels("llm")
        .catch((cause: unknown) => {
          throw new Error("The LLM runtime could not list downloaded models.", {
            cause
          })
        })
      return Object.freeze(models.map(createDownloadedLlmModelSnapshot))
    })
  }

  /**
   * Implements {@link LlmRuntime.listLoadedLlmModelInstances} through SDK handles.
   *
   * @returns The interface-defined immutable identities after vendor normalization.
   * @throws The interface-defined admission, query, or identity failure.
   */
  public async listLoadedLlmModelInstances(): Promise<
    readonly LoadedLlmModelInstance[]
  > {
    return await this.#admission.runOperation(async () => {
      const models = await this.#client.llm
        .listLoaded()
        .catch((cause: unknown) => {
          throw new Error(
            "The LLM runtime could not list loaded model instances.",
            { cause }
          )
        })
      return Object.freeze(models.map(createLoadedLlmModelInstanceSnapshot))
    })
  }

  /**
   * Implements {@link LlmModelInstanceController.loadLlmModel} with a
   * completion-only SDK load.
   *
   * @param modelKeyOrAlias - Interface-defined engine model selection.
   * @param loadConfiguration - Interface-defined load settings, given to the SDK
   * as its load config.
   * @returns The interface-defined canonical identity after the SDK load completes.
   * @throws The interface-defined admission, load, or identity failure.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration
  ): Promise<LoadedLlmModelInstance> {
    return await this.#admission.runOperation(async () => {
      const loadedModel = await this.#client.llm
        .load(modelKeyOrAlias, {
          config: buildLmStudioLoadConfig(loadConfiguration)
        })
        .catch((cause: unknown) => {
          throw new Error("The LLM runtime could not load the model.", {
            cause
          })
        })
      return createLoadedLlmModelInstanceSnapshot(loadedModel)
    })
  }

  /**
   * Implements {@link LlmModelInstanceController.stopLoadedLlmModelInstance}
   * through SDK unloading.
   *
   * @param modelIdentifier - Interface-defined opaque loaded-instance identifier.
   * @returns A promise resolving after the SDK acknowledges unloading.
   * @throws The interface-defined admission or stop failure.
   */
  public async stopLoadedLlmModelInstance(
    modelIdentifier: string
  ): Promise<void> {
    await this.#admission.runOperation(async () => {
      try {
        await this.#client.llm.unload(modelIdentifier)
      } catch (cause) {
        throw new Error("The LLM runtime could not stop the model instance.", {
          cause
        })
      }
    })
  }

  /**
   * Implements {@link LlmRuntime.findLlmContextMeasurement} through loaded SDK handles.
   *
   * @param model - Interface-defined model selection.
   * @param texts - Interface-defined texts to count.
   * @returns The interface-defined measurement, or undefined when no loaded
   * instance matches.
   * @throws The interface-defined admission or measurement failure; a failed
   * SDK query or an invalid answer is kept as the cause.
   */
  public async findLlmContextMeasurement(
    model: string,
    texts: readonly string[]
  ): Promise<LlmContextMeasurement | undefined> {
    return await this.#admission.runOperation(async () => {
      try {
        const loadedModels = await this.#client.llm.listLoaded()
        return await findLoadedLlmContextMeasurement(
          loadedModels.filter((loadedModel) =>
            isSelectedLoadedModel(loadedModel, model)
          ),
          texts
        )
      } catch (cause) {
        throw new Error("The LLM runtime could not measure the context.", {
          cause
        })
      }
    })
  }

  /**
   * Implements the {@link LlmRuntime} disposal contract for the owned SDK client.
   *
   * @returns The shared cleanup outcome after active work and SDK release settle.
   * @throws The interface-defined terminal resource-release failure.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.#admission.close(async () => await this.#closeRuntimeResources())
  }

  /**
   * Releases the sole SDK registration and translates failure for its cleanup owner.
   *
   * @returns A promise resolving after SDK client disposal completes.
   * @throws The interface-defined resource-release failure with the original cause.
   */
  async #closeRuntimeResources(): Promise<void> {
    try {
      await this.#clientLifetime.disposeAsync()
    } catch (cause) {
      throw new Error("The LLM runtime could not release its resources.", {
        cause
      })
    }
  }
}

/**
 * Answers whether a chat request naming a model reaches a loaded instance.
 *
 * @param loadedModel - Loaded instance handle.
 * @param model - Model selection as a chat request names it.
 * @returns True when the selection is the instance's identifier or its
 * canonical model key.
 */
function isSelectedLoadedModel(loadedModel: LLM, model: string): boolean {
  return loadedModel.identifier === model || loadedModel.modelKey === model
}

/**
 * Measures texts with the tokenizer of the selected loaded instances.
 *
 * @param selectedModels - Loaded instances of one model; may be empty.
 * @param texts - Texts to count, each on its own.
 * @returns A frozen measurement with the smallest reported context length and
 * one count per text; undefined when no instance is selected.
 * @throws If a query fails, or an answer is not a positive whole context
 * length or a whole token count ≥ 0.
 * @remarks Instances of one model share its tokenizer, so the first one
 * counts the texts, with one concurrent query per text that returns only its
 * count. No text means no tokenizer query.
 */
async function findLoadedLlmContextMeasurement(
  selectedModels: readonly LLM[],
  texts: readonly string[]
): Promise<LlmContextMeasurement | undefined> {
  const [tokenizingModel] = selectedModels
  if (tokenizingModel === undefined) return undefined
  const contextLengths = await Promise.all(
    selectedModels.map(async (loadedModel) =>
      lmStudioContextLengthSchema.parse(await loadedModel.getContextLength())
    )
  )
  const textTokenCounts = await Promise.all(
    texts.map(async (text) =>
      lmStudioTokenCountSchema.parse(await tokenizingModel.countTokens(text))
    )
  )
  return Object.freeze({
    contextLength: Math.min(...contextLengths),
    textTokenCounts: Object.freeze(textTokenCounts)
  })
}

/**
 * Builds the SDK load config for one load from validated load settings.
 *
 * @param loadConfiguration - Load settings to give the SDK.
 * @returns A newly owned config holding each set setting under the SDK's name
 * for it, and no entry for a setting that is absent, so that LM Studio decides
 * that setting.
 * @remarks `@lmstudio/sdk` 2.0.0 derives one more setting from this config.
 * When the config sets a context length, the SDK also sends `autoFit: false`,
 * so LM Studio's auto-fit, which would choose the context length and the model
 * placement from the available resources, is off for that load. The SDK
 * rejects `autoFit: true` together with a context length.
 */
function buildLmStudioLoadConfig(
  loadConfiguration: ModelLoadConfiguration
): LLMLoadModelConfig {
  const {
    contextLength,
    evalBatchSize,
    flashAttention,
    offloadKVCacheToGpu,
    numExperts
  } = loadConfiguration
  // One setting is added per step, because an absent setting must stay absent:
  // the SDK's config type does not accept `undefined` for it.
  const configWithContextLength: LLMLoadModelConfig =
    contextLength === undefined ? {} : { contextLength }
  const configWithEvalBatchSize: LLMLoadModelConfig =
    evalBatchSize === undefined
      ? configWithContextLength
      : { ...configWithContextLength, evalBatchSize }
  const configWithFlashAttention: LLMLoadModelConfig =
    flashAttention === undefined
      ? configWithEvalBatchSize
      : { ...configWithEvalBatchSize, flashAttention }
  const configWithKvCachePlacement: LLMLoadModelConfig =
    offloadKVCacheToGpu === undefined
      ? configWithFlashAttention
      : { ...configWithFlashAttention, offloadKVCacheToGpu }
  return numExperts === undefined
    ? configWithKvCachePlacement
    : { ...configWithKvCachePlacement, numExperts }
}
