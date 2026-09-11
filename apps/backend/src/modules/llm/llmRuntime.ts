import type { LlmEngine } from "./llmEngine"
import type { LlmRuntimeLifecycle } from "./llmRuntimeLifecycle"

/**
 * Owns model-engine access and lifecycle control for one runtime adapter.
 *
 * @remarks Implementations are ready and provider-available on acquisition.
 * They admit one operation without a waiting queue; overlap rejects with
 * `The LLM runtime already has an active operation.` and work after cleanup
 * begins rejects with `The LLM runtime is closed.` The owning service retains
 * accepted completion-only operations and disposes the runtime after they settle.
 *
 * This seven-member composition is an approved narrow exception to IFACE-006
 * and IFACE-026 because separating engine operations from lifecycle observation
 * preserves consumer segregation while one runtime owner requires both capabilities.
 */
export interface LlmRuntime extends LlmEngine, LlmRuntimeLifecycle {}
