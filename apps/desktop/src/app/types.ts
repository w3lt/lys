/** Top-level application view selected by the desktop shell. */
export type View = "chat" | "settings"
/** Settings pane selected within the settings view. */
export type SettingsPane = "runtime" | "model" | "generation"
/** Backend process lifecycle states represented by the demonstration reducer. */
export type BackendStatus = "running" | "starting" | "stopping" | "stopped"
/** Model lifecycle states represented by the demonstration reducer. */
export type ModelStatus = "loaded" | "loading" | "unloading" | "none"
/** Demonstration scenario identifiers accepted by the scenario selector. */
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

/** User-authored message in the demonstration transcript. */
export type UserMessage = {
  /** Stable message identifier used by the view. */
  id: string
  /** Discriminant identifying user ownership. */
  role: "user"
  /** Rendered message text. */
  text: string
}
/** Assistant message whose status tracks demonstration streaming completion. */
export type LysMessage = {
  /** Stable message identifier used by the view. */
  id: string
  /** Discriminant identifying Lys ownership. */
  role: "lys"
  /** Text received so far. */
  text: string
  /** Whether the simulated reply is still streaming, complete, or stopped. */
  status: "streaming" | "complete" | "stopped"
}

/** Error message rendered in the demonstration transcript. */
export type ErrorMessage = {
  /** Stable message identifier used by the view. */
  id: string
  /** Discriminant identifying an error entry. */
  role: "error"
  /** Short visible error heading. */
  title: string
  /** Longer visible error explanation. */
  text: string
}

/** Closed union of transcript entries rendered by the demonstration app. */
export type Message = UserMessage | LysMessage | ErrorMessage

/** Reducer-owned runtime state for the demonstration backend and model controls. */
export interface RuntimeState {
  /** Backend process lifecycle state. */
  backend: BackendStatus
  /** Model lifecycle state. */
  model: ModelStatus
  /** Model load percentage, normally 0 through 100; `NaN` can pass the reducer's numeric clamp. */
  modelProgress: number
  /** Whether the runtime should be started automatically in the demonstration state. */
  autostart: boolean
  /** Epoch timestamp in milliseconds for the current backend run. */
  startedAt: number
  /** Latest seven runtime log entries, in append order. */
  log: Array<{
    /** Stable log entry identifier. */
    id: string
    /** Display-formatted log time. */
    time: string
    /** Human-readable log entry text. */
    text: string
    /** Display tone selected by the runtime state. */
    tone: "ok" | "wait" | "warn"
  }>
}

/** Demonstration generation configuration shown by settings controls. */
export interface LysConfig {
  /** LM Studio endpoint host and port displayed by the demo. */
  endpoint: string
  /** Selected model identifier. */
  model: string
  /** Supported context-window size in tokens. */
  contextSize: 4096 | 8192 | 16384 | 32768
  /** Sampling temperature; the demonstration does not validate its range here. */
  temperature: number
  /** Maximum response token count displayed by the demo. */
  maxTokens: number
  /** Whether streaming is enabled in the displayed configuration. */
  stream: boolean
  /** Context overflow policy displayed by the demo. */
  trim: "drop" | "stop"
  /** System instruction displayed by the demo. */
  systemPrompt: string
}

/** Complete reducer state for the desktop demonstration application. */
export interface AppState {
  /** Active top-level view. */
  view: View
  /** Active settings pane. */
  pane: SettingsPane
  /** Transcript entries in display order. */
  messages: Message[]
  /** Current unsent composer text. */
  draft: string
  /** Whether a simulated assistant reply is in progress. */
  streaming: boolean
  /** Whether the transcript is currently at its bottom edge. */
  atBottom: boolean
  /** Whether the demonstration scenario menu is open. */
  scenarioMenuOpen: boolean
  /** Backend and model lifecycle state. */
  runtime: RuntimeState
  /** Generation settings currently shown by the demo. */
  config: LysConfig
}

/** Closed set of reducer actions and their payloads. */
export type AppAction =
  | {
      /** Discriminant for a composer update. */
      type: "draftChanged"
      /** Replacement unsent composer text. */
      draft: string
    }
  | {
      /** Discriminant for appending a transcript entry. */
      type: "messageAdded"
      /** Entry to append. */
      message: Message
    }
  | {
      /** Discriminant for starting an assistant reply. */
      type: "replyStarted"
      /** Identifier assigned to the new reply. */
      messageId: string
    }
  | {
      /** Discriminant for appending a reply chunk. */
      type: "replyChunkReceived"
      /** In-progress reply identifier. */
      messageId: string
      /** Text fragment to append. */
      text: string
    }
  | {
      /** Discriminant for completing a reply. */
      type: "replyCompleted"
      /** In-progress reply identifier. */
      messageId: string
    }
  | {
      /** Discriminant for stopping the latest reply. */
      type: "replyStopped"
    }
  | {
      /** Discriminant for clearing transcript errors. */
      type: "errorsCleared"
    }
  | {
      /** Discriminant for starting a new chat. */
      type: "newChat"
    }
  | {
      /** Discriminant for selecting a complete demonstration scenario. */
      type: "scenarioSelected"
      /** Complete state supplied by the selected scenario. */
      state: AppState
    }
  | {
      /** Discriminant for opening or closing the scenario menu. */
      type: "scenarioMenuChanged"
      /** Whether the scenario menu should be open. */
      open: boolean
    }
  | {
      /** Discriminant for changing the active view. */
      type: "viewChanged"
      /** View to make active. */
      view: View
    }
  | {
      /** Discriminant for changing the active settings pane. */
      type: "paneChanged"
      /** Pane to make active. */
      pane: SettingsPane
    }
  | {
      /** Discriminant for recording transcript scroll position. */
      type: "scrollPositionChanged"
      /** Whether the transcript is at its bottom edge. */
      atBottom: boolean
    }
  | {
      /** Discriminant for changing generation configuration. */
      type: "configChanged"
      /** Partial configuration patch to merge. */
      patch: Partial<LysConfig>
    }
  | {
      /** Discriminant for requesting backend startup. */
      type: "backendStartRequested"
    }
  | {
      /** Discriminant for confirming backend startup. */
      type: "backendStarted"
      /** Epoch timestamp in milliseconds observed at startup. */
      startedAt: number
    }
  | {
      /** Discriminant for requesting backend shutdown. */
      type: "backendStopRequested"
    }
  | {
      /** Discriminant for confirming backend shutdown. */ type: "backendStopped"
    }
  | {
      /** Discriminant for starting model loading. */
      type: "modelLoadStarted"
    }
  | {
      /** Discriminant for reporting model load progress. */
      type: "modelLoadProgressed"
      /** Progress percentage; finite values are clamped by the reducer, but `NaN` remains `NaN`. */
      progress: number
    }
  | {
      /** Discriminant for confirming model loading. */
      type: "modelLoaded"
    }
  | {
      /** Discriminant for starting model unloading. */ type: "modelUnloadStarted"
    }
  | {
      /** Discriminant for confirming model unloading. */ type: "modelUnloaded"
    }
  | {
      /** Discriminant for selecting a model. */
      type: "modelSelected"
      /** Model identifier to select. */
      model: string
    }
  | {
      /** Discriminant for toggling runtime autostart. */ type: "autostartToggled"
    }
  | {
      /** Discriminant for appending a runtime log entry. */
      type: "logAdded"
      /** Runtime log entry to append. */
      entry: RuntimeState["log"][number]
    }
