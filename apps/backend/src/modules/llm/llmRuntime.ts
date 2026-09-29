import type { LlmEngine } from "./llmEngine"
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
