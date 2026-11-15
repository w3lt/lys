import {
  LLM_PROVIDERS,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  type ReactElement
} from "react"

import type { SettingsPane } from "@/app/types"
import SettingsViewLeftBar, {
  type SettingsRailItem,
  type SettingsRailMarker,
  type SettingsRailSectionItem
} from "@/components/SettingsViewComponents/LeftBar"
import {
  buildLysEmailRailMarker,
  buildMcpRailMarker,
  formatRailStatus,
  type RailStatus
} from "@/components/SettingsViewComponents/rail-presentation"
import {
  SettingsContext,
  type SettingsContextValue
} from "@/components/SettingsViewComponents/SettingsContext"
import { useEmailMailboxFacts } from "@/components/SettingsViewComponents/email-mailbox-state"
import SettingsPaneFrame from "@/components/SettingsViewComponents/SettingsPaneFrame"
import {
  SettingsSectionsContext,
  type SettingsSection,
  type SettingsSectionsContextValue
} from "@/components/SettingsViewComponents/SettingsSectionsContext"
import {
  useNewConversationModel,
  type ShownModelState
} from "@/lib/hooks/conversationModel"
import {
  buildLoadConfigurationSettings,
  type ModelLoadConfigurationChange
} from "@/lib/models/model-load-configuration"
import { calculateProviderAvailability } from "@/lib/models/provider-connection"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import { useMcpServerStore } from "@/lib/store/mcp-servers"
import type { ProviderModelState } from "@/lib/store/model-runtime"
import type { LysSettings } from "@/lib/store/settings"

import "./SettingsView.scss"

/**
 * Lazily loads the Lys settings body; the parent supplies its fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const LysPane = lazy(
  () => import("@/components/SettingsViewComponents/LysPaneContent")
)
/**
 * Lazily loads the Profile settings body; the parent supplies its fallback.
 *
 * @remarks React owns module loading and
 * suspension while the settings view owns pane selection and the fallback.
 */
const ProfilePane = lazy(
  () => import("@/components/SettingsViewComponents/ProfilePaneContent")
)
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
  | typeof LysPane
  | typeof ProfilePane
  | typeof RuntimePaneContent
  | typeof ModelPaneContent
  | typeof GenerationPaneContent
  | typeof AgentPane
  | typeof ToolPane
  | typeof McpPane
  | typeof ProvidersPane
  | typeof SecretsPane

/**
 * How a pane lays out its body: `panels`, the redesigned panes' wide frame
 * of panel cards, or `sections`, the narrower frame of headed sections the
 * other panes keep.
 */
export type SettingsPaneLayout = "panels" | "sections"

/** One collapsible section of a pane. */
export type SettingsSectionDescriptor = {
  /** The section. */
  readonly value: SettingsSection
  /** Label of its rail entry, or null when the rail does not list it. */
  readonly railLabel: string | null
}

/** Metadata and lazy body used to render one settings pane. */
export type SettingsPaneDescriptor = {
  /** Closed pane value used by the rail and skeleton selection. */
  readonly value: SettingsPane
  /** Visible label for the rail entry and the pane heading. */
  readonly label: string
  /** Two-digit ordinal shown at the end of the rail entry. */
  readonly ordinal: string
  /** Supporting note shown below the pane heading. */
  readonly note: string
  /**
   * Closing note explaining what the pane's settings affect, or null when
   * the frame shows none: the pane closes with a note of its own, as
   * Profile and Tools do, or with none, as Lys and Secrets do.
   */
  readonly footNote: string | null
  /** How the pane lays out its body. */
  readonly layout: SettingsPaneLayout
  /** Collapsible sections of the pane, in order; empty for most panes. */
  readonly sections: readonly SettingsSectionDescriptor[]
  /** No-props body component rendered inside the pane frame. */
  readonly contentComponent: SettingsPaneContentComponent
}

