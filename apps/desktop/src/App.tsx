import { lazy, useCallback, useEffect, useReducer } from "react"

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
import { registerActivityFollow } from "./lib/store/activity"
import { registerMcpServerRefresh } from "./lib/store/mcp-servers"
import { registerToolListRefresh } from "./lib/store/tools"
import { startSpeech } from "./lib/speech"

/**
 * Composes the initialized desktop shell and switches between its main views.
 *
 * @remarks The application store owns
 * initialization and the active view; the reducer owns chat scroll state,
 * which the chat view reports through a callback whose identity never
 * changes, so the callbacks the view builds on it keep theirs. The
 * component renders intentionally blank while initialization is pending, then
 * renders the title bar and one lazily loaded child view. While mounted, it
 * keeps the tool list in step with the backend and vmo through
 * {@link registerToolListRefresh}, the MCP server list and the tools its
 * servers add in step with the backend through
 * {@link registerMcpServerRefresh}, and the tool calls and the shown
 * conversation in step with the replies the backend starts itself through
 * {@link registerActivityFollow}, unsubscribing all three on unmount. The
 * initialization promise is detached from the effect, so a rejected
 * initialization is unhandled by this component. Only a failed settings load leaves the store in
 * its blank initializing state; a rejected backend start or status check
 * happens after the shell is shown. The lazy children have no local `Suspense`
 * loading fallback or import failure boundary here.
 * @returns The initialized application shell, or `null` while initialization is pending.
 */
export default function App() {
  const initialize = useLysStore((state) => state.initialize)
  const initializing = useLysStore((state) => state.initializing)
  useEffect(() => {
    void initialize()
  }, [initialize])
  useEffect(() => registerToolListRefresh(), [])
  useEffect(() => registerMcpServerRefresh(), [])
  useEffect(() => registerActivityFollow(), [])
  useEffect(() => startSpeech(), [])

  const { activeView, setActiveView } = useLysStore((state) => state)

  const [state, dispatch] = useReducer(
    appReducer,
    undefined,
    createInitialState
  )
  const handleScrollPositionChange = useCallback(
    (atBottom: boolean) =>
      dispatch({ type: "scrollPositionChanged", atBottom }),
    []
  )

  if (initializing) return null
  return (
    <div className="app-shell">
      <TitleBar />

      {activeView === "chat" ? (
        <ChatView
          atBottom={state.atBottom}
          onScrollPositionChange={handleScrollPositionChange}
        />
      ) : (
        <SettingsView onDone={() => setActiveView("chat")} />
      )}
    </div>
  )
}
