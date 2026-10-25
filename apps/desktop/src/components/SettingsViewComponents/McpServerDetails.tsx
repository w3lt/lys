import type { McpServerState, SkippedMcpTool } from "@lys/protocol"
import type { McpServerSettings, McpToolDefinition } from "@lys/share"
import { ChevronRight } from "lucide-react"
import { useId, useState, type KeyboardEvent, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ToolSettings } from "@/lib/store/settings"
import { TOOL_APPROVALS, type ToolApproval } from "@/lib/store/tool-settings"
import { isToolOn, type ToolListState } from "@/lib/store/tools"

import { handleFocusTargetAttach } from "./focus-target"
import {
  findMcpServerApproval,
  formatMcpReconnectLabel,
  formatMcpServerApprovalNote,
  formatMcpServerRemovalQuestion,
  formatMcpServerToolMeta,
  formatMcpServerToolsNote,
  formatSkippedMcpToolName,
  formatSkippedMcpToolReason,
  listMcpServerConfiguration,
  listSkippedMcpTools,
  MCP_TOOL_CHIPS_NOTE,
  MCP_TOOL_LIST_CUT_NOTE,
  type McpServerStatusPresentation
} from "./mcp-presentation"
import { findToolApproval, formatToolApprovalLabel } from "./tool-presentation"

/** Connected state of a server whose skipped tools its details can list. */
export type ConnectedMcpServerState = Extract<
  McpServerState,
  { readonly status: "connected" }
>

/** Properties accepted by {@link McpSkippedTools}. */
type McpSkippedToolsProps = {
  /** Name of the server, which the toggle's name ends with. */
  readonly serverName: string
  /** Connected state whose skipped tools are listed. */
  readonly state: ConnectedMcpServerState
}

/**
 * Lets the person show which tools of a connected server the backend does
 * not list, and why.
 *
 * @remarks The component owns only whether the list is shown, which starts
 * hidden. The toggle is named `Skipped tools of <server>`, so each server's
 * is distinct, and exposes its state through `aria-expanded`. Each skipped
 * tool shows the server's name for it and the reason, in the server's order,
 * identical entries each listed and keyed by {@link listSkippedMcpTools}; a
 * server with more tools than Lys reads says so.
 * @param props - Server name and its connected state.
 * @returns The toggle and, when shown, the skipped tools.
 */
