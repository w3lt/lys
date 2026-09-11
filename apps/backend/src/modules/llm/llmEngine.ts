import type {
  DownloadedLlmModel,
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
   * Loads the selected model to completion and observes its canonical identity.
   *
   * @param modelKeyOrAlias - Model selection interpreted within the attached engine.
   * Unknown or rejected selections fail; repeated loads may create additional instances.
   * @returns A frozen identity after the engine has completed loading and its
   * non-empty canonical key and instance identifier have been validated.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not load the model.` for load failure, or
   * `The LLM runtime returned an invalid model instance.` for malformed identity.
   * @remarks Non-idempotent and completion-only. Failure can leave a model loaded.
   */
  loadLlmModel(modelKeyOrAlias: string): Promise<LoadedLlmModelInstance>

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
}