/** Authoritative metadata and lazy body registry for the settings panes. */
const SETTINGS_PANES: readonly SettingsPaneDescriptor[] = [
  {
    value: "lys",
    label: "Lys",
    ordinal: "01",
    note: "Lys's own name and accounts. Agents use them when Lys signs, sends or replies as itself. Your own accounts stay with the servers that use them, under MCP.",
    footNote: null,
    layout: "panels",
    sections: [
      { value: "about-lys", railLabel: "About Lys" },
      { value: "lys-email", railLabel: "Email" }
    ],
    contentComponent: LysPane
  },
  {
    value: "profile",
    label: "Profile",
    ordinal: "02",
    note: "You, as Lys knows you. Everything here stays on this machine and reaches a model only the way each section says.",
    footNote: null,
    layout: "panels",
    sections: [
      { value: "model-view", railLabel: null },
      { value: "about-you", railLabel: "About you" },
      { value: "location", railLabel: "Location" },
      { value: "preferences", railLabel: "Preferences" },
      { value: "notes", railLabel: "Notes for Lys" }
    ],
    contentComponent: ProfilePane
  },
  {
    value: "runtime",
    label: "Runtime",
    ordinal: "03",
    note: "Start the server, then load the weights. Nothing runs until you say so.",
    footNote:
      "Starting launches the Lys backend, which then connects to every provider turned on in Providers. Lys doesn't start a provider for you, and stopping the backend does not unload their models.",
    layout: "sections",
    sections: [],
    contentComponent: RuntimePaneContent
  },
  {
    value: "model",
    label: "Models",
    ordinal: "04",
    note: "Choose a provider, then a model. Cloud models answer right away; a local model answers only once it is loaded on this machine.",
    footNote:
      "Model operations use the backend. Load settings are saved for each LM Studio model and apply when that model is loaded, not per message. The composer's context meter and the Agents pane measure against the context length the model is loaded with. The default lasts for this session.",
    layout: "sections",
    sections: [],
    contentComponent: ModelPaneContent
  },
  {
    value: "generation",
    label: "Generation",
    ordinal: "05",
    note: "How far she wanders, and when she has to stop.",
    footNote:
      "Saved automatically for future messages, including after restarting Lys. Messages already sent are unchanged.",
    layout: "sections",
    sections: [],
    contentComponent: GenerationPaneContent
  },
  {
    value: "agents",
    label: "Agents",
    ordinal: "06",
    note: "Who she is before you say anything. A name, a line for you, and the system prompt the model is given.",
    footNote:
      "Saved by the backend in Lys's database. Editing an agent changes its conversations from their next message.",
    layout: "sections",
    sections: [],
    contentComponent: AgentPane
  },
  {
    value: "tools",
    label: "Tools",
    ordinal: "07",
    note: "Lys's own tools. A request carries the description of a tool that is on once Armitage finds that tool for it; a tool that is off is never offered.",
    footNote: null,
    layout: "panels",
    sections: [],
    contentComponent: ToolPane
  },
  {
    value: "mcp",
    label: "MCP",
    ordinal: "08",
    note: "Programs and services that give the agents more tools. Local ones Lys starts on this machine; remote ones it reaches by URL. Each runs as you, so add only servers you trust.",
    footNote:
      "Saved in settings.json in Lys's home folder, environment values, tokens, and headers in plain text, readable only by your user account. A command runs as you in your home folder, with a short PATH: use its full path, such as /opt/homebrew/bin/npx.",
    layout: "panels",
    sections: [],
    contentComponent: McpPane
  },
  {
    value: "providers",
    label: "Providers",
    ordinal: "09",
    note: "Where messages are answered. Several can be on at once; each conversation's model names its provider.",
    footNote:
      "Saved in settings.json in Lys's home folder, readable only by your user account; keys are kept in plain text there and go only to their own provider. LM Studio and a local Ollama server keep conversations on the machine at the address you give, over plain HTTP. Ollama Cloud and Groq receive your conversations to answer them.",
    layout: "sections",
    sections: [],
    contentComponent: ProvidersPane
  },
  {
    value: "secrets",
    label: "Secrets",
    ordinal: "10",
    note: "Keys for services Lys calls on your behalf that are not set up anywhere else, such as web search. Each goes only to its own service and is never sent to the model.",
    footNote: null,
    layout: "panels",
    sections: [],
    contentComponent: SecretsPane
  }
]

/** Every collapsible section of every pane, each open when Settings opens. */
const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_PANES.flatMap(
  (pane) => pane.sections.map((section) => section.value)
)

/** Open sections, and the section whose disclosure button takes focus. */
type SettingsSectionsState = {
  /** Sections that are open. */
  readonly expandedSections: ReadonlySet<SettingsSection>
  /** Section the rail jumped to, until its button took focus, or null. */
  readonly focusedSection: SettingsSection | null
}

