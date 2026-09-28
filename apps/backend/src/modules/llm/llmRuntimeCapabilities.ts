import type { LlmRuntimeConnectionStatus } from "@lys/protocol"

/**
 * Observes the backend's LLM runtime connection for the runtime-status route.
 *
 * @remarks Implementations are ready when injected. Reading the status is a
 * synchronous in-memory query: it never contacts the runtime, never enters the
 * model-operation queue, and remains available after cleanup.
 */
export interface LlmRuntimeConnectionObserver {
  /**
   * Current connection status.
   *
   * @returns `connecting`, `connected`, or `unreachable` at the instant of access.
   */
  get llmRuntimeConnectionStatus(): LlmRuntimeConnectionStatus
}

/**
 * Connects the backend to its LLM runtime for the runtime-connect route and startup.
 *
 * @remarks Implementations are ready when injected. An attempt occupies one
 * position in the shared model-operation queue and runs after earlier accepted
 * work, so it never overlaps a model operation. Concurrent calls share one
 * pending attempt. The application-scoped provider owns an accepted attempt
 * until it settles, independently of the requesting client. No completion
 * deadline is guaranteed.
 */
export interface LlmRuntimeConnector {
  /**
   * Keeps a held runtime that still answers, or acquires a new one.
   *
   * @returns A promise resolving to the settled status, `connected` or
   * `unreachable`. An acquisition failure resolves to `unreachable`.
   * @throws `The LLM runtime is closed.` after cleanup begins.
   * @throws A service-busy error recognized by
   * [isLlmServiceBusyError](./llmServiceBusyError.ts) when the queue is full;
   * no attempt starts.
   * @throws A probe failure of the held runtime, which leaves the status
   * unchanged, or a release failure, after which the status is `unreachable`.
   */
  connectLlmRuntime(): Promise<LlmRuntimeConnectionStatus>
}
