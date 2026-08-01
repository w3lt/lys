import { lazy, useCallback, useEffect, useReducer, useRef } from "react"

import {
  createTextSimulation,
  replyForPrompt,
  type SimulationController
} from "@/app/simulation"
import { appReducer, createInitialState } from "@/app/state"

import { TitleBar } from "@/components/TitleBar"

const ChatView = lazy(() => import("@/views/ChatView/ChatView"))
const SettingsView = lazy(() => import("@/views/SettingsView/SettingsView"))

import "./App.scss"
import { useLysStore } from "./lib/store"

export default function App() {
  const initialize = useLysStore((state) => state.initialize)
  const initializing = useLysStore((state) => state.initializing)
  useEffect(() => {
    void initialize()
  }, [initialize])

  const { activeView, setActiveView } = useLysStore((state) => state)

  const [state, dispatch] = useReducer(
    appReducer,
    undefined,
    createInitialState
  )
  const nextMessageId = useRef(1)
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

  if (initializing) return null
  return (
    <div className="app-shell">
      <TitleBar />

      {activeView === "chat" ? (
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
      ) : (
        <SettingsView onDone={() => setActiveView("chat")} />
      )}
    </div>
  )
}
