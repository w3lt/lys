import { lazy, useEffect, useReducer } from "react"

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

  if (initializing) return null
  return (
    <div className="app-shell">
      <TitleBar />

      {activeView === "chat" ? (
        <ChatView
          atBottom={state.atBottom}
          onScrollPositionChange={(atBottom) =>
            dispatch({ type: "scrollPositionChanged", atBottom })
          }
        />
      ) : (
        <SettingsView onDone={() => setActiveView("chat")} />
      )}
    </div>
  )
}
