import { createContext, useContext } from "react"

import type { AppState, LysConfig } from "@/app/types"

export interface SettingsContextValue {
  state: AppState
  onAutostartToggle: () => void
  onConfigChange: (patch: Partial<LysConfig>) => void
  onLoadModel: () => void
  onSelectModel: (model: string) => void
  onStartBackend: () => void
  onStopBackend: () => void
  onUnloadModel: () => void
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettingsContext() {
  const context = useContext(SettingsContext)

  if (!context) {
    throw new Error(
      "Settings pane components must be rendered within SettingsContext.Provider"
    )
  }

  return context
}
