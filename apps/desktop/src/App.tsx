import { lazy, useEffect, useReducer } from "react"

import { appReducer, createInitialState } from "@/app/state"

import { TitleBar } from "@/components/TitleBar"

/**
 * Lazy composition boundary for the chat view module.
 *
 * @remarks React owns module loading and
 * suspension; the application shell owns the selected view and any fallback.
 */
const ChatView = lazy(() => import("@/views/ChatView/ChatView"))
/**
 * Lazy composition boundary for the settings view module.
 *
 * @remarks React owns module loading and
 * suspension; the application shell owns the selected view and any fallback.
 */
const SettingsView = lazy(() => import("@/views/SettingsView/SettingsView"))

import "./App.scss"
import { useLysStore } from "./lib/store"

/**
 * Composes the initialized desktop shell and switches between its main views.
 *
 * @remarks The application store owns
 * initialization and the active view; the reducer owns chat scroll state. The
 * component renders intentionally blank while initialization is pending, then
 * renders the title bar and one lazily loaded child view. The initialization
 * promise is detached from the effect, so a rejected initialization is
 * unhandled by this component and leaves the store in its blank initializing
 * state. The lazy children have no local `Suspense` loading fallback or import
 * failure boundary here.
 * @returns The initialized application shell, or `null` while initialization is pending.
 */
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
