import type { ListedBackendToolUnavailableReason, LlmInfo } from "@lys/protocol"
import type { LlmModelReference, ToolDefinition } from "@lys/share"
import { ArrowUpRight, Blocks } from "lucide-react"
import { useEffect, useId, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { useNewConversationModel } from "@/lib/hooks/conversationModel"
import { findLoadedModelInfo } from "@/lib/models/model-availability"
import {
  calculateToolModelSupport,
  type ToolModelSupport
} from "@/lib/models/tool-model-support"
import { useLysStore } from "@/lib/store"
import { useMcpServerStore } from "@/lib/store/mcp-servers"
import type { LoadConfigurationSettings } from "@/lib/store/settings"
import { useToolStore, type ToolListState } from "@/lib/store/tools"

import ApprovedFoldersCard from "./ApprovedFoldersCard"
import { calculateModelContextLength } from "./model-pane-presentation"
import PaneSkeleton from "./PaneSkeleton"
import { ToolApprovalSaveFeedback } from "./ToolApprovalSaveFeedback"
import { ToolCallsCard } from "./ToolCallsCard"
import { ToolGroupSection } from "./ToolList"
import { ToolUnavailableCard } from "./ToolUnavailableCard"
import {
  buildToolGroups,
  calculateOfferedToolTotals,
  formatMcpToolsPointerNote,
  type ToolGroupListing
} from "./tool-presentation"

/** Properties accepted by {@link ToolListStatus}. */
type ToolListStatusProps = {
  /**
   * Sentence explaining why the tools are not shown, or an empty string while
   * they can be shown.
   */
  readonly message: string
  /**
   * Requests that the parent read the tools again; omitted when reading again
   * cannot help, which removes the Retry button.
   */
  readonly onRetryTools?: () => void
}

/**
 * Explains why the tools are not shown, offering a retry when one can help.
 *
 * @remarks The parent owns the message and the retry, and keeps the
 * component mounted while the pane is shown, so the message is one polite
 * status that exists before every change it announces; it is empty and takes
 * no space while the tools can be shown. Pressing Retry moves focus to the
 * message first, because Retry leaves while the tools are read.
 * @param props - Message and the optional parent-owned retry.
 * @returns The status line and any Retry button.
 */
function ToolListStatus({
  message,
  onRetryTools
}: ToolListStatusProps): ReactElement {
  const messageRef = useRef<HTMLParagraphElement>(null)

  /** Reads the tools again, keeping focus in the status while Retry leaves. */
  function handleRetryTools(): void {
    messageRef.current?.focus()
    onRetryTools?.()
  }

  return (
    <div className="settings-view__tool-status">
      <p
        aria-live="polite"
        className={message === "" ? undefined : "settings-view__note"}
        ref={messageRef}
        role="status"
        tabIndex={-1}
      >
        {message}
      </p>
      {onRetryTools ? (
        <Button onClick={handleRetryTools} type="button" variant="outline">
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/** Properties accepted by {@link ToolGroupList}. */
type ToolGroupListProps = {
  /** Every tool, the app's then the backend's, in the order Settings lists them. */
  readonly tools: readonly ToolDefinition[]
  /** Name of the tool whose details are shown, or null when none is. */
  readonly expandedToolName: string | null
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Whether the groups recede because tool calls are off. */
  readonly isDimmed: boolean
  /** Proposes showing one tool's details, or none with null. */
  readonly onExpandedToolNameChange: (toolName: string | null) => void
  /** Why each tool that cannot run now cannot, keyed by tool name. */
  readonly unavailableTools: ReadonlyMap<
    string,
    ListedBackendToolUnavailableReason
  >
}

/**
 * Presents every group of tools with the choices made about them.
 *
 * @remarks The application store owns each tool's switch and approval,
 * which it saves; the component passes each change to it. The parent owns
 * which tool is
 * expanded, the lock, the dimming, and the availability. Groups keep the
 * order in which the listed tools first name them; each MCP server's tools
 * form a group of their own, after Lys's groups. A tool that cannot run
 * now offers to open the Secrets pane, which the application store selects.
 * @param props - Listed tools, expansion, lock, dimming, availability, and
 * the expansion proposal.
 * @returns One section per tool group.
 */
function ToolGroupList({
  tools,
  expandedToolName,
  isLocked,
  isDimmed,
  onExpandedToolNameChange,
  unavailableTools
}: ToolGroupListProps): ReactElement {
  const toolSettings = useLysStore((state) => state.settings.tools)
  const updateToolOn = useLysStore((state) => state.updateToolOn)
  const updateToolApproval = useLysStore((state) => state.updateToolApproval)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  /**
   * Builds the section of one tool group.
   *
   * @param listing - Group and its tools, in list order.
   * @returns The group's section, keyed by its listing's key.
   */
  function buildToolGroupSection(listing: ToolGroupListing): ReactElement {
    return (
      <ToolGroupSection
        expandedToolName={expandedToolName}
        isDimmed={isDimmed}
        isLocked={isLocked}
        key={listing.key}
        listing={listing}
        onExpandedToolNameChange={onExpandedToolNameChange}
        onOpenSecrets={() => setSettingsPane("secrets")}
        onToolApprovalChange={(tool, approval) =>
          updateToolApproval(tool.name, approval)
        }
        onToolOnChange={(tool, isOn) => updateToolOn(tool.name, isOn)}
        toolChoices={toolSettings}
        unavailableTools={unavailableTools}
      />
    )
  }

  return <>{buildToolGroups(tools).map(buildToolGroupSection)}</>
}

/**
 * Presents the folders the person lets tools use.
 *
 * @remarks The application store owns the list and saves it with the other
 * tool choices, whose save status the pane shows above. The section owns no
 * state or effects, stays mounted while the pane is shown, whatever the state
 * of the tool list, and is not locked with the tool controls. A saved change
 * applies to the next round of tool calls, because the backend's policy and
 * the desktop's file tools read the settings file.
 * @returns The section with its heading, note, and card.
 */
function ApprovedFoldersSection(): ReactElement {
  const headingId = useId()
  const folderPaths = useLysStore(
    (state) => state.settings.tools.approvedFolderPaths
  )
  const addApprovedFolder = useLysStore((state) => state.addApprovedFolder)
  const removeApprovedFolder = useLysStore(
    (state) => state.removeApprovedFolder
  )

  return (
    <section aria-labelledby={headingId} className="settings-view__panel">
      <div className="settings-view__panel-intro-head">
        <span className="settings-view__eyebrow">Files</span>
        <h2 className="settings-view__panel-title" id={headingId}>
          Folders tools may use
        </h2>
        <p className="settings-view__panel-intro">
          Once you list a folder, a tool call that names a file or folder
          outside every listed one is denied: it never runs, and you are not
          asked, even on Just run. Paths are compared as typed, letter case
          included.
        </p>
      </div>
      <ApprovedFoldersCard
        folderPaths={folderPaths}
        onAddFolder={addApprovedFolder}
        onRemoveFolder={removeApprovedFolder}
      />
    </section>
  )
}

/**
 * Finds the context length of the model a new conversation uses.
 *
 * @param model - The model a new conversation uses, or null.
 * @param loadedModel - The model's information while it can answer, or
 * undefined.
 * @param loadConfiguration - Stored load settings, which name LM Studio's
 * models.
 * @returns While the model can answer, the length
 * {@link calculateModelContextLength} finds; null otherwise.
 */
function findToolContextLength(
  model: LlmModelReference | null,
  loadedModel: LlmInfo | undefined,
  loadConfiguration: LoadConfigurationSettings
): number | null {
  if (model === null || loadedModel === undefined) return null
  return calculateModelContextLength(
    model.provider,
    loadedModel,
    loadConfiguration
  )
}

/**
 * Presents where the tools of the MCP servers are switched: how many
 * servers run and how many tools they list, and the way to the MCP pane.
 *
 * @remarks The MCP server store owns the list; the application store owns
 * which pane shows; the card owns no state. The counts show once the list
 * was read.
 * @returns The card.
 */
function McpToolsPointer(): ReactElement {
  const list = useMcpServerStore((state) => state.list)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  return (
    <div className="settings-view__pointer">
      <span aria-hidden="true" className="settings-view__pointer-icon">
        <Blocks />
      </span>
      <div className="settings-view__row-lines">
        <span className="settings-view__row-title">
          Tools from MCP servers live with their server
        </span>
        <span>{formatMcpToolsPointerNote(list)}</span>
      </div>
      <Button
        onClick={() => setSettingsPane("mcp")}
        size="sm"
        type="button"
        variant="outline"
      >
        Open MCP
        <ArrowUpRight aria-hidden="true" />
      </Button>
    </div>
  )
}

/** What the Tools pane shows of the model a new conversation uses. */
type ToolModelFacts = {
  /** Whether the model was trained for tool calls. */
  readonly support: ToolModelSupport
  /** The model's context length while it can answer, or null. */
  readonly contextLength: number | null
}

/**
 * Observes whether the model a new conversation uses was trained for tool
 * calls, and its context length.
 *
 * @remarks The application store owns the providers' models and the stored
 * load settings; the hook owns no state.
 * @returns The model's tool support and, while it can answer, its context
 * length.
 */
function useToolModelFacts(): ToolModelFacts {
  const { model, availability } = useNewConversationModel()
  const loadConfiguration = useLysStore(
    (state) => state.settings.loadConfiguration
  )
  const loadedModel = findLoadedModelInfo(availability)
  return {
    support: calculateToolModelSupport(loadedModel),
    contextLength: findToolContextLength(model, loadedModel, loadConfiguration)
  }
}

/** Properties accepted by {@link ToolWorkspace}. */
type ToolWorkspaceProps = {
  /** Every tool, the app's then the backend's, in the order Settings lists them. */
  readonly tools: readonly ToolDefinition[]
  /** Why each tool that cannot run now cannot, keyed by tool name. */
  readonly unavailableTools: ReadonlyMap<
    string,
    ListedBackendToolUnavailableReason
  >
}

/**
 * Presents the tool controls: the unavailable card when the model a new
 * conversation uses is loaded and was not trained for tools, the tool-calls
 * card, and every tool group.
 *
 * @remarks The tool store owns the tool-calls switch, and the application
 * store owns each tool's switch and approval and every provider's
 * inventory; the workspace owns only which tool's details are shown, at most
 * one, which resets when the pane is left. While
 * that model was not trained for tools, the controls below the card
 * recede and are disabled, and no tool's details are shown; the tool that
 * was expanded opens again once the controls unlock. A switch applies to the
 * next chat request; an approval applies to the next round of tool calls
 * once it is saved, because the backend reads it from the settings file.
 * The tool-calls switch lasts for this session only; each tool's switch and
 * approval are saved. Only Lys's own tools are listed and counted: the MCP
 * servers' tools are switched in the MCP pane.
 * @param props - Listed tools and which cannot run now.
 * @returns The tool controls.
 */
function ToolWorkspace({
  tools,
  unavailableTools
}: ToolWorkspaceProps): ReactElement {
  const areToolCallsOn = useToolStore((state) => state.areToolCallsOn)
  const toolSwitches = useLysStore((state) => state.settings.tools.switches)
  const updateToolCallsOn = useToolStore((state) => state.updateToolCallsOn)
  const { support, contextLength } = useToolModelFacts()
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null)
  const isLocked = support.status === "untrained"
  const shownToolName = isLocked ? null : expandedToolName
  const ownTools = tools.filter((tool) => tool.runner !== "mcp")
  const totals = calculateOfferedToolTotals(
    ownTools,
    toolSwitches,
    unavailableTools
  )

  return (
    <>
      {support.status === "untrained" ? (
        <ToolUnavailableCard modelKey={support.modelKey} />
      ) : null}
      <div
        className="settings-view__tool-controls"
        data-locked={isLocked ? "" : undefined}
      >
        <ToolCallsCard
          contextLength={contextLength}
          isLocked={isLocked}
          onAreToolCallsOnChange={updateToolCallsOn}
          summary={{
            areToolCallsOn,
            support,
            offeredToolCount: totals.offeredToolCount,
            offeredTokenCount: totals.offeredTokenCount
          }}
        />
        <ToolGroupList
          expandedToolName={shownToolName}
          isDimmed={!areToolCallsOn}
          isLocked={isLocked}
          onExpandedToolNameChange={setExpandedToolName}
          tools={ownTools}
          unavailableTools={unavailableTools}
        />
      </div>
    </>
  )
}

/** Properties accepted by {@link ToolListBody}. */
type ToolListBodyProps = {
  /** Lifecycle of the list of every tool, owned by the tool store. */
  readonly list: ToolListState
}

/**
 * Presents the tools once they are read.
 *
 * @remarks The parent owns the list state and says why the tools are not
 * shown; the component owns no state or effects. Before and during the first
 * read, the tools placeholder stands in; after a failed read nothing is
 * rendered here.
 * @param props - List state.
 * @returns The placeholder, the workspace, or null after a failed read.
 */
function ToolListBody({ list }: ToolListBodyProps): ReactElement | null {
  switch (list.status) {
    case "idle":
    case "loading":
      return <PaneSkeleton pane="tools" />
    case "failed":
      return null
    case "loaded":
      return (
        <ToolWorkspace
          tools={list.tools}
          unavailableTools={list.unavailableTools}
        />
      )
  }
}

/**
 * Presents the Tools pane: Lys's tools, in the app and in the backend, the
 * tools of the connected MCP servers, and the choices about them.
 *
 * @remarks The tool store owns the list and the session's tool-calls switch,
 * and the application store owns the saved switches and approvals. The pane
 * reads the
 * tools from the desktop and the backend when it appears and none were read
 * yet; the read belongs to the store and continues if the pane is left. A
 * status line stays mounted above the tools and, after a failed read of
 * either list, shows the failure and offers Retry. The save status of the
 * tool choices stays mounted below them, so a failed save and its
 * Retry saving stay shown while the tools are read again or cannot be read.
 * Where the MCP servers' tools are switched, the approved folders section,
 * and a closing note follow, also shown whatever the state of the list; the
 * note's links show the MCP and Profile panes, where the location
 * `get_location` gives is saved.
 * The pane accepts no props and is loaded lazily by the settings view.
 * @returns The tools pane body.
 */
export default function ToolPane(): ReactElement {
  const list = useToolStore((state) => state.list)
  const loadTools = useToolStore((state) => state.loadTools)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  useEffect(() => {
    if (list.status === "idle") void loadTools()
  }, [list.status, loadTools])

  return (
    <div className="settings-view__tool-pane">
      <ToolListStatus
        message={list.status === "failed" ? list.error : ""}
        onRetryTools={
          list.status === "failed" ? () => void loadTools() : undefined
        }
      />
      <div className="settings-view__stack">
        <ToolListBody list={list} />
        <McpToolsPointer />
        <ToolApprovalSaveFeedback />
        <ApprovedFoldersSection />
        <p className="settings-view__closing-note">
          Lys&apos;s own tools cannot be added or removed here; MCP servers add
          theirs under{" "}
          <Button
            className="settings-view__inline-link"
            onClick={() => setSettingsPane("mcp")}
            type="button"
            variant="link"
          >
            MCP
          </Button>
          . Each tool&apos;s switch and its Ask me or Just run choice are saved.
          The Tool calls switch resets when Lys restarts. Your location for{" "}
          <code>get_location</code> is kept in{" "}
          <Button
            className="settings-view__inline-link"
            onClick={() => setSettingsPane("profile")}
            type="button"
            variant="link"
          >
            Profile
          </Button>
          .
        </p>
      </div>
    </div>
  )
}
