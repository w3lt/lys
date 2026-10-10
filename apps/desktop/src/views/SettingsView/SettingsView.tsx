import { lazy, Suspense, useMemo, useEffect, type ReactElement } from "react"

import type { SettingsPane } from "@/app/types"
import SettingsViewLeftBar, {
  type SettingsRailItem
} from "@/components/SettingsViewComponents/LeftBar"
import {
  SettingsContext,
  type SettingsContextValue
} from "@/components/SettingsViewComponents/SettingsContext"
import SettingsPaneFrame from "@/components/SettingsViewComponents/SettingsPaneFrame"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import {
  buildLoadConfigurationSettings,
  type ModelLoadConfigurationChange
} from "@/lib/models/model-load-configuration"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"
import type { LysSettings } from "@/lib/store/settings"

import "./SettingsView.scss"

/**
 * Lazily loads the runtime settings body; the parent supplies its fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const RuntimePaneContent = lazy(
  () => import("@/components/SettingsViewComponents/RuntimePaneContent")
)
/**
 * Lazily loads the model settings body; the parent supplies its fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const ModelPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/ModelPaneContent")
)
/**
 * Lazily loads the generation settings body; the parent supplies the fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const GenerationPaneContent = lazy(
  () => import("@/components/SettingsViewComponents/GenerationPaneContent")
)
/**
 * Lazily loads the agent settings body; the parent supplies the fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const AgentPane = lazy(
  () => import("@/components/SettingsViewComponents/AgentPaneContent")
)

/**
 * Lazily loads the tools settings body; the parent supplies the fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const ToolPane = lazy(
  () => import("@/components/SettingsViewComponents/ToolPaneContent")
)

/** A no-props settings body that may suspend while its module is imported. */
type SettingsPaneContentComponent =
  | typeof RuntimePaneContent
  | typeof ModelPaneContent
  | typeof GenerationPaneContent
  | typeof AgentPane
  | typeof ToolPane

/** Metadata and lazy body used to render one settings pane. */
export type SettingsPaneDescriptor = {
  /** Closed pane value used by the rail, tabs, and skeleton selection. */
  readonly value: SettingsPane
  /** Visible label for the rail entry and the pane heading. */
  readonly label: string
  /** Two-digit ordinal shown at the end of the rail entry. */
  readonly ordinal: string
  /** Supporting note shown below the pane heading. */
  readonly note: string
  /** Closing note explaining what the pane's settings affect. */
  readonly footNote: string
  /** No-props body component rendered inside the pane frame. */
  readonly contentComponent: SettingsPaneContentComponent
}

/** Authoritative metadata and lazy body registry for the settings panes. */
const SETTINGS_PANES: readonly SettingsPaneDescriptor[] = [
  {
    value: "runtime",
    label: "Runtime",
    ordinal: "01",
    note: "Start the server, then load the weights. Nothing runs until you say so.",
    footNote:
      "Starting launches the Lys backend, which then connects to LM Studio. Lys doesn't start LM Studio for you; model weights are managed by LM Studio, and stopping the backend does not unload them.",
    contentComponent: RuntimePaneContent
  },
  {
    value: "model",
    label: "Model",
    ordinal: "02",
    note: "Every model on disk, which one is default, and what it is loaded with.",
    footNote:
      "Model operations use the backend. A load configuration is saved for each model and applies when that model is loaded, not per request. The composer's context meter uses its own estimate, not the context length set here. Default selection lasts for this session.",
    contentComponent: ModelPaneContent
  },
  {
    value: "generation",
    label: "Generation",
    ordinal: "03",
    note: "How far she wanders, and when she has to stop.",
    footNote:
      "Saved automatically for future messages, including after restarting Lys. Messages already sent are unchanged.",
    contentComponent: GenerationPaneContent
  },
  {
    value: "agents",
    label: "Agents",
    ordinal: "04",
    note: "Who she is before you say anything. A name, a line for you, and the system prompt the model is given.",
    footNote:
      "Saved by the backend in Lys's database. Conversations do not use agents yet; editing one changes no chat.",
    contentComponent: AgentPane
  },
  {
    value: "tools",
    label: "Tools",
    ordinal: "05",
    note: "What the agents can reach for. Every tool that is on is described to the model with each request, so off is cheaper than unused.",
    footNote:
      "Tools come from Lys itself and cannot be added or removed here. Nothing here is saved yet, and conversations do not use tools yet.",
    contentComponent: ToolPane
  }
]

