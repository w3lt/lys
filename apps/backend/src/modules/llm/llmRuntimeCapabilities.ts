import type { LlmRuntimeConnectionStatus } from "@lys/protocol"

/**
 * Observes the backend's connection to one provider's LLM runtime for the
 * runtime-status route.
 *
 * @remarks Implementations are ready when injected. Reading the status is a
 * synchronous in-memory query: it never contacts the runtime, never enters the
 * model-operation queue, and remains available after cleanup.
 */
export interface LlmRuntimeConnectionObserver {
  /**
   * Current connection status.
   *
   * @returns `connecting`, `connected`, `unreachable`, or `off` at the
   * instant of access.
   */
  get llmRuntimeConnectionStatus(): LlmRuntimeConnectionStatus
}

/**
 * Connects the backend to one provider's LLM runtime for the runtime-connect
 * route and startup.
 *
 * @remarks Implementations are ready when injected. An attempt occupies one
 * position in the shared model-operation queue and runs after earlier accepted
 * work, so it never overlaps a model operation. Concurrent calls share one
 * queued attempt. A call made while an attempt runs reads the saved provider
 * and shares that attempt when both reads found it on with the same address
 * or key; otherwise
 * it queues an attempt of its own, which reads the saved provider again when
 * it starts. The application-scoped provider owns an accepted attempt until it
 * settles, independently of the requesting client. No completion deadline is
 * guaranteed.
 */
export interface LlmRuntimeConnector {
  /**
   * Keeps a held runtime that still answers for the saved provider, or
   * acquires a new one for it; for a provider that is off, releases a held
   * runtime and acquires none.
   *
   * @returns A promise resolving to the settled status, `connected`,
   * `unreachable`, or `off`. An acquisition failure, or a provider that is
   * on but not usable as saved, resolves to `unreachable`; a provider that
   * is off resolves to `off`, which is not a failure.
   * @throws `The LLM runtime is closed.` after cleanup begins.
   * @throws A service-busy error recognized by
   * [isLlmServiceBusyError](./llmServiceBusyError.ts) when the queue is full;
   * no attempt starts.
   * @throws A probe failure of the held runtime, which leaves the status
   * unchanged, or a release failure, after which the status is `unreachable`.
   */
  connectLlmRuntime(): Promise<LlmRuntimeConnectionStatus>
}
