import type { BackendToolUnavailableReason } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import { useEffect, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import { useLysStore } from "@/lib/store"
import {
  useToolStore,
  type ToolChoices,
  type ToolListState
} from "@/lib/store/tools"

import PaneSkeleton from "./PaneSkeleton"
import { ToolCallsCard } from "./ToolCallsCard"
import { ToolGroupSection } from "./ToolList"
import { ToolUnavailableCard } from "./ToolUnavailableCard"
import {
  buildToolGroups,
  calculateOfferedToolTotals,
  formatToolSettingsSaveStatus,
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
  readonly unavailableTools: ReadonlyMap<string, BackendToolUnavailableReason>
}

/**
 * Presents every group of tools with the choices made about them.
 *
 * @remarks The tool store owns each tool's switch for this session, and the
 * application store owns each tool's approval, which it saves; the
 * component passes each change to its owner. The parent owns which tool is
 * expanded, the lock, the dimming, and the availability. Groups keep the
 * order in which the listed tools first name them. A tool that cannot run
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
  const toolSwitches = useToolStore((state) => state.toolSwitches)
  const updateToolOn = useToolStore((state) => state.updateToolOn)
  const justRunToolNames = useLysStore(
    (state) => state.settings.tools.justRunToolNames
  )
  const updateToolApproval = useLysStore((state) => state.updateToolApproval)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const toolChoices: ToolChoices = {
    switches: toolSwitches,
    justRunToolNames
  }

  /**
   * Builds the section of one tool group.
   *
   * @param listing - Group and its tools, in list order.
   * @returns The group's section, keyed by its group.
   */
  function buildToolGroupSection(listing: ToolGroupListing): ReactElement {
    return (
      <ToolGroupSection
        expandedToolName={expandedToolName}
        isDimmed={isDimmed}
        isLocked={isLocked}
        key={listing.group}
        listing={listing}
        onExpandedToolNameChange={onExpandedToolNameChange}
        onOpenSecrets={() => setSettingsPane("secrets")}
        onToolApprovalChange={(tool, approval) =>
          updateToolApproval(tool.name, approval)
        }
        onToolOnChange={updateToolOn}
        toolChoices={toolChoices}
        unavailableTools={unavailableTools}
      />
    )
  }

  return <>{buildToolGroups(tools).map(buildToolGroupSection)}</>
}

/**
 * Announces the automatic save of the Just run choices and offers a retry
 * when a write fails.
 *
 * @remarks The application store owns the save across pane unmounts; the
 * component owns no state or effects. The status is one polite region named
 * "Just run choices save" that stays mounted while the pane is shown, also
 * while the tools are read again or cannot be read, so it exists before
 * every change it announces; it is empty while nothing needs saying. After
 * a failure, Retry saving writes the current choices again; until a save
 * works, tool calls follow the choices last saved, because the backend reads
 * them from the settings file.
 * @returns The status region and, after a failed save, the retry button.
 */
function ToolApprovalSaveFeedback(): ReactElement {
  const save = useLysStore((state) => state.toolSettingsSave)
  const saveToolSettings = useLysStore((state) => state.saveToolSettings)

  return (
    <div className="settings-view__tool-status">
      <p
        aria-label="Just run choices save"
        aria-live="polite"
        className="settings-view__note"
        role="status"
      >
        {formatToolSettingsSaveStatus(save)}
      </p>
      {save.status === "failed" ? (
        <Button
          onClick={() => void saveToolSettings()}
          type="button"
          variant="outline"
        >
          Retry saving
        </Button>
      ) : null}
    </div>
  )
}

/** Properties accepted by {@link ToolWorkspace}. */
type ToolWorkspaceProps = {
  /** Every tool, the app's then the backend's, in the order Settings lists them. */
  readonly tools: readonly ToolDefinition[]
  /** Why each tool that cannot run now cannot, keyed by tool name. */
  readonly unavailableTools: ReadonlyMap<string, BackendToolUnavailableReason>
}

/**
 * Presents the tool controls: the unavailable card when the loaded model was
 * not trained for tools, the tool-calls card, and every tool group.
 *
 * @remarks The tool store owns the choices and the application store owns
 * the loaded model and the inventory; the workspace owns only which tool's
 * details are shown, at most one, which resets when the pane is left. While
 * the loaded model was not trained for tools, the controls below the card
 * recede and are disabled, and no tool's details are shown; the tool that
 * was expanded opens again once the controls unlock. A switch applies to the
 * next chat request; an approval applies to the next round of tool calls
 * once it is saved, because the backend reads it from the settings file.
 * The switches last for this session only; each tool's approval is saved.
 * @param props - Listed tools and which cannot run now.
 * @returns The tool controls.
 */
function ToolWorkspace({
  tools,
  unavailableTools
}: ToolWorkspaceProps): ReactElement {
  const areToolCallsOn = useToolStore((state) => state.areToolCallsOn)
  const toolSwitches = useToolStore((state) => state.toolSwitches)
  const updateToolCallsOn = useToolStore((state) => state.updateToolCallsOn)
  const modelRuntime = useLysStore((state) => state.modelRuntime)
  const modelInventory = useLysStore((state) => state.modelInventory)
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null)
  const support = calculateToolModelSupport(modelRuntime, modelInventory)
  const isLocked = support.status === "untrained"
  const shownToolName = isLocked ? null : expandedToolName
  const totals = calculateOfferedToolTotals(
    tools,
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
          tools={tools}
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
 * Presents the Tools pane: Lys's tools, in the app and in the backend, and
 * the choices about them.
 *
 * @remarks The tool store owns the list and the session switches, and the
 * application store owns the saved approvals. The pane reads the
 * tools from the desktop and the backend when it appears and none were read
 * yet; the read belongs to the store and continues if the pane is left. A
 * status line stays mounted above the tools and, after a failed read of
 * either list, shows the failure and offers Retry. The save status of the
 * Just run choices stays mounted below them, so a failed save and its
 * Retry saving stay shown while the tools are read again or cannot be read.
 * The pane accepts no props and is loaded lazily by the settings view.
 * @returns The tools pane body.
 */
export default function ToolPane(): ReactElement {
  const list = useToolStore((state) => state.list)
  const loadTools = useToolStore((state) => state.loadTools)

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
        <ToolApprovalSaveFeedback />
      </div>
    </div>
  )
}
