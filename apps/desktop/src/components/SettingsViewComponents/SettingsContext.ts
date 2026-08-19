import { createContext, useContext } from "react"

import type { AppState, LysConfig } from "@/app/types"

/**
 * Application-owned capabilities exposed to interactive settings panes.
 *
 * @remarks The provider owns the complete demonstration state and action
 * implementations. Callbacks are synchronous proposals/requests; this
 * context does not promise persistence, backend completion, or model-load
 * completion. Consumers must be rendered below the provider and must not
 * retain or mutate the state object.
 */
export interface SettingsContextValue {
  /** Complete application state projected into settings controls. */
  state: AppState
  /** Requests a change to the runtime autostart setting. */
  onAutostartToggle: () => void
  /** Proposes a partial generation/configuration patch to the state owner. */
  onConfigChange: (patch: Partial<LysConfig>) => void
  /** Requests model loading; completion is owned by the provider's action. */
  onLoadModel: () => void
  /** Requests selection of one model identifier. */
  onSelectModel: (model: string) => void
  /** Requests backend startup; completion is owned by the provider's action. */
  onStartBackend: () => void
  /** Requests backend shutdown; completion is owned by the provider's action. */
  onStopBackend: () => void
  /** Requests model unloading; completion is owned by the provider's action. */
  onUnloadModel: () => void
}

/** Required settings context; `null` marks the absent-provider state. */
export const SettingsContext = createContext<SettingsContextValue | null>(null)

/**
 * Reads the settings context for an interactive pane.
 *
 * @returns The provider-owned settings state and callbacks.
 * @throws If the calling pane is not rendered below `SettingsContext.Provider`.
 */
export function useSettingsContext() {
  const context = useContext(SettingsContext)

  if (!context) {
    throw new Error(
      "Settings pane components must be rendered within SettingsContext.Provider"
    )
  }

  return context
}
