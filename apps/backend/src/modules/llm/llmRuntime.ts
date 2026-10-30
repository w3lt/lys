import type { LlmEngine } from "./llmEngine"
import type { LlmModelInstanceController } from "./llmModelInstanceController"
import type { LlmRuntimeLifecycle } from "./llmRuntimeLifecycle"

/**
 * Owns model-engine access and lifecycle control for one runtime adapter.
 *
 * @remarks Implementations are ready and provider-available on acquisition;
 * the runtime service acquires one when it connects, not during application
 * startup.
 * They admit one operation without a waiting queue; overlap rejects with
 * `The LLM runtime already has an active operation.` and work after cleanup
 * begins rejects with `The LLM runtime is closed.` The owning service retains
 * accepted completion-only operations and disposes the runtime after they settle.
 *
 * The runtime service consumes engine operations, availability probes, and
 * disposal.
 */
export interface LlmRuntime extends LlmEngine, LlmRuntimeLifecycle {}

/**
 * A runtime acquired for one provider, with who loads that provider's models.
 *
 * @remarks Cleanup ownership of the runtime transfers to the acquirer. The
 * model-loading capability belongs to the same runtime: it shares its
 * admission and is released with it.
 */
export type AcquiredLlmRuntime =
  | Readonly<{
      /**
       * The provider loads a model when a request names it, so every model
       * it lists answers without a load from Lys.
       */
      modelLoading: "provider"
      /** Acquired runtime. */
      llmRuntime: LlmRuntime
    }>
  | Readonly<{
      /** A model answers only once Lys loads it. */
      modelLoading: "lys"
      /** Acquired runtime. */
      llmRuntime: LlmRuntime
      /** Loads the runtime's models and stops their instances. */
      llmModelInstanceController: LlmModelInstanceController
    }>
