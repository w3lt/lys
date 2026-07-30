import { useCallback, useEffect, useReducer, useRef } from "react"

import {
  createProgressSimulation,
  createTextSimulation,
  replyForPrompt,
  type SimulationController
} from "@/app/simulation"
import { appReducer, createInitialState } from "@/app/state"
import { ChatView } from "@/views/ChatView/ChatView"
import { Composer } from "@/components/Composer"
import { SettingsView } from "@/views/SettingsView/SettingsView"
import { TitleBar } from "@/components/TitleBar"

import "./App.scss"

function createOneShotInterval(
  delayMs: number,
  onComplete: () => void
): SimulationController {
  let cancelled = false
  const timer = window.setInterval(() => {
    window.clearInterval(timer)
    if (cancelled) return
    onComplete()
  }, delayMs)

  return {
    cancel() {
      cancelled = true
      window.clearInterval(timer)
    }
  }
}

function formatRuntimeTime(timestamp: number) {
  return new Date(timestamp).toISOString().slice(11, 19)
}

function App() {
  const [state, dispatch] = useReducer(
    appReducer,
    undefined,
    createInitialState
  )
  const nextMessageId = useRef(1)
  const nextRuntimeLogId = useRef(1)
  const textSimulationRef = useRef<SimulationController | undefined>(undefined)
  const backendSimulationRef = useRef<SimulationController | undefined>(
    undefined
  )
  const modelSimulationRef = useRef<SimulationController | undefined>(undefined)

  const cancelTextSimulation = useCallback(() => {
    textSimulationRef.current?.cancel()
    textSimulationRef.current = undefined
  }, [])

  const cancelBackendSimulation = useCallback(() => {
    backendSimulationRef.current?.cancel()
    backendSimulationRef.current = undefined
  }, [])

  const cancelModelSimulation = useCallback(() => {
    modelSimulationRef.current?.cancel()
    modelSimulationRef.current = undefined
  }, [])

  const cancelActiveSimulations = useCallback(() => {
    cancelTextSimulation()
    cancelBackendSimulation()
    cancelModelSimulation()
  }, [cancelBackendSimulation, cancelModelSimulation, cancelTextSimulation])

  useEffect(() => cancelActiveSimulations, [cancelActiveSimulations])

  function addRuntimeLog(
    text: string,
    tone: "ok" | "wait" | "warn",
    timestamp = Date.now()
  ) {
    const id = nextRuntimeLogId.current
    nextRuntimeLogId.current += 1
    dispatch({
      type: "logAdded",
      entry: {
        id: `runtime-${timestamp}-${id}`,
        time: formatRuntimeTime(timestamp),
        text,
        tone
      }
    })
  }

  function sendPrompt(text: string) {
    const prompt = text.trim()
    const runtimeAvailable =
      state.runtime.backend === "running" && state.runtime.model === "loaded"

    if (!prompt || state.streaming || !runtimeAvailable) return

    const turnId = nextMessageId.current
    nextMessageId.current += 1
    const userMessageId = `turn-${turnId}-user`
    const replyMessageId = `turn-${turnId}-lys`

    dispatch({
      type: "messageAdded",
      message: { id: userMessageId, role: "user", text: prompt }
    })
    dispatch({ type: "replyStarted", messageId: replyMessageId })
    dispatch({ type: "draftChanged", draft: "" })

    const controller = createTextSimulation({
      text: replyForPrompt(prompt),
      chunkSize: 8,
      intervalMs: 30,
      onChunk: (chunk) => {
        dispatch({
          type: "replyChunkReceived",
          messageId: replyMessageId,
          text: chunk
        })
      },
      onComplete: () => {
        if (textSimulationRef.current === controller) {
          textSimulationRef.current = undefined
        }
        dispatch({ type: "replyCompleted", messageId: replyMessageId })
      }
    })

    textSimulationRef.current = controller
  }

  function stopReply() {
    cancelTextSimulation()
    dispatch({ type: "replyStopped" })
  }

  function retryLastError() {
    const preservedDraft = state.draft
    cancelTextSimulation()
    dispatch({ type: "errorsCleared" })
    sendPrompt(preservedDraft)
  }

  function newChat() {
    cancelTextSimulation()
    nextMessageId.current = 1
    dispatch({ type: "newChat" })
  }

  function openModelSettings() {
    dispatch({ type: "viewChanged", view: "settings" })
    dispatch({ type: "paneChanged", pane: "runtime" })
  }

  function startBackend() {
    if (state.runtime.backend !== "stopped") return

    cancelBackendSimulation()
    dispatch({ type: "backendStartRequested" })
    addRuntimeLog("backend start requested", "wait")

    const controller = createOneShotInterval(1500, () => {
      if (backendSimulationRef.current !== controller) return

      backendSimulationRef.current = undefined
      const startedAt = Date.now()
      dispatch({ type: "backendStarted", startedAt })
      addRuntimeLog("backend running", "ok", startedAt)
    })
    backendSimulationRef.current = controller
  }

  function stopBackend() {
    if (state.runtime.backend !== "running") return

    cancelBackendSimulation()
    cancelModelSimulation()
    cancelTextSimulation()
    dispatch({ type: "replyStopped" })
    dispatch({ type: "backendStopRequested" })
    addRuntimeLog("backend stop requested", "wait")

    const controller = createOneShotInterval(900, () => {
      if (backendSimulationRef.current !== controller) return

      backendSimulationRef.current = undefined
      const stoppedAt = Date.now()
      dispatch({ type: "backendStopped" })
      addRuntimeLog("backend stopped; model released", "warn", stoppedAt)
    })
    backendSimulationRef.current = controller
  }

  function loadModel() {
    if (state.runtime.backend !== "running" || state.runtime.model !== "none") {
      return
    }

    cancelModelSimulation()
    dispatch({ type: "modelLoadStarted" })
    addRuntimeLog(`loading ${state.config.model}`, "wait")

    const controller = createProgressSimulation({
      intervalMs: 110,
      step: 10,
      onProgress: (progress) =>
        dispatch({ type: "modelLoadProgressed", progress }),
      onComplete: () => {
        if (modelSimulationRef.current !== controller) return

        modelSimulationRef.current = undefined
        const loadedAt = Date.now()
        dispatch({ type: "modelLoaded" })
        addRuntimeLog(`${state.config.model} loaded`, "ok", loadedAt)
      }
    })
    modelSimulationRef.current = controller
  }

  function unloadModel() {
    if (
      state.runtime.backend !== "running" ||
      state.runtime.model !== "loaded"
    ) {
      return
    }

    cancelModelSimulation()
    stopReply()
    dispatch({ type: "modelUnloadStarted" })
    addRuntimeLog(`releasing ${state.config.model}`, "wait")

    const controller = createOneShotInterval(700, () => {
      if (modelSimulationRef.current !== controller) return

      modelSimulationRef.current = undefined
      const unloadedAt = Date.now()
      dispatch({ type: "modelUnloaded" })
      addRuntimeLog("model released", "ok", unloadedAt)
    })
    modelSimulationRef.current = controller
  }

  function selectModel(model: string) {
    if (model === state.config.model) return

    cancelModelSimulation()
    stopReply()
    dispatch({ type: "modelSelected", model })
    addRuntimeLog(`${model} selected; prior model released`, "wait")
  }

  return (
    <div className="app-shell">
      <TitleBar />

      {state.view === "chat" ? (
        <main className="app-shell__chat">
          <ChatView
            atBottom={state.atBottom}
            messages={state.messages}
            onRetry={retryLastError}
            onScrollPositionChange={(atBottom) =>
              dispatch({ type: "scrollPositionChanged", atBottom })
            }
            onSend={sendPrompt}
            onStop={stopReply}
            streaming={state.streaming}
          />
          <Composer
            config={state.config}
            draft={state.draft}
            messageCount={state.messages.length}
            onDraftChange={(draft) => dispatch({ type: "draftChanged", draft })}
            onNewChat={newChat}
            onOpenModelSettings={openModelSettings}
            onSend={() => sendPrompt(state.draft)}
            onStop={stopReply}
            runtime={state.runtime}
            streaming={state.streaming}
          />
        </main>
      ) : (
        <SettingsView
          onDone={() => dispatch({ type: "viewChanged", view: "chat" })}
        />
      )}
    </div>
  )
}

export default App
