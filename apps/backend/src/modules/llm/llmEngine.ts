import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LoadedLlmModelInstance
} from "./llmRuntimeTypes"

/**
 * Observes the models of one attached LLM engine and measures contexts with
 * their tokenizers, or with estimates where the engine exposes none.
 *
 * @remarks Boundary capability used by the owning application service. All
 * operations are completion-only queries: user cancellation is unavailable,
 * and a client disconnect does not end accepted work or its ownership.
 * Snapshots are newly owned, transitively immutable observations, not model
 * ownership or SDK handles. External actors can change the engine afterward.
 * Loading and stopping models is the separate
 * [LlmModelInstanceController](./llmModelInstanceController.ts) capability,
 * which only engines that Lys loads models in offer.
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
   * Observes the model instances that answer a request now, without changing
   * model state.
   *
   * @returns A newly owned frozen array of frozen identities, empty when none
   * are observed. Array order follows the engine observation. An engine that
   * Lys loads models in reports the instances it has loaded. An engine whose
   * provider decides which models are in memory reports the models it serves
   * now: the ones a local server reports running, or every model a hosted
   * provider lists, because it serves each on demand.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not list loaded model instances.` for query failure,
   * or `The LLM runtime returned an invalid model instance.` for malformed identity.
   */
  listLoadedLlmModelInstances(): Promise<readonly LoadedLlmModelInstance[]>

  /**
   * Measures texts with the tokenizer of a loaded model, or estimates their
   * counts where the engine exposes no tokenizer, and observes the context
   * length the model is loaded with, without changing model state.
   *
   * @param model - Model selection as a chat request names it: a loaded
   * instance's identifier or a loaded model's canonical key.
   * @param texts - Texts to count, each on its own; may be empty.
   * @returns A frozen measurement whose context length is the smallest among
   * the loaded instances the selection names, with one count per text in
   * text order, exact or estimated as the implementation documents;
   * undefined when no loaded instance matches the selection, or the engine
   * does not report the length one is loaded with.
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