/** One change of the open sections. */
type SettingsSectionsChange =
  | {
      /** Sections were opened or closed. */
      readonly kind: "expanded"
      /** The sections. */
      readonly sections: readonly SettingsSection[]
      /** Whether they are open from now on. */
      readonly isExpanded: boolean
    }
  | {
      /** The rail jumped to a section. */
      readonly kind: "jumped"
      /** The section. */
      readonly section: SettingsSection
    }
  | {
      /** The section the rail jumped to took focus. */
      readonly kind: "focused"
    }

/** Sections when Settings opens: all open, none taking focus. */
const INITIAL_SETTINGS_SECTIONS_STATE: SettingsSectionsState = Object.freeze({
  expandedSections: new Set(SETTINGS_SECTIONS),
  focusedSection: null
})

/**
 * Calculates the open sections after one change.
 *
 * @param state - The sections now.
 * @param change - What happened.
 * @returns After an opening or closing, the sections with those changed;
 * after a jump, the section opened and taking focus; after the focus, no
 * section taking focus.
 */
function calculateSettingsSectionsState(
  state: SettingsSectionsState,
  change: SettingsSectionsChange
): SettingsSectionsState {
  switch (change.kind) {
    case "expanded": {
      const expandedSections = new Set(state.expandedSections)
      for (const section of change.sections) {
        if (change.isExpanded) expandedSections.add(section)
        else expandedSections.delete(section)
      }
      return { ...state, expandedSections }
    }
    case "jumped":
      return {
        expandedSections: new Set([...state.expandedSections, change.section]),
        focusedSection: change.section
      }
    case "focused":
      return { ...state, focusedSection: null }
  }
}

/**
 * Owns which sections are open while the settings view is shown, and which
 * one the rail jumped to.
 *
 * @remarks The state lives as long as the view and starts with every
 * section open; leaving Settings forgets it. The requests are rebuilt on
 * every render.
 * @returns The context value, whose requests open, close, and report the
 * focus of sections, and the rail's request that jumps to one.
 */
