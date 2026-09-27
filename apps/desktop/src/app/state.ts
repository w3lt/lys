import { DEFAULT_CONFIG } from "./content"
import type {
  AppAction,
  AppState,
  LysMessage,
  Message,
  RuntimeState
} from "./types"

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
 * Applies a runtime transition only from the lifecycle statuses it requires.
 *
 * @param state - Current reducer-owned state.
 * @param required - Backend and model statuses that permit the transition; an omitted status matches any current value.
 * @param patch - Runtime fields to replace when the transition is permitted.
 * @returns The transitioned state, or the same object when the runtime is in any other status.
 */
const updateRuntimeFrom = (
  state: AppState,
  required: Partial<Pick<RuntimeState, "backend" | "model">>,
  patch: Partial<RuntimeState>
): AppState => {
  const { backend, model } = state.runtime
  const isPermitted =
    (required.backend ?? backend) === backend &&
    (required.model ?? model) === model

  return isPermitted ? updateRuntime(state, patch) : state
}

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
 * Checks whether a reply stream is active and the identified Lys reply is still streaming.
 *
 * @param state - Current reducer-owned state.
 * @param messageId - Identifier of the Lys reply to inspect.
 * @returns Whether the state is streaming and contains that streaming reply.
 */
const isReplyStreaming = (state: AppState, messageId: string): boolean =>
  state.streaming &&
  state.messages.some(
    (message) =>
      message.role === "lys" &&
      message.id === messageId &&
      message.status === "streaming"
  )

/**
 * Starts a streaming Lys reply unless a reply is already streaming.
 *
 * @param state - Current reducer-owned state.
 * @param messageId - Identifier assigned to the new reply.
 * @returns A state with an empty streaming reply appended, or the same object while a reply is streaming.
 */
const startReply = (state: AppState, messageId: string): AppState => {
  if (state.streaming) return state

  return {
    ...state,
    streaming: true,
    messages: [
      ...state.messages,
      { id: messageId, role: "lys", text: "", status: "streaming" }
    ]
  }
}

/**
 * Appends a text chunk to the identified reply while it is streaming.
 *
 * @param state - Current reducer-owned state.
 * @param messageId - Identifier of the streaming reply.
 * @param text - Text fragment to append.
 * @returns A state with the reply text extended, or the same object when that reply is not actively streaming.
 */
const updateReplyText = (
  state: AppState,
  messageId: string,
  text: string
): AppState => {
  if (!isReplyStreaming(state, messageId)) return state

  return {
    ...state,
    messages: updateMessage(state.messages, messageId, (item) => ({
      ...item,
      text: item.text + text
    }))
  }
}

/**
 * Ends the active reply stream by moving the identified reply to a terminal status.
 *
 * @param state - Current reducer-owned state.
 * @param messageId - Identifier of the streaming reply.
 * @param status - Terminal status recorded on the reply.
 * @returns A state with streaming ended and the reply status replaced, or the same object when that reply is not actively streaming.
 */
const updateReplyStatus = (
  state: AppState,
  messageId: string,
  status: Exclude<LysMessage["status"], "streaming">
): AppState => {
  if (!isReplyStreaming(state, messageId)) return state

  return {
    ...state,
    streaming: false,
    messages: updateMessage(state.messages, messageId, (item) => ({
      ...item,
      status
    }))
  }
}

/**
 * Stops the most recent streaming Lys reply.
 *
 * @param state - Current reducer-owned state.
 * @returns A state with streaming ended and that reply marked stopped, or the same object when no reply is actively streaming.
 */
const stopReply = (state: AppState): AppState => {
  const reply = [...state.messages]
    .reverse()
    .find((item) => item.role === "lys" && item.status === "streaming")

  return reply ? updateReplyStatus(state, reply.id, "stopped") : state
}

/**
 * Selects a different model and resets any model runtime that is not already empty.
 *
 * @param state - Current reducer-owned state.
 * @param model - Model identifier to select.
 * @returns A state with the model selected and, unless the runtime model is `none`, the runtime model reset to `none` with zero progress; the same object when the model is already selected.
 */
const updateSelectedModel = (state: AppState, model: string): AppState => {
  if (state.config.model === model) return state

  const selected = { ...state, config: { ...state.config, model } }

  return state.runtime.model === "none"
    ? selected
    : updateRuntime(selected, { model: "none", modelProgress: 0 })
}

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
      return startReply(state, action.messageId)
    case "replyChunkReceived":
      return updateReplyText(state, action.messageId, action.text)
    case "replyCompleted":
      return updateReplyStatus(state, action.messageId, "complete")
    case "replyStopped":
      return stopReply(state)
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
      return updateRuntimeFrom(
        state,
        { backend: "stopped" },
        { backend: "starting" }
      )
    case "backendStarted":
      return updateRuntimeFrom(
        state,
        { backend: "starting" },
        { backend: "running", startedAt: action.startedAt }
      )
    case "backendStopRequested":
      return updateRuntimeFrom(
        state,
        { backend: "running" },
        { backend: "stopping" }
      )
    case "backendStopped":
      return updateRuntimeFrom(
        state,
        { backend: "stopping" },
        { backend: "stopped", model: "none", modelProgress: 0 }
      )
    case "modelLoadStarted":
      return updateRuntimeFrom(
        state,
        { backend: "running", model: "none" },
        { model: "loading", modelProgress: 0 }
      )
    case "modelLoadProgressed":
      return updateRuntimeFrom(
        state,
        { model: "loading" },
        { modelProgress: Math.min(100, Math.max(0, action.progress)) }
      )
    case "modelLoaded":
      return updateRuntimeFrom(
        state,
        { model: "loading" },
        { model: "loaded", modelProgress: 100 }
      )
    case "modelUnloadStarted":
      return updateRuntimeFrom(
        state,
        { backend: "running", model: "loaded" },
        { model: "unloading" }
      )
    case "modelUnloaded":
      return updateRuntimeFrom(
        state,
        { model: "unloading" },
        { model: "none", modelProgress: 0 }
      )
    case "modelSelected":
      return updateSelectedModel(state, action.model)
    case "autostartToggled":
      return updateRuntime(state, { autostart: !state.runtime.autostart })
    case "logAdded":
      return updateRuntime(state, {
        log: [...state.runtime.log, action.entry].slice(-7)
      })
  }
}
