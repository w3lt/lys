import { lazy, Suspense, useState } from "react"

import type { SettingsPane } from "@/app/types"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import "./SettingsView.scss"
import SettingsPaneFrame from "@/components/SettingsViewComponents/SettingsPaneFrame"

/**
 * Lazily loads the runtime settings body; the parent supplies its fallback.
 *
 * @remarks Primary category: framework boundary. React owns module loading and
 * suspension while the settings view owns the pane selection and fallback.
 */
const RuntimePaneContent = lazy(
  () => import("@/components/SettingsViewComponents/RuntimePaneContent")
)
/**
 * Lazily loads the model settings body; the parent supplies its fallback.
 *
 * @remarks Primary category: framework boundary. React owns module loading and
 * suspension while the settings view owns the pane selection and fallback.
 */
const ModelPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/ModelPaneContent")
)
/**
 * Lazily loads the generation settings body; the parent supplies the fallback.
 *
 * @remarks Primary category: framework boundary. React owns module loading and
 * suspension while the settings view owns the pane selection and fallback.
 */
const GenerationPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/GenerationPaneContent")
)
/**
 * Lazily loads the conversation settings body; the parent supplies its fallback.
 *
 * @remarks Primary category: framework boundary. React owns module loading and
 * suspension while the settings view owns the pane selection and fallback.
 */
const ConversationPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/ConversationPaneContent")
)

/** A no-props settings body that may suspend while its module is imported. */
type SettingsPaneContentComponent =
  | typeof RuntimePaneContent
  | typeof ModelPaneContent
  | typeof GenerationPaneContent
  | typeof ConversationPaneContent

/** Metadata and lazy body used to render one settings pane. */
export type SettingsPaneProps = {
  /** Closed pane value used by tabs and skeleton selection. */
  value: SettingsPane
  /** Visible label for the pane tab and heading. */
  label: string
  /** Short category label shown above the pane heading. */
  eyebrow: string
  /** Supporting note shown below the pane heading. */
  note: string
  /** No-props body component rendered inside the pane frame. */
  contentComponent: SettingsPaneContentComponent
}

/** Authoritative metadata and lazy body registry for the four settings panes. */
const SETTINGS_PANES: ReadonlyArray<SettingsPaneProps> = [
  {
    value: "runtime",
    label: "Runtime",
    eyebrow: "local process",
    note: "The backend and model below are deterministic local simulations.",
    contentComponent: RuntimePaneContent
  },
  {
    value: "model",
    label: "Model",
    eyebrow: "local endpoint",
    note: "Choose the server and weights Lys will use for the next request.",
    contentComponent: ModelPaneContent
  },
  {
    value: "generation",
    label: "Generation",
    eyebrow: "token policy",
    note: "These values are applied to the next simulated request.",
    contentComponent: GenerationPaneContent
  },
  {
    value: "conversation",
    label: "Conversation",
    eyebrow: "conversation policy",
    note: "Decide what survives when the context window fills.",
    contentComponent: ConversationPaneContent
  }
]

/** Properties accepted by {@link SettingsView}. */
type SettingsViewProps = {
  /** Called when the user completes the settings view and requests return to chat. */
  onDone: () => void
}

/**
 * Composes the vertical settings navigation and the selected pane bodies.
 *
 * @remarks Primary category: composition/view. The component owns the current
 * pane selection locally and receives the completion action from its parent.
 * Each pane body is a stable lazy component behind a `Suspense` fallback; lazy
 * import failures propagate because no error boundary is declared here. A
 * pending body renders a separate busy `SettingsPaneFrame`, keeping its
 * heading and Done footer visually available without retaining the non-busy
 * frame's child instances or local state. Model, Generation, and Conversation
 * bodies consume `SettingsContext` and throw when its provider is absent;
 * Runtime instead uses the separate Zustand-backed runtime-settings hook and
 * does not require that provider. This view currently provides no
 * `SettingsContext.Provider`.
 * The view renders a semantic `main` landmark with vertical tabs and does not
 * itself persist settings or own backend state.
 *
 * @param props - Parent-owned completion callback for leaving settings.
 * @returns The settings landmark, tabs, and pane frames.
 */
export default function SettingsView({ onDone }: SettingsViewProps) {
  const [currentPane, setCurrentPane] = useState<SettingsPane>("runtime")

  return (
    <main aria-label="Settings" className="settings-view">
      <Tabs
        className="settings-view__tabs"
        onValueChange={(value) => setCurrentPane(value)}
        orientation="vertical"
        value={currentPane}
      >
        <TabsList
          aria-label="Settings sections"
          className="settings-view__rail"
          variant="line"
        >
          <div className="settings-view__rail-heading">
            <span>Settings</span>
            <small>local session</small>
          </div>
          {SETTINGS_PANES.map((pane) => (
            <TabsTrigger
              className="settings-view__rail-tab"
              key={pane.value}
              value={pane.value}
            >
              {pane.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="settings-view__content">
          {SETTINGS_PANES.map((pane) => {
            return (
              <TabsContent value={pane.value} key={pane.value}>
                <Suspense
                  fallback={
                    <SettingsPaneFrame busy onDone={onDone} pane={pane} />
                  }
                >
                  <SettingsPaneFrame onDone={onDone} pane={pane} />
                </Suspense>
              </TabsContent>
            )
          })}
        </div>
      </Tabs>
    </main>
  )
}