/** Rail entries derived once from the pane registry. */
const SETTINGS_RAIL_ITEMS: readonly SettingsRailItem[] = SETTINGS_PANES.map(
  ({ value, label, ordinal }) => ({ value, label, ordinal })
)

/**
 * Formats the rail summary for a backend that is not running.
 *
 * @param backendStatus - Store-owned backend lifecycle state other than `running`.
 * @returns The backend state, matching the Runtime pane's backend card.
 */
function formatRailBackendStatus(
  backendStatus: Exclude<BackendServerStatus, "running">
): string {
  switch (backendStatus) {
    case "stopped":
      return "backend stopped"
    case "starting":
      return "backend starting"
    case "stopping":
      return "backend stopping"
    case "unresponsive":
      return "backend not responding"
  }
}

/**
 * Formats the rail summary for a running backend without a connected LM Studio.
 *
 * @param lmStudioStatus - Latest published LM Studio status other than `connected`.
 * @returns The LM Studio state, matching the Runtime pane's LM Studio card.
 */
function formatRailLmStudioStatus(
  lmStudioStatus: Exclude<LmStudioStatus, "connected">
): string {
  switch (lmStudioStatus) {
    case "unknown":
      return "backend up · LM Studio status unknown"
    case "connecting":
      return "backend up · connecting to LM Studio"
    case "unreachable":
      return "backend up · LM Studio not reachable"
  }
}

/**
 * Formats the one-line runtime summary shown under the settings rail.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param lmStudioStatus - Latest published LM Studio status.
 * @param modelRuntime - Current weight residency state.
 * @returns The rail's summary of the first missing prerequisite—the backend,
 * then LM Studio—or of the weights once both are available.
 */
function formatRailStatus(
  backendStatus: BackendServerStatus,
  lmStudioStatus: LmStudioStatus,
  modelRuntime: ModelRuntimeState
): string {
  if (backendStatus !== "running") return formatRailBackendStatus(backendStatus)
  if (lmStudioStatus !== "connected") {
    return formatRailLmStudioStatus(lmStudioStatus)
  }

  switch (modelRuntime.status) {
    case "loaded":
      return "backend up · model loaded"
    case "loading":
      return "backend up · loading weights"
    case "unloading":
      return "backend up · releasing weights"
    case "none":
      return "backend up · no model"
    case "unknown":
      return "backend up · model state unavailable"
  }
}

/**
 * Builds the settings after one change to a model's own load settings.
 *
 * @param settings - Current settings; they are not modified.
 * @param change - Model and settings to assign, or the expert count to remove.
 * @returns Newly owned settings whose load configuration has the change
 * applied. Every other group is the value it was before.
 */
function buildSettingsWithLoadConfigurationChange(
  settings: LysSettings,
  change: ModelLoadConfigurationChange
): LysSettings {
  const loadConfiguration = buildLoadConfigurationSettings(
    settings.loadConfiguration,
    change
  )
  return { ...settings, loadConfiguration }
}

/** Properties accepted by {@link SettingsView}. */
export type SettingsViewProps = {
  /** Called when the user completes settings and requests a return to chat. */
  readonly onDone: () => void
}

/**
 * Composes the settings rail, the selected pane, and its settings authority.
 *
 * @remarks The application store owns the
 * selected pane and the settings value; this view provides `SettingsContext` so
 * the runtime, model, and generation panes read one authority and propose
 * patches back through it. Patches
 * apply in memory immediately. Generation and load configuration edits are
 * saved automatically; runtime and model edits remain session-only.
 *
 * Inventory, load, unload, reload, and health requests belong to the application store.
 * Entering settings refreshes inventory; leaving the view does not cancel work.
 * Request errors and loaded-state health observations are rendered by the panes.
 * Agents are managed through the agent store, which the Agents pane reads
 * directly rather than through `SettingsContext`; its prompt measure reads the
 * context-window estimate from the application store, and it proposes no
 * settings patch. The Tools pane likewise reads the tool store directly; it
 * lists the tools the desktop and the backend report, and its choices are
 * mocked for the session and never saved.
 *
 * Each pane body is a stable lazy component behind a `Suspense` fallback; a
 * pending body renders a separate busy frame, so its heading and Done action
 * stay available without retaining the ready frame's child instances. Lazy
 * import failures propagate, as no error boundary is declared here.
 *
 * @param props - Parent-owned completion callback for leaving settings.
 * @returns The settings landmark, its rail, and the selected pane.
 */
