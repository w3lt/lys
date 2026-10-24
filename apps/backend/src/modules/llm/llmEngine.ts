import type { ModelLoadConfiguration } from "@lys/share"
import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LoadedLlmModelInstance
} from "./llmRuntimeTypes"

/**
 * Performs model operations against one attached LLM engine.
 *
 * @remarks Boundary capability used by the owning application service. All
 * operations are completion-only: user cancellation is unavailable, and a
 * client disconnect does not end accepted work or its ownership. Snapshots are
 * newly owned, transitively immutable observations, not model ownership or SDK
 * handles. External actors can change the engine afterward. Failure never
 * implies rollback of effects already performed.
 */
export interface LlmEngine {
  /**
   * Observes the engine's downloaded LLM metadata without changing model state.
   *
   * @returns A frozen snapshot array, empty when no models are downloaded, with
   * frozen metadata and quantization values and no application loaded-state flag.
   * Ordering follows the engine observation; application sorting belongs to the service.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not list downloaded models.` for query failure, or
   * `The LLM runtime returned invalid model metadata.` for malformed metadata.
   */
  listDownloadedLlmModels(): Promise<readonly DownloadedLlmModel[]>

  /**
   * Observes the current loaded instances without changing model state.
   *
   * @returns A newly owned frozen array of frozen identities, empty when none
   * are observed. Array order follows the engine observation.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not list loaded model instances.` for query failure,
   * or `The LLM runtime returned an invalid model instance.` for malformed identity.
   */
  listLoadedLlmModelInstances(): Promise<readonly LoadedLlmModelInstance[]>

  /**
   * Loads the selected model to completion under a given instance
   * identifier and observes its canonical identity.
   *
   * @param modelKeyOrAlias - Model selection interpreted within the attached engine.
   * Unknown or rejected selections fail; repeated loads may create additional instances.
   * @param loadConfiguration - Validated load settings applied to this load only.
   * The engine decides each setting that is absent. How the engine treats a
   * value the selected model cannot use, such as a context length above the
   * model's maximum, is engine-defined.
   * @param instanceIdentifier - Non-empty identifier the new instance gets;
   * the load fails when an instance already has it.
   * @returns A frozen identity after the engine has completed loading and its
   * non-empty canonical key and instance identifier have been validated.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not load the model.` for load failure, including
   * an identifier in use, or
   * `The LLM runtime returned an invalid model instance.` for malformed identity.
   * @remarks Non-idempotent and completion-only. Failure can leave a model loaded.
   */
  loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration,
    instanceIdentifier: string
  ): Promise<LoadedLlmModelInstance>

  /**
   * Stops one addressed model instance to the engine's acknowledgement.
   *
   * @param modelIdentifier - Opaque instance identifier scoped to the attached runtime.
   * An already absent or otherwise rejected identifier may fail.
   * @returns A promise resolving after the engine acknowledges the stop.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not stop the model instance.` for stop failure.
   * @remarks Completion-only; neither idempotence nor whole-model absence is
   * promised. The service reconciles final model-key state through fresh inventory.
   */
  stopLoadedLlmModelInstance(modelIdentifier: string): Promise<void>

  /**
   * Measures texts with the tokenizer of a loaded model and observes the
   * context length it is loaded with, without changing model state.
   *
   * @param model - Model selection as a chat request names it: a loaded
   * instance's identifier or a loaded model's canonical key.
   * @param texts - Texts to count, each on its own; may be empty.
   * @returns A frozen measurement whose context length is the smallest among
   * the loaded instances the selection names, with one count per text in
   * text order; undefined when no loaded instance matches the selection.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not measure the context.` for a failed query or a
   * malformed engine answer.
   * @remarks Never loads a model.
   */
  findLlmContextMeasurement(
    model: string,
    texts: readonly string[]
  ): Promise<LlmContextMeasurement | undefined>
}
