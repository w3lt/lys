export type View = "chat" | "settings"
export type SettingsPane = "runtime" | "model" | "generation" | "conversation"
export type BackendStatus = "running" | "starting" | "stopping" | "stopped"
export type ModelStatus = "loaded" | "loading" | "unloading" | "none"
export type ScenarioKey =
  | "empty"
  | "streaming"
  | "stopped"
  | "long"
  | "error"
  | "jump"
  | "no-model"
  | "offline"
  | "runtime"
  | "loading"

export type Message =
  | { id: string; role: "user"; text: string }
  | {
      id: string
      role: "lys"
      text: string
      status: "streaming" | "complete" | "stopped"
    }
  | { id: string; role: "error"; title: string; text: string }

export interface RuntimeState {
  backend: BackendStatus
  model: ModelStatus
  modelProgress: number
  autostart: boolean
  startedAt: number
  log: Array<{
    id: string
    time: string
    text: string
    tone: "ok" | "wait" | "warn"
  }>
}

export interface LysConfig {
  endpoint: string
  model: string
  contextSize: 4096 | 8192 | 16384 | 32768
  temperature: number
  maxTokens: number
  stream: boolean
  trim: "drop" | "stop"
  systemPrompt: string
}

export interface AppState {
  view: View
  pane: SettingsPane
  messages: Message[]
  draft: string
  streaming: boolean
  atBottom: boolean
  scenarioMenuOpen: boolean
  runtime: RuntimeState
  config: LysConfig
}

export type AppAction =
  | { type: "draftChanged"; draft: string }
  | { type: "messageAdded"; message: Message }
  | { type: "replyStarted"; messageId: string }
  | { type: "replyChunkReceived"; messageId: string; text: string }
  | { type: "replyCompleted"; messageId: string }
  | { type: "replyStopped" }
  | { type: "errorsCleared" }
  | { type: "newChat" }
  | { type: "scenarioSelected"; state: AppState }
  | { type: "scenarioMenuChanged"; open: boolean }
  | { type: "viewChanged"; view: View }
  | { type: "paneChanged"; pane: SettingsPane }
  | { type: "scrollPositionChanged"; atBottom: boolean }
  | { type: "configChanged"; patch: Partial<LysConfig> }
  | { type: "backendStartRequested" }
  | { type: "backendStarted"; startedAt: number }
  | { type: "backendStopRequested" }
  | { type: "backendStopped" }
  | { type: "modelLoadStarted" }
  | { type: "modelLoadProgressed"; progress: number }
  | { type: "modelLoaded" }
  | { type: "modelUnloadStarted" }
  | { type: "modelUnloaded" }
  | { type: "modelSelected"; model: string }
  | { type: "autostartToggled" }
  | {
      type: "logAdded"
      entry: RuntimeState["log"][number]
    }
