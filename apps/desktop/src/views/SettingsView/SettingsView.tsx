import { lazy } from "react"

import type { SettingsPane } from "@/app/types"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import "./SettingsView.css"
import PaneFooter from "@/components/SettingsViewComponents/PaneFooter"
import PaneHeading from "@/components/SettingsViewComponents/PaneHeading"
import {
  SettingsContext,
  SettingsContextValue
} from "@/components/SettingsViewComponents/SettingsContext"

const RuntimePaneContent = lazy(
  () => import("@/components/SettingsViewComponents/RuntimePaneContent")
)
const ModelPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/ModelPaneContent")
)
const GenerationPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/GenerationPaneContent")
)
const ConversationPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/ConversationPaneContent")
)

type SettingsPaneValue = "runtime" | "model" | "generation" | "conversation"

type SettingsPaneContentComponent =
  | typeof RuntimePaneContent
  | typeof ModelPaneContent
  | typeof GenerationPaneContent
  | typeof ConversationPaneContent

type SettingsPaneProps = {
  value: SettingsPaneValue
  label: string
  eyebrow: string
  note: string
  contentComponent: SettingsPaneContentComponent
}

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

interface SettingsViewProps extends SettingsContextValue {
  onDone: () => void
  onPaneChange: (pane: SettingsPane) => void
}

export function SettingsView({
  state,
  onAutostartToggle,
  onConfigChange,
  onDone,
  onLoadModel,
  onPaneChange,
  onSelectModel,
  onStartBackend,
  onStopBackend,
  onUnloadModel
}: SettingsViewProps) {
  return (
    <SettingsContext.Provider
      value={{
        state,
        onAutostartToggle,
        onConfigChange,
        onLoadModel,
        onSelectModel,
        onStartBackend,
        onStopBackend,
        onUnloadModel
      }}
    >
      <main aria-label="Settings" className="settings-view">
        <Tabs
          className="settings-view__tabs"
          onValueChange={(value) => onPaneChange(value as SettingsPane)}
          orientation="vertical"
          value={state.pane}
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
              const ContentComponent = pane.contentComponent

              return (
                <TabsContent value={pane.value} key={pane.value}>
                  <div className="settings-view__pane">
                    <PaneHeading
                      eyebrow={pane.eyebrow}
                      note={pane.note}
                      title={pane.label}
                    />

                    <ContentComponent />

                    <PaneFooter onDone={onDone} />
                  </div>
                </TabsContent>
              )
            })}
          </div>
        </Tabs>
      </main>
    </SettingsContext.Provider>
  )
}
