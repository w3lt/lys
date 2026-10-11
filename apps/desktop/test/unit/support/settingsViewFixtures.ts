import { createLlmRuntimeUnavailableProblem } from "@lys/protocol"
import { vi } from "vitest"
import type { SettingsPane } from "@/app/types"
import { buildJsonResponse, type BackendRoute } from "./backendFake"
import {
  updateStoreRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "./runtimeFixtures"

/** Route key of the model inventory read. */
export const INVENTORY_ROUTE = "GET /api/v1/llm/list"

/**
 * Builds an inventory route that answers as the backend does for the arranged
 * inventory.
 *
 * @param runtime - Runtime whose inventory the backend reports.
 * @returns The route: the listed models for a ready inventory, a server
 * failure for a failed one, and the declared runtime-unavailable refusal
 * while LM Studio cannot be reached.
 */
export function buildInventoryRoute(
  runtime: RuntimeArrangement = READY_RUNTIME
): BackendRoute {
  const inventory = runtime.modelInventory
  switch (inventory.status) {
    case "ready":
      return () => buildJsonResponse(200, { llms: inventory.models })
    case "failed":
      return () => new Response(null, { status: 500 })
    case "unavailable":
      return () =>
        buildJsonResponse(
          503,
          createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
        )
  }
}

/**
 * Loads a fresh application store and the settings view, opened on one pane
 * with the arranged runtime.
 *
 * @param pane - Pane the view opens on.
 * @param runtime - Backend, LM Studio, and model facts.
 * @returns The application store and the view component.
 * @remarks A running backend makes the view read the inventory when it
 * appears, so a case with one declares {@link INVENTORY_ROUTE}.
 */
export async function loadFreshSettingsView(
  pane: SettingsPane,
  runtime: RuntimeArrangement = READY_RUNTIME
) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { default: SettingsView } =
    await import("@/views/SettingsView/SettingsView")
  updateStoreRuntime(useLysStore, runtime)
  useLysStore.setState({ settingsPane: pane })
  return { useLysStore, SettingsView }
}
