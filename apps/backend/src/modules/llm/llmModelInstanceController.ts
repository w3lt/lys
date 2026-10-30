import type { ModelLoadConfiguration } from "@lys/share"
import type { LoadedLlmModelInstance } from "./llmRuntimeTypes"

/**
 * Loads models into one attached LLM engine and stops its loaded instances.
 *
 * @remarks Boundary capability used by the owning application service for an
 * engine whose models answer only once Lys loads them. An engine that loads a
 * model when a request names it does not offer this capability. Both
 * operations are completion-only commands: user cancellation is unavailable,
 * and a client disconnect does not end accepted work or its ownership. The
 * capability shares the attached engine's admission: one operation at a time,
 * rejecting overlap with `The LLM runtime already has an active operation.`
 * and work after cleanup begins with `The LLM runtime is closed.` It is
 * released with the runtime that offers it. External actors can change the
 * engine afterward. Failure never implies rollback of effects already
 * performed.
 */
export interface LlmModelInstanceController {
  /**
   * Loads the selected model to completion and observes its canonical identity.
   *
   * @param modelKeyOrAlias - Model selection interpreted within the attached engine.
   * Unknown or rejected selections fail; repeated loads may create additional instances.
   * @param loadConfiguration - Validated load settings applied to this load only.
   * The engine decides each setting that is absent. How the engine treats a
   * value the selected model cannot use, such as a context length above the
   * model's maximum, is engine-defined.
   * @returns A frozen identity after the engine has completed loading and its
   * non-empty canonical key and instance identifier have been validated.
   * @throws The shared closed/busy failures, or
   * `The LLM runtime could not load the model.` for load failure, or
   * `The LLM runtime returned an invalid model instance.` for malformed identity.
   * @remarks Non-idempotent and completion-only. Failure can leave a model loaded.
   */
  loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration
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
}
