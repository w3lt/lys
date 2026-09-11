import { DEFAULT_CONFIG } from "./content"
import type { AppAction, AppState, Message, RuntimeState } from "./types"

/**
 * Applies a partial runtime transition without mutating the current state.
 *
 * @param state - Current reducer-owned state.
 * @param patch - Runtime fields to replace in the returned state.
 * @returns A new state sharing all unchanged application fields.
 */
const updateRuntime = (
  state: AppState,
  patch: Partial<RuntimeState>
): AppState => ({ ...state, runtime: { ...state.runtime, ...patch } })

/**
 * Updates one in-progress Lys message while preserving all other messages.
 *
 * @param messages - Transcript entries to inspect.
 * @param messageId - Identifier of the assistant message to update.
 * @param update - Transformation applied to the matching assistant message.
 * @returns A new transcript array with the matching entry transformed when present.
 */
const updateMessage = (
  messages: Message[],
  messageId: string,
  update: (
    message: Extract<
      Message,
      {
        /** Restricts the callback input to assistant-owned transcript entries. */
        role: "lys"
      }
    >
  ) => Message
): Message[] =>
  messages.map((message) =>
    message.role === "lys" && message.id === messageId
      ? update(message)
      : message
  )

/**
 * Creates the reducer's deterministic initial state.
 *
 * @param now - Epoch timestamp in milliseconds used as the initial backend start time.
 * @returns A fresh state object with empty messages and the default demonstration runtime.
 */
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

/**
 * Applies one explicit UI or runtime action to immutable application state.
 *
 * @param state - Current reducer-owned application state.
 * @param action - Closed action variant describing one requested transition.
 * @returns The next state, or the same object when the action is invalid for the current lifecycle state.
 */
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