export default function SettingsView({
  onDone
}: SettingsViewProps): ReactElement {
  const currentPane = useLysStore((state) => state.settingsPane)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const settings = useLysStore((state) => state.settings)
  const setSettings = useLysStore((state) => state.setSettings)
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const lmStudioStatus = useLysStore((state) => state.lmStudioStatus)
  const modelRuntime = useLysStore((state) => state.modelRuntime)
  const loadModel = useLysStore((state) => state.loadModel)
  const unloadModel = useLysStore((state) => state.unloadModel)
  const modelInventory = useLysStore((state) => state.modelInventory)
  const modelRequest = useLysStore((state) => state.modelRequest)
  const modelError = useLysStore((state) => state.modelError)
  const modelHealth = useLysStore((state) => state.modelHealth)
  const loadedModelConfigurations = useLysStore(
    (state) => state.loadedModelConfigurations
  )
  const updateLoadedModelConfiguration = useLysStore(
    (state) => state.updateLoadedModelConfiguration
  )
  const testModel = useLysStore((state) => state.testModel)
  const updateModelInventory = useLysStore(
    (state) => state.updateModelInventory
  )

  useEffect(() => {
    if (backendStatus === "running") void updateModelInventory()
  }, [backendStatus, updateModelInventory])

  const contextValue = useMemo<SettingsContextValue>(
    () => ({
      settings,
      modelRuntime,
      modelInventory,
      modelRequest,
      modelError,
      modelHealth,
      loadedModelConfigurations,
      onRuntimeChange: (patch) =>
        setSettings({
          ...settings,
          runtime: { ...settings.runtime, ...patch }
        }),
      onModelChange: (patch) =>
        setSettings({ ...settings, model: { ...settings.model, ...patch } }),
      onGenerationChange: (patch) =>
        setSettings({
          ...settings,
          generation: { ...settings.generation, ...patch }
        }),
      onAssignModelLoadSettings: (modelKey, assignedSettings) => {
        const change: ModelLoadConfigurationChange = {
          kind: "assignment",
          modelKey,
          settings: assignedSettings
        }
        setSettings(buildSettingsWithLoadConfigurationChange(settings, change))
      },
      onRemoveModelExpertCount: (modelKey) => {
        const change: ModelLoadConfigurationChange = {
          kind: "expert-count-removal",
          modelKey
        }
        setSettings(buildSettingsWithLoadConfigurationChange(settings, change))
      },
      onLoadModel: loadModel,
      onUnloadModel: unloadModel,
      onReloadModel: updateLoadedModelConfiguration,
      onTestModel: testModel,
      onRefreshModels: updateModelInventory
    }),
    [
      settings,
      modelRuntime,
      modelInventory,
      modelRequest,
      modelError,
      modelHealth,
      loadedModelConfigurations,
      setSettings,
      loadModel,
      unloadModel,
      updateLoadedModelConfiguration,
      testModel,
      updateModelInventory
    ]
  )

  const railStatus = formatRailStatus(
    backendStatus,
    lmStudioStatus,
    modelRuntime
  )

  return (
    <main aria-label="Settings" className="settings-view">
      <SettingsContext value={contextValue}>
        <Tabs
          className="settings-view__tabs"
          onValueChange={(value) => {
            const pane = SETTINGS_PANES.find((entry) => entry.value === value)
            if (pane) setSettingsPane(pane.value)
          }}
          orientation="vertical"
          value={currentPane}
        >
          <SettingsViewLeftBar
            items={SETTINGS_RAIL_ITEMS}
            status={railStatus}
          />

          <div className="settings-view__content">
            {SETTINGS_PANES.map((pane) => (
              <TabsContent key={pane.value} value={pane.value}>
                <Suspense
                  fallback={
                    <SettingsPaneFrame busy onDone={onDone} pane={pane} />
                  }
                >
                  <SettingsPaneFrame onDone={onDone} pane={pane} />
                </Suspense>
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </SettingsContext>
    </main>
  )
}
