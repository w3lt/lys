import { DEFAULT_CONFIG } from "./content"
import type { AppAction, AppState, Message, RuntimeState } from "./types"

const updateRuntime = (
  state: AppState,
  patch: Partial<RuntimeState>
): AppState => ({ ...state, runtime: { ...state.runtime, ...patch } })

const updateMessage = (
  messages: Message[],
  messageId: string,
  update: (message: Extract<Message, { role: "lys" }>) => Message
): Message[] =>
  messages.map((message) =>
    message.role === "lys" && message.id === messageId
      ? update(message)
      : message
  )

export function createInitialState(now = Date.now()): AppState {
  return {
    view: "chat",
    pane: "runtime",
    messages: [],
    draft: "",
    streaming: false,
    atBottom: true,
    scenarioMenuOpen: false,
    runtime: {
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      autostart: true,
      startedAt: now,
      log: []
    },
    config: { ...DEFAULT_CONFIG }
  }
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "draftChanged":
      return { ...state, draft: action.draft }
    case "messageAdded":
      return { ...state, messages: [...state.messages, action.message] }
    case "replyStarted":
      if (state.streaming) return state

      return {
        ...state,
        streaming: true,
        messages: [
          ...state.messages,
          { id: action.messageId, role: "lys", text: "", status: "streaming" }
        ]
      }
    case "replyChunkReceived": {
      const message = state.messages.find(
        (item) =>
          item.role === "lys" &&
          item.id === action.messageId &&
          item.status === "streaming"
      )
      if (!state.streaming || !message) return state

      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (item) => ({
          ...item,
          text: item.text + action.text
        }))
      }
    }
    case "replyCompleted": {
      const message = state.messages.find(
        (item) =>
          item.role === "lys" &&
          item.id === action.messageId &&
          item.status === "streaming"
      )
      if (!state.streaming || !message) return state

      return {
        ...state,
        streaming: false,
        messages: updateMessage(state.messages, action.messageId, (item) => ({
          ...item,
          status: "complete"
        }))
      }
    }
    case "replyStopped": {
      const message = [...state.messages]
        .reverse()
        .find((item) => item.role === "lys" && item.status === "streaming")
      if (!state.streaming || !message || message.role !== "lys") return state

      return {
        ...state,
        streaming: false,
        messages: updateMessage(state.messages, message.id, (item) => ({
          ...item,
          status: "stopped"
        }))
      }
    }
    case "errorsCleared":
      return {
        ...state,
        messages: state.messages.filter((message) => message.role !== "error")
      }
    case "newChat":
      return {
        ...state,
        messages: [],
        draft: "",
        streaming: false,
        atBottom: true
      }
    case "scenarioSelected":
      return action.state
    case "scenarioMenuChanged":
      return { ...state, scenarioMenuOpen: action.open }
    case "viewChanged":
      return { ...state, view: action.view }
    case "paneChanged":
      return { ...state, pane: action.pane }
    case "scrollPositionChanged":
      return { ...state, atBottom: action.atBottom }
    case "configChanged":
      return { ...state, config: { ...state.config, ...action.patch } }
    case "backendStartRequested":
      return state.runtime.backend === "stopped"
        ? updateRuntime(state, { backend: "starting" })
        : state
    case "backendStarted":
      return state.runtime.backend === "starting"
        ? updateRuntime(state, {
            backend: "running",
            startedAt: action.startedAt
          })
        : state
    case "backendStopRequested":
      return state.runtime.backend === "running"
        ? updateRuntime(state, { backend: "stopping" })
        : state
    case "backendStopped":
      return state.runtime.backend === "stopping"
        ? updateRuntime(state, {
            backend: "stopped",
            model: "none",
            modelProgress: 0
          })
        : state
    case "modelLoadStarted":
      return state.runtime.backend === "running" &&
        state.runtime.model === "none"
        ? updateRuntime(state, { model: "loading", modelProgress: 0 })
        : state
    case "modelLoadProgressed":
      return state.runtime.model === "loading"
        ? updateRuntime(state, {
            modelProgress: Math.min(100, Math.max(0, action.progress))
          })
        : state
    case "modelLoaded":
      return state.runtime.model === "loading"
        ? updateRuntime(state, { model: "loaded", modelProgress: 100 })
        : state
    case "modelUnloadStarted":
      return state.runtime.backend === "running" &&
        state.runtime.model === "loaded"
        ? updateRuntime(state, { model: "unloading" })
        : state
    case "modelUnloaded":
      return state.runtime.model === "unloading"
        ? updateRuntime(state, { model: "none", modelProgress: 0 })
        : state
    case "modelSelected": {
      if (state.config.model === action.model) return state

      const selected = {
        ...state,
        config: { ...state.config, model: action.model }
      }

      return state.runtime.model === "none"
        ? selected
        : updateRuntime(selected, { model: "none", modelProgress: 0 })
    }
    case "autostartToggled":
      return updateRuntime(state, { autostart: !state.runtime.autostart })
    case "logAdded":
      return updateRuntime(state, {
        log: [...state.runtime.log, action.entry].slice(-7)
      })
  }
}
