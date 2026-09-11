import type { LlmInfo, LlmLoadModelApiResponse } from "@lys/protocol"
import type { LlmModelHealthOutcome } from "./getLlmModelHealth"
import type { StopLlmModelsByKeyOutcome } from "./stopLlmModelsByKey"

/**
 * Observes loaded-state health for the model-health route.
 *
 * @remarks Implementations are ready when injected. Health is a fresh,
 * non-generating loaded-inventory observation: `ready` means the provider
 * answered with valid inventory containing the exact canonical key.
 * The application-scoped provider owns accepted queries independently of the
 * requesting client connection. Health shares the model-operation FIFO: one
 * active operation and at most eight waiting. No completion deadline is
 * guaranteed. Cleanup rejects new work and awaits accepted health queries.
 */
export interface LlmModelHealthReader {
  /**
   * Observes whether one canonical model key is currently loaded.
   *
   * @param modelKey - Raw canonical-key candidate validated before queue admission.
   * @returns A promise resolving to immutable public health and separate internal diagnostics.
   * @throws If the candidate is empty or exceeds the protocol limit, application
   * response validation fails, or cleanup has begun; inventory failures are
   * represented by a `runtime-unavailable` outcome.
   * @throws A service-busy error recognized by
   * [isLlmServiceBusyError](./llmServiceBusyError.ts) if the shared queue is full;
   * the query is not accepted and has no runtime effects.
   * @remarks Every returned diagnostic must be reported synchronously before
   * the consuming boundary completes its response.
   */
  getLlmModelHealth(modelKey: string): Promise<LlmModelHealthOutcome>
}

/**
 * Lists LLM model inventory for the model-list route.
 *
 * @remarks Implementations are ready when injected and return newly owned,
 * immutable snapshots. The application composition lifetime owns provider
 * resources and cleanup. The application-scoped provider owns accepted queries
 * through snapshot completion or failure, independently of the requesting
 * client's connection. Inventory, load, and unload share one FIFO admission
 * budget: one active operation and at most eight waiting. Excess calls reject
 * before acceptance with a failure recognized by
 * [isLlmServiceBusyError](./llmServiceBusyError.ts). This completion-only capability
 * has no caller cancellation or completion-deadline guarantee. Cleanup rejects
 * new work and awaits accepted queries before releasing provider resources.
 */
export interface LlmModelInventory {
  /**
   * Lists the latest known models and their loaded state.
   *
   * @returns A promise resolving to immutable snapshots ordered by ascending
   * canonical model key.
   * @throws If the provider cannot query or validate its model inventory, or
   * its application lifetime has begun cleanup.
   * @throws A service-busy error if the shared model-operation queue is full;
   * the query is not accepted and no runtime work starts.
   */
  listLlmModels(): Promise<readonly LlmInfo[]>
}

/**
 * Loads LLM models for the model-load route.
 *
 * @remarks Implementations are ready when injected. The application
 * composition lifetime owns provider resources and cleanup. By product design,
 * users cannot cancel accepted loads: the application-scoped provider owns both
 * queued and active work until the model is loaded and described or the operation
 * fails. A client disconnect does not revoke that ownership. Loads share the
 * FIFO admission budget defined by {@link LlmModelInventory}: one active model
 * operation and eight waiting. No completion deadline is guaranteed. Cleanup
 * rejects new work and awaits accepted loads before releasing provider resources.
 */
export interface LlmModelLoader {
  /**
   * Loads one model key or alias and returns its canonical inventory metadata.
   *
   * @param modelKeyOrAlias - Model key or alias for the selected provider to resolve.
   * @returns A promise resolving only after the model is loaded and its
   * immutable canonical metadata has been validated.
   * @throws If the provider cannot load or describe the model, the model is
   * absent from inventory, metadata is invalid, or application cleanup has begun.
   * @throws A service-busy error recognized by
   * [isLlmServiceBusyError](./llmServiceBusyError.ts) if the shared queue is full;
   * the load is not accepted and has no runtime effects.
   * @remarks Loading changes provider runtime state. No atomicity or
   * idempotency guarantee is provided: a repeated call may create another
   * loaded instance, and an inventory or validation failure after loading may
   * leave the model loaded.
   */
  loadLlmModel(modelKeyOrAlias: string): Promise<LlmLoadModelApiResponse>
}

/**
 * Stops loaded LLM models for the model-unload route.
 *
 * @remarks Implementations are ready when injected. The application
 * composition lifetime owns provider resources and cleanup. By product design,
 * users cannot cancel accepted unloads: the application-scoped provider owns both
 * queued and active work through stop attempts and reconciliation, including
 * their failure outcomes. A client disconnect does not revoke that ownership.
 * Unloads share the FIFO admission budget defined by {@link LlmModelInventory}:
 * one active model operation and eight waiting. No completion deadline is
 * guaranteed. Cleanup rejects new work and awaits accepted unloads before
 * releasing provider resources.
 */
export interface LlmModelStopper {
  /**
   * Stops every loaded instance observed for one canonical model key.
   *
   * @param modelKey - Canonical model key whose instances should stop.
   * @returns A promise resolving to an immutable outcome based on the initial
   * or reconciled loaded-instance snapshot.
   * @throws If the application lifetime has begun cleanup; provider operation
   * failures are represented by the returned outcome.
   * @throws A service-busy error recognized by
   * [isLlmServiceBusyError](./llmServiceBusyError.ts) if the shared queue is full;
   * the unload is not accepted and has no runtime effects.
   * @remarks Stopping changes provider runtime state and is not atomic. A
   * `stopped` outcome means the reconciliation snapshot contains no matching
   * instances; `stop-failed` or `runtime-unavailable` may follow partial stop
   * effects. A repeated call after `stopped` returns `not-loaded` unless the
   * model was loaded again, so repeated calls do not preserve the same status.
   */
  stopLlmModelsByKey(modelKey: string): Promise<StopLlmModelsByKeyOutcome>
}
