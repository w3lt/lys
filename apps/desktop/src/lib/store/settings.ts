export type RuntimeSettings = {
  autoStartBackend: boolean
  selectedModel?: string
}

export type LysSettings = {
  runtime: RuntimeSettings
}

export const initialSettingsState: LysSettings = {
  runtime: {
    autoStartBackend: false,
    selectedModel: undefined
  }
}
