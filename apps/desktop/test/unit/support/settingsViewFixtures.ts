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
 * Imports of the pane bodies the settings view loads lazily, by pane.
 *
 * @remarks Each names the module the view's own lazy loader imports. A pane
 * missing here would only make its cases wait for the view's import again.
 */
const SETTINGS_PANE_BODY_IMPORTS = Object.freeze({
  runtime: () =>
    import("@/components/SettingsViewComponents/RuntimePaneContent"),
  model: () => import("@/components/SettingsViewComponents/ModelPaneContent"),
  generation: () =>
    import("@/components/SettingsViewComponents/GenerationPaneContent"),
  agents: () => import("@/components/SettingsViewComponents/AgentPaneContent"),
  tools: () => import("@/components/SettingsViewComponents/ToolPaneContent"),
  providers: () =>
    import("@/components/SettingsViewComponents/ProvidersPaneContent"),
  secrets: () =>
    import("@/components/SettingsViewComponents/SecretsPaneContent")
} satisfies Readonly<Record<SettingsPane, () => Promise<unknown>>>)

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
      return () =>
        buildJsonResponse(200, {
          llms: inventory.models,
          modelLoading: inventory.modelLoading
        })
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
 * appears, so a case with one declares {@link INVENTORY_ROUTE}. The body of
 * the opened pane is imported here as well. The view still shows its busy
 * frame first and the body after it, but a case's bounded wait for the body
 * no longer includes evaluating the pane's modules, whose duration depends on
 * the load of the machine.
 */
export async function loadFreshSettingsView(
  pane: SettingsPane,
  runtime: RuntimeArrangement = READY_RUNTIME
) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { default: SettingsView } =
    await import("@/views/SettingsView/SettingsView")
  await SETTINGS_PANE_BODY_IMPORTS[pane]()
  updateStoreRuntime(useLysStore, runtime)
  useLysStore.setState({ settingsPane: pane })
  return { useLysStore, SettingsView }
}