function McpSkippedTools({
  serverName,
  state
}: McpSkippedToolsProps): ReactElement {
  const [isExpanded, setIsExpanded] = useState(false)
  const listId = useId()

  return (
    <div className="settings-view__mcp-skipped">
      <button
        aria-controls={isExpanded ? listId : undefined}
        aria-expanded={isExpanded}
        aria-label={`Skipped tools of ${serverName}`}
        className="settings-view__mcp-skipped-toggle"
        onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)}
        type="button"
      >
        <ChevronRight aria-hidden="true" />
        Skipped tools
      </button>
      {isExpanded ? (
        <div id={listId}>
          <ul className="settings-view__mcp-skipped-list">
            {listSkippedMcpTools(state.skippedTools).map(({ key, tool }) => (
              <McpSkippedToolItem key={key} tool={tool} />
            ))}
          </ul>
          {state.isToolListCut ? (
            <p className="settings-view__note">{MCP_TOOL_LIST_CUT_NOTE}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Properties accepted by {@link McpSkippedToolItem}. */
type McpSkippedToolItemProps = {
  /** Tool the backend skipped. */
  readonly tool: SkippedMcpTool
}

/**
 * Presents one tool the backend skipped: its name and why.
 *
 * @remarks The list owner supplies the key; the item owns no state.
 * @param props - Skipped tool.
 * @returns One list item.
 */
function McpSkippedToolItem({ tool }: McpSkippedToolItemProps): ReactElement {
  return (
    <li>
      <span className="settings-view__mcp-skipped-name">
        {formatSkippedMcpToolName(tool.name)}
      </span>
      <span>{formatSkippedMcpToolReason(tool.reason)}</span>
    </li>
  )
}

/** Properties accepted by {@link McpServerStatusLine}. */
type McpServerStatusLineProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** The server's state. */
  readonly status: McpServerStatusPresentation
  /** Whether the backend is running, which connecting the server needs. */
  readonly isBackendRunning: boolean
  /** Requests that the parent connect the server again. */
  readonly onReconnect: () => void
}

/**
 * Presents a server's state and the button that connects it again.
 *
 * @remarks The parent owns the state and the reconnect; the component owns
 * no state. The heading and detail form the server's own polite, atomic
 * status, so a change of the state while the details are shown is announced
 * once. The button reads Retry, Restart, Reconnect, Start, or Connect for
 * the state and the transport, is named by its text and the server, and is
 * disabled while the backend is not running.
 * @param props - Server, state, backend status, and the reconnect request.
 * @returns The status line.
 */
function McpServerStatusLine({
  server,
  status,
  isBackendRunning,
  onReconnect
}: McpServerStatusLineProps): ReactElement {
  const label = formatMcpReconnectLabel(server.transport, status.condition)

  return (
    <div className="settings-view__mcp-status-line">
      <div
        aria-atomic="true"
        aria-live="polite"
        className="settings-view__mcp-status-text"
        role="status"
      >
        <span className="settings-view__mcp-status-heading">
          <span className="sr-only">{server.name}: </span>
          {status.heading}
        </span>
        {status.detail === "" ? null : (
          <span
            className="settings-view__mcp-status-detail"
            data-condition={status.condition}
          >
            {status.detail}
          </span>
        )}
      </div>
      <Button
        aria-label={`${label} ${server.name}`}
        disabled={!isBackendRunning}
        onClick={onReconnect}
        size="sm"
        type="button"
        variant="outline"
      >
        {label}
      </Button>
    </div>
  )
}

/** Properties accepted by {@link McpToolChip}. */
type McpToolChipProps = {
  /** Tool the chip switches. */
  readonly tool: McpToolDefinition
  /** Whether the tool is on. */
  readonly isOn: boolean
  /** Proposes switching the tool on or off. */
  readonly onIsOnChange: (isOn: boolean) => void
}

/**
 * Presents one tool of a server as a toggle button that switches it.
 *
 * @remarks The parent owns the switch; the chip owns no state. It is a
 * pressed toggle named by the server's name for the tool while the tool is
 * on; a tool that is off is crossed out and dimmed. The tool's description
 * is its tooltip.
 * @param props - Tool, its switch, and the switch proposal.
 * @returns One list item holding the toggle.
 */
function McpToolChip({
  tool,
  isOn,
  onIsOnChange
}: McpToolChipProps): ReactElement {
  return (
    <li>
      <button
        aria-pressed={isOn}
        className="settings-view__mcp-tool"
        onClick={() => onIsOnChange(!isOn)}
        title={tool.description}
        type="button"
      >
        <span aria-hidden="true" className="settings-view__mcp-tool-dot" />
        {tool.serverToolName}
      </button>
    </li>
  )
}

/** Properties accepted by {@link McpServerToolSection}. */
type McpServerToolSectionProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** The server's listed tools, in the backend's order. */
  readonly tools: readonly McpToolDefinition[]
  /** Why no tool is shown, shown while the server lists none. */
  readonly emptyNote: string
  /** Connected state while the backend skipped some tools, or undefined. */
  readonly skippedToolsState: ConnectedMcpServerState | undefined
  /** Saved switches by tool name. */
  readonly toolSwitches: ReadonlyMap<string, boolean>
  /** Proposes switching one tool on or off. */
  readonly onToolOnChange: (toolName: string, isOn: boolean) => void
}

/**
 * Presents a server's tools, each switched on or off by its chip.
 *
 * @remarks The parent owns the tools, the switches, and the note; the
 * section owns no state. Its heading names it; while tools are listed, a
 * meta line says how many are on and what they cost per request, and the
 * chips are a list named `Tools of <server>`, keyed by tool name. Without
 * tools the note says why. A server whose tools the backend skipped lets the
 * person list them.
 * @param props - Server, tools, note, skipped tools, switches, and the
 * switch proposal.
 * @returns The tools section.
 */
function McpServerToolSection({
  server,
  tools,
  emptyNote,
  skippedToolsState,
  toolSwitches,
  onToolOnChange
}: McpServerToolSectionProps): ReactElement {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="settings-view__mcp-block">
      <div className="settings-view__mcp-subheading">
        <h3 id={headingId}>tools</h3>
        {tools.length === 0 ? null : (
          <span>{formatMcpServerToolMeta(tools, toolSwitches)}</span>
        )}
      </div>
      {tools.length === 0 ? (
        <p className="settings-view__mcp-detail-note">{emptyNote}</p>
      ) : (
        <>
          <ul
            aria-label={`Tools of ${server.name}`}
            className="settings-view__mcp-tools"
          >
            {tools.map((tool) => (
              <McpToolChip
                isOn={isToolOn(toolSwitches, tool)}
                key={tool.name}
                onIsOnChange={(isOn) => onToolOnChange(tool.name, isOn)}
                tool={tool}
              />
            ))}
          </ul>
          <p className="settings-view__mcp-detail-note">
            {MCP_TOOL_CHIPS_NOTE}
          </p>
        </>
      )}
      {skippedToolsState === undefined ? null : (
        <McpSkippedTools serverName={server.name} state={skippedToolsState} />
      )}
    </section>
  )
}

/** Properties accepted by {@link McpServerApprovalRow}. */
type McpServerApprovalRowProps = {
  /** The server's listed tools. */
  readonly tools: readonly McpToolDefinition[]
  /** Names of the tools on Just run. */
  readonly justRunToolNames: ReadonlySet<string>
  /** Proposes one approval for every listed tool of the server. */
  readonly onApprovalChange: (approval: ToolApproval) => void
}

/**
 * Presents whether Lys asks before a server's tools run, with the choice
 * between Ask me and Just run for all of them.
 *
 * @remarks The parent owns the approvals; the row owns no state. The choice
 * is a single-choice toggle group named by its label and described by the
 * note. It selects the approval every listed tool has and none while they
 * differ; choosing one proposes it for every listed tool. While the server
 * lists no tool, the group is disabled and the note says each tool asks
 * first. Pressing the selected approval again proposes nothing.
 * @param props - Tools, the approvals, and the approval proposal.
 * @returns The approval row.
 */
function McpServerApprovalRow({
  tools,
  justRunToolNames,
  onApprovalChange
}: McpServerApprovalRowProps): ReactElement {
  const labelId = useId()
  const noteId = useId()
  const approval = findMcpServerApproval(tools, justRunToolNames)
  const isSettled = approval === "ask" || approval === "run"

  /**
   * Proposes the approval the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleApprovalValueChange(groupValue: string[]): void {
    const nextApproval = findToolApproval(groupValue)
    if (nextApproval !== undefined) onApprovalChange(nextApproval)
  }

  return (
    <div className="settings-view__mcp-approval">
      <div className="settings-view__identity-lines">
        <h3 id={labelId}>Before its tools run</h3>
        <p id={noteId}>{formatMcpServerApprovalNote(approval)}</p>
      </div>
      <ToggleGroup
        aria-describedby={noteId}
        aria-labelledby={labelId}
        disabled={approval === "none"}
        onValueChange={handleApprovalValueChange}
        size="sm"
        value={isSettled ? [approval] : []}
        variant="outline"
      >
        {TOOL_APPROVALS.map((option) => (
          <ToggleGroupItem
            className="settings-view__tool-segment"
            key={option}
            value={option}
          >
            {formatToolApprovalLabel(option)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** Properties accepted by {@link McpServerConfiguration}. */
type McpServerConfigurationProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
}

/**
 * Presents how a server is configured, without a secret value.
 *
 * @remarks The parent owns the settings; the component owns no state. It is
 * a section named by its heading, `configuration`, whose lines form a
 * description list keyed by their unique labels; the heading's meta says
 * the settings file that holds them.
 * @param props - Server settings.
 * @returns The configuration section.
 */
function McpServerConfiguration({
  server
}: McpServerConfigurationProps): ReactElement {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="settings-view__mcp-block">
      <div className="settings-view__mcp-subheading">
        <h3 id={headingId}>configuration</h3>
        <span>settings.json</span>
      </div>
      <dl className="settings-view__mcp-config">
        {listMcpServerConfiguration(server).map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd data-none={line.isNone ? "" : undefined}>{line.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Properties accepted by {@link McpServerRemoveConfirmation}. */
type McpServerRemoveConfirmationProps = {
  /** Saved settings of the server to remove. */
  readonly server: McpServerSettings
  /** Whether a save of the servers runs, which disables both choices. */
  readonly isSaving: boolean
  /** Requests that the parent keep the server. */
  readonly onKeep: () => void
  /** Requests that the parent remove the server. */
  readonly onRemove: () => void
}

/**
 * Asks whether to remove a server.
 *
 * @remarks The parent owns both choices and the save; the component owns no
 * state. The question, such as `remove <server>?`, is shown and names the
 * group; its choices are named `Keep <server>` and `Remove <server>`. Focus
 * starts on Keep, the least destructive choice, and Escape on either choice
 * keeps the server. While a save runs, both choices are disabled.
 * @param props - Server, the save, and the parent-owned choices.
 * @returns The confirmation group.
 */
function McpServerRemoveConfirmation({
  server,
  isSaving,
  onKeep,
  onRemove
}: McpServerRemoveConfirmationProps): ReactElement {
  const questionId = useId()

  /**
   * Keeps the server when Escape is pressed on either choice.
   *
   * @param event - Key press on a confirmation button.
   */
  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    onKeep()
  }

  return (
    <fieldset
      aria-labelledby={questionId}
      className="settings-view__mcp-confirm"
      disabled={isSaving}
    >
      <span id={questionId}>{formatMcpServerRemovalQuestion(server)}</span>
      <Button
        aria-label={`Keep ${server.name}`}
        autoFocus
        onClick={onKeep}
        onKeyDown={handleConfirmationKeyDown}
        size="sm"
        type="button"
        variant="outline"
      >
        Keep
      </Button>
      <Button
        aria-label={`Remove ${server.name}`}
        onClick={onRemove}
        onKeyDown={handleConfirmationKeyDown}
        size="sm"
        type="button"
        variant="destructive"
      >
        Remove
      </Button>
    </fieldset>
  )
}

/** Properties accepted by {@link McpServerDetailActions}. */
type McpServerDetailActionsProps = {
  /** Saved settings of the server the actions concern. */
  readonly server: McpServerSettings
  /** Whether a save of the servers runs, which disables both actions. */
  readonly isSaving: boolean
  /** Whether the Edit button takes focus when it is attached. */
  readonly isEditFocusedOnAttach: boolean
  /** Requests that the parent open the server's editor. */
  readonly onEdit: () => void
  /** Requests that the parent remove the server, after the person confirmed. */
  readonly onRemove: () => void
}

/**
 * Offers removing and editing one server, confirming removal first.
 *
 * @remarks The parent owns both actions; the component owns only whether
 * removal is being confirmed, and whether focus must come back to Remove
 * when the confirmation leaves. Each button is named by its text and the
 * server, such as `Edit <server>`. Both are disabled while a save of the
 * servers runs.
 * @param props - Server, the save, focus, and the actions.
 * @returns Remove, or its confirmation, and Edit.
 */
function McpServerDetailActions({
  server,
  isSaving,
  isEditFocusedOnAttach,
  onEdit,
  onRemove
}: McpServerDetailActionsProps): ReactElement {
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false)
  const [hasConfirmationOpened, setHasConfirmationOpened] = useState(false)

  /** Asks whether to remove, remembering that focus must come back. */
  function handleRequestRemoval(): void {
    setHasConfirmationOpened(true)
    setIsConfirmingRemoval(true)
  }

  return (
    <div className="settings-view__mcp-detail-actions">
      {isConfirmingRemoval ? (
        <McpServerRemoveConfirmation
          isSaving={isSaving}
          onKeep={() => setIsConfirmingRemoval(false)}
          onRemove={onRemove}
          server={server}
        />
      ) : (
        <Button
          aria-label={`Remove ${server.name}`}
          className="settings-view__mcp-remove"
          disabled={isSaving}
          onClick={handleRequestRemoval}
          ref={hasConfirmationOpened ? handleFocusTargetAttach : undefined}
          size="sm"
          type="button"
          variant="outline"
        >
          Remove
        </Button>
      )}
      <Button
        aria-label={`Edit ${server.name}`}
        disabled={isSaving}
        onClick={onEdit}
        ref={isEditFocusedOnAttach ? handleFocusTargetAttach : undefined}
        size="sm"
        type="button"
        variant="outline"
      >
        Edit
      </Button>
    </div>
  )
}

/** Properties accepted by {@link McpServerDetails}. */
export type McpServerDetailsProps = {
  /** Identifier of the details, which the row's toggle controls. */
  readonly detailsId: string
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** The server's state. */
  readonly status: McpServerStatusPresentation
  /** The server's listed tools, in the backend's order. */
  readonly tools: readonly McpToolDefinition[]
  /** Lifecycle of the tool list, which says why no tool is shown. */
  readonly toolList: ToolListState
  /** Connected state while the backend skipped some tools, or undefined. */
  readonly skippedToolsState: ConnectedMcpServerState | undefined
  /** Saved tool switches and approvals. */
  readonly toolSettings: ToolSettings
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Whether a save of the servers runs. */
  readonly isSaving: boolean
  /** Whether the Edit button takes focus when it is attached. */
  readonly isEditFocusedOnAttach: boolean
  /** Requests that the parent connect the server again. */
  readonly onReconnect: () => void
  /** Requests that the parent open the server's editor. */
  readonly onEdit: () => void
  /** Requests that the parent remove the server. */
  readonly onRemove: () => void
  /** Proposes switching one tool on or off. */
  readonly onToolOnChange: (toolName: string, isOn: boolean) => void
  /** Proposes one approval for several tools. */
  readonly onToolApprovalChange: (
    toolNames: readonly string[],
    approval: ToolApproval
  ) => void
}

/**
 * Presents the details of one server: its state and the button that
 * connects it again, its tools, whether they ask before running, its
 * configuration, and its Remove and Edit actions.
 *
 * @remarks The parent owns the settings, the state, the tools, the choices
 * about them, and every action; the details own no state of their own. They
 * carry the identifier the row's toggle controls. A tool's chip proposes its
 * switch; the approval proposes one approval for every listed tool. Values
 * that can be secrets are never shown.
 * @param props - Server, state, tools, choices, backend status, the save,
 * focus, and the actions.
 * @returns The details region.
 */
export function McpServerDetails({
  detailsId,
  server,
  status,
  tools,
  toolList,
  skippedToolsState,
  toolSettings,
  isBackendRunning,
  isSaving,
  isEditFocusedOnAttach,
  onReconnect,
  onEdit,
  onRemove,
  onToolOnChange,
  onToolApprovalChange
}: McpServerDetailsProps): ReactElement {
  const toolsNote = formatMcpServerToolsNote({
    condition: status.condition,
    toolList,
    skippedToolCount: skippedToolsState?.skippedTools.length ?? 0
  })

  return (
    <div className="settings-view__mcp-details" id={detailsId}>
      <McpServerStatusLine
        isBackendRunning={isBackendRunning}
        onReconnect={onReconnect}
        server={server}
        status={status}
      />
      <McpServerToolSection
        emptyNote={toolsNote}
        onToolOnChange={onToolOnChange}
        server={server}
        skippedToolsState={skippedToolsState}
        toolSwitches={toolSettings.switches}
        tools={tools}
      />
      <McpServerApprovalRow
        justRunToolNames={toolSettings.justRunToolNames}
        onApprovalChange={(approval) =>
          onToolApprovalChange(
            tools.map((tool) => tool.name),
            approval
          )
        }
        tools={tools}
      />
      <McpServerConfiguration server={server} />
      <McpServerDetailActions
        isEditFocusedOnAttach={isEditFocusedOnAttach}
        isSaving={isSaving}
        onEdit={onEdit}
        onRemove={onRemove}
        server={server}
      />
    </div>
  )
}