function useSettingsSectionsControl(): SettingsSectionsContextValue & {
  /** Opens one section and has its disclosure button take focus. */
  readonly jumpToSection: (section: SettingsSection) => void
} {
  const [state, updateState] = useReducer(
    calculateSettingsSectionsState,
    INITIAL_SETTINGS_SECTIONS_STATE
  )

  return {
    ...state,
    onSectionsExpandedChange: (sections, isExpanded) =>
      updateState({ kind: "expanded", sections, isExpanded }),
    onSectionFocused: () => updateState({ kind: "focused" }),
    jumpToSection: (section) => updateState({ kind: "jumped", section })
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

/** The settings authority the panes read, and the rail's runtime summary. */
type SettingsAuthority = {
  /** The value `SettingsContext` provides. */
  readonly contextValue: SettingsContextValue
  /** The rail's one-line runtime summary and the color of its dot. */
  readonly railStatus: RailStatus
}

/**
 * Reads the settings authority the runtime, model, and generation panes
 * read, and the rail's runtime summary, from the application store.
 *
 * @remarks The application store owns every value and request. The context
 * holds one provider's request, failure, and health, as
 * {@link findShownProvider} finds it, for the Runtime pane's request
 * feedback; its value is memoized on them, so a pane re-renders only when
 * one of them changes. While the backend runs, every provider's inventory
 * is read again when the view appears and when the backend starts.
 * @returns The context value and the rail's summary.
 */
function useSettingsAuthority(): SettingsAuthority {
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
  return { contextValue, railStatus }
}

/**
 * Builds the rail entries of one section.
 *
 * @param section - The section.
 * @param markers - Marker of the MCP entry and of the Lys pane's Email
 * section.
 * @returns The section's entry, or none when the rail does not list it.
 */
function buildSettingsRailSectionItems(
  section: SettingsSectionDescriptor,
  markers: SettingsRailMarkers
): readonly SettingsRailSectionItem[] {
  if (section.railLabel === null) return []
  const marker = section.value === "lys-email" ? markers.lysEmail : null
  return [{ value: section.value, label: section.railLabel, marker }]
}

/**
 * Builds one pane's rail entry.
 *
 * @param pane - The pane.
 * @param markers - Marker of the MCP entry and of the Lys pane's Email
 * section.
 * @returns The entry, with its sections the rail lists.
 */
function buildSettingsRailItem(
  pane: SettingsPaneDescriptor,
  markers: SettingsRailMarkers
): SettingsRailItem {
  const sections = pane.sections.flatMap((section) =>
    buildSettingsRailSectionItems(section, markers)
  )
  return {
    value: pane.value,
    label: pane.label,
    ordinal: pane.ordinal,
    marker: pane.value === "mcp" ? markers.mcp : null,
    sections
  }
}

/** Markers the rail shows beside its entries. */
type SettingsRailMarkers = {
  /** Marker of the MCP entry, or null. */
  readonly mcp: SettingsRailMarker | null
  /** Marker of the Lys pane's Email section. */
  readonly lysEmail: SettingsRailMarker
}

/**
 * Reads the rail's entries from the pane registry, the MCP servers' states,
 * and Lys's mailbox.
 *
 * @remarks The application store owns Lys's account and switch, and the
 * MCP server store the servers' states, which also say whether Lys's
 * mailbox is served; the entries are rebuilt on every render.
 * @returns The entries in display order.
 */
function useSettingsRailItems(): readonly SettingsRailItem[] {
  const lysMailbox = useEmailMailboxFacts("lys")
  const mcpServerList = useMcpServerStore((state) => state.list)
  const markers: SettingsRailMarkers = {
    mcp: buildMcpRailMarker(mcpServerList),
    lysEmail: buildLysEmailRailMarker(lysMailbox.connection)
  }
  return SETTINGS_PANES.map((pane) => buildSettingsRailItem(pane, markers))
}

/**
 * Finds a pane's registry entry.
 *
 * @param value - The pane.
 * @returns Its entry; every pane has one.
 */
function findSettingsPane(value: SettingsPane): SettingsPaneDescriptor {
  const pane = SETTINGS_PANES.find((entry) => entry.value === value)
  if (pane === undefined) throw new Error(`No settings pane named ${value}.`)
  return pane
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
 * session-only. The view also owns, while it is shown, which sections of
 * the Lys and Profile panes are open, provided through
 * `SettingsSectionsContext`; the rail jumps to a section, and the pane's
 * heading opens or closes all of them.
 *
 * Inventory, load, unload, reload, and health requests belong to the
 * application store; the context holds one provider's request, failure, and
 * health, as {@link findShownProvider} finds it, for the Runtime pane's
 * request feedback, while the Runtime and Models panes read every
 * provider's models from the store. Entering settings refreshes every
 * provider's inventory; leaving the view does not cancel work.
 * Request errors and loaded-state health observations are rendered by the panes.
 * The other panes read their own stores directly rather than through
 * `SettingsContext`, and propose no settings patch.
 *
 * Only the selected pane is rendered. Its body is a stable lazy component
 * behind a `Suspense` fallback; a pending body renders a separate busy
 * frame, so its heading and Done action stay available without retaining
 * the ready frame's child instances. Lazy import failures propagate, as no
 * error boundary is declared here.
 *
 * @param props - Parent-owned completion callback for leaving settings.
 * @returns The settings landmark, its rail, and the selected pane.
 */
export default function SettingsView({
  onDone
}: SettingsViewProps): ReactElement {
  const currentPane = useLysStore((state) => state.settingsPane)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const { contextValue, railStatus } = useSettingsAuthority()
  const { jumpToSection, ...sectionsValue } = useSettingsSectionsControl()
  const railItems = useSettingsRailItems()
  const pane = findSettingsPane(currentPane)

  return (
    <main aria-label="Settings" className="settings-view">
      <SettingsContext value={contextValue}>
        <SettingsSectionsContext value={sectionsValue}>
          <div className="settings-view__layout">
            <SettingsViewLeftBar
              items={railItems}
              onPaneSelect={setSettingsPane}
              onSectionSelect={jumpToSection}
              selectedPane={currentPane}
              status={railStatus.text}
              statusTone={railStatus.tone}
            />
            <div className="settings-view__content">
              <Suspense
                fallback={
                  <SettingsPaneFrame busy onDone={onDone} pane={pane} />
                }
                key={pane.value}
              >
                <SettingsPaneFrame onDone={onDone} pane={pane} />
              </Suspense>
            </div>
          </div>
        </SettingsSectionsContext>
      </SettingsContext>
    </main>
  )
}
