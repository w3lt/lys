import { lazy, useEffect, useReducer } from "react"

import { appReducer, createInitialState } from "@/app/state"

import { TitleBar } from "@/components/TitleBar"

import "./App.scss"
import { useLysPersonalityRefresh } from "./lib/hooks/lysPersonality"
import { useLysStore } from "./lib/store"

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

/**
 * Composes the initialized desktop shell and switches between its main views.
 *
 * @remarks The application store owns
 * initialization, the active view, and the period of Lys's personality; the
 * reducer owns chat scroll state. The component renders intentionally blank
 * while initialization is pending, then renders the title bar and one lazily
 * loaded child view. The shell carries the current side as its
 * `data-lys-personality` attribute (`dark` or `light`), which selects Lys's
 * portraits; the title bar receives the period to derive the theme. While the
 * component is mounted, the period is refreshed from the desktop host every
 * minute. The initialization promise is detached from the effect, so a
 * rejected initialization is unhandled by this component. Only a failed
 * personality or settings read leaves the store in its blank initializing
 * state; a rejected backend start or status check happens after the shell is
 * shown. The lazy children have no local `Suspense` loading fallback or import
 * failure boundary here.
 * @returns The initialized application shell, or `null` while initialization is pending.
 */
export default function App() {
  const initialize = useLysStore((state) => state.initialize)
  const initializing = useLysStore((state) => state.initializing)
  const lysPersonalityPeriod = useLysStore(
    (state) => state.lysPersonalityPeriod
  )
  useLysPersonalityRefresh()
  useEffect(() => {
    void initialize()
  }, [initialize])

  const { activeView, setActiveView } = useLysStore((state) => state)

  const [state, dispatch] = useReducer(
    appReducer,
    undefined,
    createInitialState
  )

  if (initializing || lysPersonalityPeriod === undefined) return null
  return (
    <div
      className="app-shell"
      data-lys-personality={lysPersonalityPeriod.personality}
    >
      <TitleBar lysPersonalityPeriod={lysPersonalityPeriod} />

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
