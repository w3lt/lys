import type { ReactElement } from "react"
import type { LlmTestModelApiResponse } from "@lys/protocol"

import type { ModelRequestState } from "@/lib/store/model-runtime"

import { useSettingsContext } from "./SettingsContext"

/**
 * Describes an in-flight model request.
 * @param request - Non-idle request owned by the application store.
 * @returns The inventory refresh, or the operation and its model key, followed
 * by an ellipsis.
 */
function formatModelRequestProgress(
  request: Exclude<ModelRequestState, { readonly status: "idle" }>
): string {
  if (request.status === "listing") return "Refreshing model inventory…"
  return `${request.status} ${request.modelKey}…`
}

/**
 * Describes the health endpoint's observation without claiming inference succeeded.
 * @param health - Latest validated loaded-state observation.
 * @returns Model-specific health result and query latency in milliseconds.
 */
function formatModelHealth(health: LlmTestModelApiResponse): string {
  if (health.status === "ready")
    return `${health.modelId}: loaded · health query ${health.latencyMs} ms`
  const reason =
    health.reason === "model-not-loaded" ? "not loaded" : "runtime unavailable"
  return `${health.modelId}: ${reason} · health query ${health.latencyMs} ms`
}

/**
 * Announces model operation progress, errors, and loaded-state health.
 * @returns Persistent live regions whose messages track the store-owned request.
 * @remarks Requires SettingsContext and owns
 * no work; the application store retains requests across pane changes.
 */
export default function ModelRequestFeedback(): ReactElement {
  const { modelRequest, modelError, modelHealth } = useSettingsContext()
  const pending =
    modelRequest.status === "idle"
      ? ""
      : formatModelRequestProgress(modelRequest)
  return (
    <div>
      <p aria-live="polite" className="settings-view__note" role="status">
        {pending || (modelHealth ? formatModelHealth(modelHealth) : "")}
      </p>
      <p className="settings-view__note" role="alert">
        {modelError}
      </p>
    </div>
  )
}
