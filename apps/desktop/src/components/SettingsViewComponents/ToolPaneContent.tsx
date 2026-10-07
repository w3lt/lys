import type { ToolDefinition } from "@lys/share"
import { useEffect, useRef, useState, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { useLysStore } from "@/lib/store"
import { useToolStore, type ToolListState } from "@/lib/store/tools"

import PaneSkeleton from "./PaneSkeleton"
import { ToolCallsCard } from "./ToolCallsCard"
import { ToolGroupSection } from "./ToolList"
import { ToolUnavailableCard } from "./ToolUnavailableCard"
import {
  buildToolGroups,
  calculateOfferedToolTotals,
  calculateToolModelSupport
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

/** Properties accepted by {@link ToolWorkspace}. */
type ToolWorkspaceProps = {
  /** Every client tool, in the order Settings lists them. */
  readonly tools: readonly ToolDefinition[]
}

/**
 * Presents the tool controls: the unavailable card when the loaded model was
 * not trained for tools, the tool-calls card, and every tool group.
 *
 * @remarks The tool store owns the choices and the application store owns
 * the loaded model and the inventory; the workspace owns only which tool's
 * details are shown, at most one, which resets when the pane is left. While
 * the loaded model was not trained for tools, the controls below the card
 * recede and are disabled. Every choice is a session-only mock.
 * @param props - Listed tools.
 * @returns The tool controls.
 */
function ToolWorkspace({ tools }: ToolWorkspaceProps): ReactElement {
  const areToolCallsOn = useToolStore((state) => state.areToolCallsOn)
  const callsPerReply = useToolStore((state) => state.callsPerReply)
  const toolChoices = useToolStore((state) => state.toolChoices)
  const updateToolCallsOn = useToolStore((state) => state.updateToolCallsOn)
  const updateCallsPerReply = useToolStore((state) => state.updateCallsPerReply)
  const updateToolOn = useToolStore((state) => state.updateToolOn)
  const updateToolApproval = useToolStore((state) => state.updateToolApproval)
  const modelRuntime = useLysStore((state) => state.modelRuntime)
  const modelInventory = useLysStore((state) => state.modelInventory)
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null)
  const support = calculateToolModelSupport(modelRuntime, modelInventory)
  const isLocked = support.status === "untrained"
  const totals = calculateOfferedToolTotals(tools, toolChoices)

  return (
    <div className="settings-view__stack">
      {support.status === "untrained" ? (
        <ToolUnavailableCard modelKey={support.modelKey} />
      ) : null}
      <div
        className="settings-view__tool-controls"
        data-locked={isLocked ? "" : undefined}
      >
        <ToolCallsCard
          callsPerReply={callsPerReply}
          isLocked={isLocked}
          onAreToolCallsOnChange={updateToolCallsOn}
          onCallsPerReplyChange={updateCallsPerReply}
          summary={{
            areToolCallsOn,
            support,
            offeredToolCount: totals.offeredToolCount,
            offeredTokenCount: totals.offeredTokenCount
          }}
        />
        {buildToolGroups(tools).map((listing) => (
          <ToolGroupSection
            expandedToolName={expandedToolName}
            isDimmed={!areToolCallsOn}
            isLocked={isLocked}
            key={listing.group}
            listing={listing}
            onExpandedToolNameChange={setExpandedToolName}
            onToolApprovalChange={updateToolApproval}
            onToolOnChange={updateToolOn}
            toolChoices={toolChoices}
          />
        ))}
      </div>
    </div>
  )
}

/** Properties accepted by {@link ToolListBody}. */
type ToolListBodyProps = {
  /** Lifecycle of the list of client tools, owned by the tool store. */
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
      return <ToolWorkspace tools={list.tools} />
  }
}

/**
 * Presents the Tools pane: Lys's client tools and the choices about them.
 *
 * @remarks The tool store owns the list and the choices. The pane reads the
 * tools from the desktop when it appears and none were read yet; the read
 * belongs to the store and continues if the pane is left. A status line stays
 * mounted above the tools and, after a failed read, shows the failure and
 * offers Retry. The tools do not depend on the backend. The pane accepts no
 * props and is loaded lazily by the settings view.
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
      <ToolListBody list={list} />
    </div>
  )
}
