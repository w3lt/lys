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
  LLM_PROVIDER_NAMES,
  LLM_PROVIDERS,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import {
  useNewConversationModel,
  type ShownModelState
} from "@/lib/hooks/conversationModel"
import {
  buildLoadConfigurationSettings,
  type ModelLoadConfigurationChange
} from "@/lib/models/model-load-configuration"
import {
  calculateProviderAvailability,
  type ProviderAvailability
} from "@/lib/models/provider-connection"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import type { ProviderModelState } from "@/lib/store/model-runtime"
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

/**
 * Lazily loads the MCP settings body; the parent supplies the fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const McpPane = lazy(
  () => import("@/components/SettingsViewComponents/McpPaneContent")
)

/**
 * Lazily loads the providers settings body; the parent supplies the fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const ProvidersPane = lazy(
  () => import("@/components/SettingsViewComponents/ProvidersPaneContent")
)

/**
 * Lazily loads the secrets settings body; the parent supplies the fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const SecretsPane = lazy(
  () => import("@/components/SettingsViewComponents/SecretsPaneContent")
)

/** A no-props settings body that may suspend while its module is imported. */
type SettingsPaneContentComponent =
  | typeof RuntimePaneContent
  | typeof ModelPaneContent
  | typeof GenerationPaneContent
  | typeof AgentPane
  | typeof ToolPane
  | typeof McpPane
  | typeof ProvidersPane
  | typeof SecretsPane

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
      "Starting launches the Lys backend, which then connects to every provider turned on in Providers. Lys doesn't start a provider for you, and stopping the backend does not unload their models.",
    contentComponent: RuntimePaneContent
  },
  {
    value: "model",
    label: "Models",
    ordinal: "02",
    note: "Choose a provider, then a model. Cloud models answer right away; a local model answers only once it is loaded on this machine.",
    footNote:
      "Model operations use the backend. Load settings are saved for each LM Studio model and apply when that model is loaded, not per message. The composer's context meter and the Agents pane measure against the context length the model is loaded with. The default lasts for this session.",
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
      "Saved by the backend in Lys's database. Editing an agent changes its conversations from their next message.",
    contentComponent: AgentPane
  },
  {
    value: "tools",
    label: "Tools",
    ordinal: "05",
    note: "What the agents can reach for. Every tool that is on is described to the model with each request, so off is cheaper than unused.",
    footNote:
      "Lys's own tools cannot be added or removed here; MCP servers add theirs in Settings → MCP. Each tool's switch and Just run choice are saved; the Tool calls switch resets when Lys restarts.",
    contentComponent: ToolPane
  },
  {
    value: "mcp",
    label: "MCP",
    ordinal: "06",
    note: "Programs and services that give the agents more tools. Local ones Lys starts on this machine; remote ones it reaches by URL. Each runs as you, so add only servers you trust.",
    footNote:
      "Saved in settings.json in Lys's home folder, environment values, tokens, and headers in plain text, readable only by your user account. A command runs as you in your home folder, with a short PATH: use its full path, such as /opt/homebrew/bin/npx.",
    contentComponent: McpPane
  },
  {
    value: "providers",
    label: "Providers",
    ordinal: "07",
    note: "Where messages are answered. Several can be on at once; each conversation's model names its provider.",
    footNote:
      "Saved in settings.json in Lys's home folder, readable only by your user account; keys are kept in plain text there and go only to their own provider. LM Studio and a local Ollama server keep conversations on the machine at the address you give, over plain HTTP. Ollama Cloud and Groq receive your conversations to answer them.",
    contentComponent: ProvidersPane
  },
  {
    value: "secrets",
    label: "Secrets",
    ordinal: "08",
    note: "Keys for the services Lys calls on your behalf. Each key goes only to its own service and is never sent to the model.",
    footNote:
      "Saved in plain text in settings.json in Lys's home folder, readable only by your user account. Lys's backend reads it when it lists tools and when a message offers web_search; a reply keeps the key it started with.",
    contentComponent: SecretsPane
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
 * Formats the rail summary for a running backend from one provider's state.
 *
 * @param availability - Whether model requests can reach the provider.
 * @param providerName - Name of the provider.
 * @returns The provider state, matching the Runtime pane's provider card, or
 * that no model is loaded once the provider can be reached. A backend
 * offline, which the caller rules out first, reads as unavailable.
 */
function formatRailProviderStatus(
  availability: ProviderAvailability,
  providerName: string
): string {
  switch (availability) {
    case "provider-off":
      return `backend up · ${providerName} is off`
    case "provider-connecting":
      return `backend up · connecting to ${providerName}`
    case "provider-unreachable":
      return `backend up · ${providerName} not reachable`
    case "available":
      return "backend up · no model"
    case "backend-offline":
      return "backend up · model state unavailable"
  }
}

/** What the one-line runtime summary under the settings rail describes. */
type RailStatusSource = {
  /** Store-owned backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** The model a new conversation uses, with its availability. */
  readonly shownModel: ShownModelState
  /**
   * Provider the panes show, which the summary describes while there is no
   * model.
   */
  readonly shownProvider: LlmProvider
  /** Whether model requests can reach that provider. */
  readonly providerAvailability: ProviderAvailability
}

/**
 * Formats the one-line runtime summary shown under the settings rail.
 *
 * @param source - The backend's state, the model a new conversation uses,
 * and the provider the panes show with whether model requests reach it.
 * @returns The rail's summary of the first missing prerequisite—the backend,
 * then the model's provider—or of the model's weights once both are
 * available.
 */
function formatRailStatus({
  backendStatus,
  shownModel,
  shownProvider,
  providerAvailability
}: RailStatusSource): string {
  if (backendStatus !== "running") return formatRailBackendStatus(backendStatus)
  if (shownModel.model === null || shownModel.availability === null) {
    return formatRailProviderStatus(
      providerAvailability,
      LLM_PROVIDER_NAMES[shownProvider]
    )
  }

  const providerName = LLM_PROVIDER_NAMES[shownModel.model.provider]
  switch (shownModel.availability.status) {
    case "loaded":
      return "backend up · model loaded"
    case "loading":
      return "backend up · loading weights"
    case "unloading":
      return "backend up · releasing weights"
    case "not-loaded":
      return "backend up · no model"
    case "not-listed":
      return "backend up · model not listed"
    case "provider-off":
      return formatRailProviderStatus("provider-off", providerName)
    case "provider-connecting":
      return formatRailProviderStatus("provider-connecting", providerName)
    case "provider-unreachable":
      return formatRailProviderStatus("provider-unreachable", providerName)
    case "backend-not-running":
    case "inventory-unread":
    case "inventory-failed":
      return "backend up · model state unavailable"
  }
}

/**
 * Finds the provider whose requests the Runtime pane reports and the rail
 * summary describes.
 *
 * @param settings - Current settings.
 * @param newConversationModel - The model a new conversation uses, or null
 * when there is none.
 * @returns That model's provider while it is on, else the first provider
 * that is on, in provider order, else LM Studio.
 */
function findShownProvider(
  settings: LysSettings,
  newConversationModel: LlmModelReference | null
): LlmProvider {
  const { enabled } = settings.providers
  const modelProvider = newConversationModel?.provider
  if (modelProvider !== undefined && enabled.includes(modelProvider)) {
    return modelProvider
  }
  return (
    LLM_PROVIDERS.find((provider) => enabled.includes(provider)) ?? "lmStudio"
  )
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

/**
 * Reads every provider's model inventory again while the backend runs.
 *
 * @param backendStatus - Store-owned backend lifecycle state; nothing is
 * read unless it is `running`.
 * @param updateModelInventory - The application store's inventory read of
 * one provider, which keeps its own outcome in that provider's state; each
 * read is started without waiting for the others.
 */
function updateModelInventoriesWhileRunning(
  backendStatus: BackendServerStatus,
  updateModelInventory: (provider: LlmProvider) => Promise<void>
): void {
  if (backendStatus !== "running") return
  for (const provider of LLM_PROVIDERS) void updateModelInventory(provider)
}

/** What the settings view builds its context value from. */
type SettingsContextSource = {
  /** Current settings, which every change request patches. */
  readonly settings: LysSettings
  /**
   * Model state of the provider whose request, failure, and health the
   * Runtime pane reports, as {@link findShownProvider} finds it.
   */
  readonly shownProviderModels: ProviderModelState
  /** The model a new conversation uses, with whether it can answer. */
  readonly newConversationModel: ShownModelState
  /** Replaces the store-owned settings, which applies them at once. */
  readonly setSettings: (settings: LysSettings) => void
}

/**
 * Builds the settings context value the panes read and propose changes
 * through.
 *
 * @param source - Current settings, the shown provider's model state, the
 * model a new conversation uses, and the store's settings setter.
 * @returns The settings, the shown provider's request, failure, and health,
 * the model a new conversation uses, and change requests that each apply
 * one change to the current settings through the setter.
 */
function buildSettingsContextValue({
  settings,
  shownProviderModels,
  newConversationModel,
  setSettings
}: SettingsContextSource): SettingsContextValue {
  return {
    settings,
    modelRequest: shownProviderModels.request,
    modelError: shownProviderModels.error,
    modelHealth: shownProviderModels.health,
    newConversationModel,
    onRuntimeChange: (patch) =>
      setSettings({
        ...settings,
        runtime: { ...settings.runtime, ...patch }
      }),
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
    }
  }
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
 * apply in memory immediately. Generation, load configuration, and startup
 * switch edits are saved automatically; other runtime edits remain
 * session-only.
 *
 * Inventory, load, unload, reload, and health requests belong to the
 * application store; the context holds one provider's request, failure, and
 * health, as {@link findShownProvider} finds it, for the Runtime pane's
 * request feedback, while the Runtime and Models panes read every
 * provider's models from the store. Entering settings refreshes every
 * provider's inventory; leaving the view does not cancel work.
 * Request errors and loaded-state health observations are rendered by the panes.
 * Agents are managed through the agent store, which the Agents pane reads
 * directly rather than through `SettingsContext`; its prompt measure reads the
 * context length of the model a new conversation uses, while it is loaded,
 * and it proposes no settings patch. The Tools pane likewise reads the tool store directly; it
 * lists the tools the desktop and the backend report, MCP servers' tools
 * among them. Its tool-calls switch
 * lasts for the session, and each tool's switch and approval are saved by
 * the application store. The MCP pane reads the saved MCP servers from the
 * application store, which saves them, and their states from the MCP server
 * store; it proposes no settings patch.
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
  const providerModels = useLysStore((state) => state.providerModels)
  const updateModelInventory = useLysStore(
    (state) => state.updateModelInventory
  )
  const newConversationModel = useNewConversationModel()
  const shownProvider = findShownProvider(settings, newConversationModel.model)
  const shownProviderModels = providerModels[shownProvider]
  const providerAvailability = calculateProviderAvailability(
    {
      backendStatus,
      enabledProviders: settings.providers.enabled,
      providerModels
    },
    shownProvider
  )

  useEffect(() => {
    updateModelInventoriesWhileRunning(backendStatus, updateModelInventory)
  }, [backendStatus, updateModelInventory])

  const contextValue = useMemo<SettingsContextValue>(
    () =>
      buildSettingsContextValue({
        settings,
        shownProviderModels,
        newConversationModel,
        setSettings
      }),
    [settings, shownProviderModels, newConversationModel, setSettings]
  )

  const railStatus = formatRailStatus({
    backendStatus,
    shownModel: newConversationModel,
    shownProvider,
    providerAvailability
  })

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
