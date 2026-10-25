import type {
  McpServerName,
  McpServerSettings,
  McpServerTransport,
  McpToolDefinition
} from "@lys/share"
import { ChevronRight, Plus } from "lucide-react"
import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type RefObject
} from "react"

import { Button } from "@/components/ui/button"
import type { McpServerListState } from "@/lib/store/mcp-servers"
import type { ToolSettings } from "@/lib/store/settings"
import type { ToolApproval } from "@/lib/store/tool-settings"
import { isToolOn, type ToolListState } from "@/lib/store/tools"

import {
  McpServerDetails,
  type ConnectedMcpServerState
} from "./McpServerDetails"
import {
  canAddMcpServer,
  countConnectedMcpServers,
  findMcpServerStatus,
  formatMcpServerListMeta,
  formatMcpServerStatus,
  formatMcpServerTarget,
  formatMcpServerToolCount,
  getMcpTransportPresentation,
  listMcpServerTools,
  MCP_EMPTY_LIST_NOTE,
  MCP_SERVER_LIMIT_NOTE,
  MCP_SERVER_TRANSPORTS,
  type McpServerStatusPresentation
} from "./mcp-presentation"

/**
 * Request that a control of the server list receive focus.
 *
 * @remarks Each request is a new object. A server's Edit button takes focus
 * when its details appear; Add server takes focus once for each request the
 * list receives, so asking again, as after a second removal, moves focus
 * again, while a rerender with the same request does not.
 */
export type McpServerListFocusTarget =
  | {
      /** Focus stays where it is. */
      readonly kind: "none"
    }
  | {
      /** The Add server button receives focus. */
      readonly kind: "add-server"
    }
  | {
      /** One server's Edit button receives focus. */
      readonly kind: "server"
      /** Name of that server. */
      readonly serverName: McpServerName
    }

/**
 * Finds the connected state of a server whose details list skipped tools.
 *
 * @param list - Lifecycle of the list of applied servers.
 * @param serverName - Name of the server.
 * @returns The connected state when the backend skipped some of the
 * server's tools or did not read them all; otherwise undefined.
 */
function findSkippedToolsState(
  list: McpServerListState,
  serverName: McpServerName
): ConnectedMcpServerState | undefined {
  const state = findMcpServerStatus(list, serverName)?.state
  if (state?.status !== "connected") return undefined
  const hasSkippedTools = state.skippedTools.length > 0
  return hasSkippedTools || state.isToolListCut ? state : undefined
}

/** Properties accepted by {@link McpToolOfferWarning}. */
type McpToolOfferWarningProps = {
  /** Why nothing from the servers is offered; never empty. */
  readonly text: string
  /** Requests that the parent open the Tools pane. */
  readonly onOpenTools: () => void
}

/**
 * Warns that the servers' tools are not offered to the model, with a way to
 * the Tools pane.
 *
 * @remarks The parent owns the text and whether the warning is shown, and
 * opens the pane; the component owns no state. The text says why, such as
 * tool calls being off; Open Tools leads to where that is changed.
 * @param props - Warning text and the request to open the Tools pane.
 * @returns The warning.
 */
export function McpToolOfferWarning({
  text,
  onOpenTools
}: McpToolOfferWarningProps): ReactElement {
  return (
    <div className="settings-view__mcp-warning">
      <span className="settings-view__mcp-warning-text">
        <span aria-hidden="true" className="settings-view__mcp-warning-dot" />
        {text}
      </span>
      <Button onClick={onOpenTools} size="sm" type="button" variant="outline">
        Open Tools
      </Button>
    </div>
  )
}

/** Properties accepted by {@link McpServerTitle}. */
type McpServerTitleProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** The server's state. */
  readonly status: McpServerStatusPresentation
  /** Identifier the name takes. */
  readonly nameId: string
  /** Identifier the transport tag takes. */
  readonly transportId: string
  /** Identifier the state takes. */
  readonly stateId: string
}

/**
 * Presents a server's name, its transport tag, and its state.
 *
 * @remarks The parent owns every value; the title owns no state. A state
 * other than connected shows as a tag; otherwise the state's heading is
 * only read out.
 * @param props - Server, state, and the identifiers the parts take.
 * @returns The title line.
 */
function McpServerTitle({
  server,
  status,
  nameId,
  transportId,
  stateId
}: McpServerTitleProps): ReactElement {
  return (
    <span className="settings-view__mcp-title">
      <span className="settings-view__mcp-name" id={nameId}>
        {server.name}
      </span>
      <span
        className="settings-view__mcp-transport-tag"
        data-transport={server.transport}
        id={transportId}
      >
        {getMcpTransportPresentation(server.transport).tag}
      </span>
      {status.chip === "" ? (
        <span className="sr-only" id={stateId}>
          {status.heading}
        </span>
      ) : (
        <span
          className="settings-view__mcp-state-tag"
          data-condition={status.condition}
          id={stateId}
        >
          {status.chip}
        </span>
      )}
    </span>
  )
}

/** Properties accepted by {@link McpServerToggle}. */
type McpServerToggleProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** The server's state. */
  readonly status: McpServerStatusPresentation
  /** Identifier of the name, which names the server's list item. */
  readonly nameId: string
  /** How many tools the row says the server lists, or empty. */
  readonly toolCount: string
  /** Whether the server's details are shown. */
  readonly isExpanded: boolean
  /** Identifier of the details the toggle controls. */
  readonly detailsId: string
  /** Proposes showing or hiding the server's details. */
  readonly onIsExpandedChange: (isExpanded: boolean) => void
}

/**
 * Presents a server's summary as the button that shows or hides its
 * details.
 *
 * @remarks The parent owns whether the details are shown; the toggle owns no
 * state. It exposes `aria-expanded` and controls the details while they are
 * shown. It shows the server's name, transport tag, a tag for a state other
 * than connected, what it runs or reaches, and how many tools it lists; a
 * dot shows the state by colour, and the state's heading is also read out
 * when no tag shows it. The toggle is named by the server's name and
 * described by the transport, the state, the target, and the tool count.
 * Values that can be secrets are never shown.
 * @param props - Server, state, name identifier, tool count, expansion, and
 * the proposal.
 * @returns The toggle button.
 */
function McpServerToggle({
  server,
  status,
  nameId,
  toolCount,
  isExpanded,
  detailsId,
  onIsExpandedChange
}: McpServerToggleProps): ReactElement {
  const transportId = useId()
  const stateId = useId()
  const targetId = useId()
  const countId = useId()
  const descriptionIds = [transportId, stateId, targetId]

  return (
    <button
      aria-controls={isExpanded ? detailsId : undefined}
      aria-describedby={(toolCount === ""
        ? descriptionIds
        : [...descriptionIds, countId]
      ).join(" ")}
      aria-expanded={isExpanded}
      aria-labelledby={nameId}
      className="settings-view__mcp-toggle"
      onClick={() => onIsExpandedChange(!isExpanded)}
      type="button"
    >
      <ChevronRight aria-hidden="true" className="settings-view__mcp-chevron" />
      <span
        aria-hidden="true"
        className="settings-view__mcp-dot"
        data-condition={status.condition}
      />
      <span className="settings-view__mcp-lines">
        <McpServerTitle
          nameId={nameId}
          server={server}
          stateId={stateId}
          status={status}
          transportId={transportId}
        />
        <span className="settings-view__mcp-target" id={targetId}>
          {formatMcpServerTarget(server)}
        </span>
      </span>
      <span className="settings-view__mcp-count" id={countId}>
        {toolCount}
      </span>
    </button>
  )
}

/** Properties accepted by {@link McpServerRow}. */
type McpServerRowProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Lifecycle of the tool list. */
  readonly toolList: ToolListState
  /** Saved tool switches and approvals. */
  readonly toolSettings: ToolSettings
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Whether a save of the servers runs. */
  readonly isSaving: boolean
  /** Whether the server's details are shown. */
  readonly isExpanded: boolean
  /** Whether the Edit button takes focus when it is attached. */
  readonly isEditFocusedOnAttach: boolean
  /** Proposes showing or hiding the server's details. */
  readonly onIsExpandedChange: (isExpanded: boolean) => void
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
 * Presents one saved server: its summary, which shows or hides its details,
 * and the details while shown.
 *
 * @remarks The parent owns the settings, the lists, the choices about tools,
 * whether the details are shown, and every action; the row owns no state of
 * its own. The item is named by the server's name. The server's tools are
 * the listed tools of its connected server; the row counts those that are
 * on.
 * @param props - Server, lists, tool choices, backend status, the save,
 * expansion, focus, and the actions.
 * @returns One list item.
 */
function McpServerRow({
  server,
  list,
  toolList,
  toolSettings,
  isBackendRunning,
  isSaving,
  isExpanded,
  isEditFocusedOnAttach,
  onIsExpandedChange,
  onReconnect,
  onEdit,
  onRemove,
  onToolOnChange,
  onToolApprovalChange
}: McpServerRowProps): ReactElement {
  const nameId = useId()
  const detailsId = useId()
  const status = formatMcpServerStatus({ isBackendRunning, list, server })
  const tools = listMcpServerTools(toolList, server.name, status.condition)
  const skippedToolsState = findSkippedToolsState(list, server.name)
  const onCount = tools.filter((tool) =>
    isToolOn(toolSettings.switches, tool)
  ).length

  return (
    <li
      aria-labelledby={nameId}
      className="settings-view__mcp-row"
      data-expanded={isExpanded ? "" : undefined}
    >
      <McpServerToggle
        detailsId={detailsId}
        nameId={nameId}
        isExpanded={isExpanded}
        onIsExpandedChange={onIsExpandedChange}
        server={server}
        status={status}
        toolCount={formatMcpServerToolCount(onCount, tools.length)}
      />
      {isExpanded ? (
        <McpServerDetails
          detailsId={detailsId}
          isBackendRunning={isBackendRunning}
          isEditFocusedOnAttach={isEditFocusedOnAttach}
          isSaving={isSaving}
          onEdit={onEdit}
          onReconnect={onReconnect}
          onRemove={onRemove}
          onToolApprovalChange={onToolApprovalChange}
          onToolOnChange={onToolOnChange}
          server={server}
          skippedToolsState={skippedToolsState}
          status={status}
          toolSettings={toolSettings}
          toolList={toolList}
          tools={tools}
        />
      ) : null}
    </li>
  )
}

/** Properties accepted by {@link McpServerKindChoices}. */
type McpServerKindChoicesProps = {
  /** Requests that the parent open an editor for a new server of a transport. */
  readonly onAddServer: (transport: McpServerTransport) => void
}

/**
 * Says that no server is saved and offers adding a local program or a
 * remote server.
 *
 * @remarks The parent opens the editor; the component owns no state. Each
 * choice is a button named by its kind and tag, with an example of what
 * such a server runs or reaches, in the editor's order of transports.
 * @param props - The request to add a server.
 * @returns The empty state.
 */
function McpServerKindChoices({
  onAddServer
}: McpServerKindChoicesProps): ReactElement {
  return (
    <div className="settings-view__mcp-empty">
      <p>{MCP_EMPTY_LIST_NOTE}</p>
      <div className="settings-view__mcp-kinds">
        {MCP_SERVER_TRANSPORTS.map((transport) => (
          <McpServerKindChoice
            key={transport}
            onAddServer={onAddServer}
            transport={transport}
          />
        ))}
      </div>
    </div>
  )
}

/** Properties accepted by {@link McpServerKindChoice}. */
type McpServerKindChoiceProps = {
  /** Transport the choice adds a server of. */
  readonly transport: McpServerTransport
  /** Requests that the parent open an editor for a new server of a transport. */
  readonly onAddServer: (transport: McpServerTransport) => void
}

/**
 * Presents one kind of server to add, as a card button.
 *
 * @remarks The list owner supplies the key; the choice owns no state. The
 * card is named by the kind's name and described by its tag and example.
 * @param props - Transport and the request to add a server.
 * @returns The card button.
 */
function McpServerKindChoice({
  transport,
  onAddServer
}: McpServerKindChoiceProps): ReactElement {
  const presentation = getMcpTransportPresentation(transport)
  const nameId = useId()
  const tagId = useId()
  const exampleId = useId()

  return (
    <button
      aria-describedby={`${tagId} ${exampleId}`}
      aria-labelledby={nameId}
      className="settings-view__mcp-kind"
      onClick={() => onAddServer(transport)}
      type="button"
    >
      <span className="settings-view__mcp-title">
        <span className="settings-view__mcp-kind-name" id={nameId}>
          {presentation.name}
        </span>
        <span
          className="settings-view__mcp-transport-tag"
          data-transport={transport}
          id={tagId}
        >
          {presentation.tag}
        </span>
      </span>
      <span className="settings-view__mcp-target" id={exampleId}>
        {presentation.example}
      </span>
    </button>
  )
}

/**
 * Lists the tools of the connected servers.
 *
 * @param servers - Saved servers.
 * @param list - Lifecycle of the list of applied servers.
 * @param toolList - Lifecycle of the tool list.
 * @param isBackendRunning - Whether the backend is running.
 * @returns Every connected server's listed tools, or undefined while the
 * tool list is not read.
 */
function listConnectedMcpTools(
  servers: readonly McpServerSettings[],
  list: McpServerListState,
  toolList: ToolListState,
  isBackendRunning: boolean
): readonly McpToolDefinition[] | undefined {
  if (toolList.status !== "loaded") return undefined
  return servers.flatMap((server) => {
    const { condition } = formatMcpServerStatus({
      isBackendRunning,
      list,
      server
    })
    return listMcpServerTools(toolList, server.name, condition)
  })
}

/** Properties accepted by {@link McpServerListHeading}. */
type McpServerListHeadingProps = {
  /** Identifier the heading takes, which names the section. */
  readonly headingId: string
  /** What the servers are and cost, shown beside the heading. */
  readonly meta: string
  /** Whether Add server is disabled. */
  readonly isAddDisabled: boolean
  /** Add server host the parent moves focus to. */
  readonly addServerRef: RefObject<HTMLButtonElement | null>
  /** Requests that the parent open an editor for a new server of a transport. */
  readonly onAddServer: (transport: McpServerTransport) => void
}

/**
 * Presents the heading of the saved servers, its meta, and Add server.
 *
 * @remarks The parent owns every value and the host; the heading owns no
 * state. Add server opens the editor for a local program.
 * @param props - Heading identifier, meta, Add server's state and host, and
 * the add action.
 * @returns The heading line.
 */
function McpServerListHeading({
  headingId,
  meta,
  isAddDisabled,
  addServerRef,
  onAddServer
}: McpServerListHeadingProps): ReactElement {
  return (
    <div className="settings-view__mcp-heading">
      <span className="settings-view__mcp-heading-lines">
        <h2 id={headingId}>servers</h2>
        <span>{meta}</span>
      </span>
      <Button
        className="settings-view__mcp-add"
        disabled={isAddDisabled}
        onClick={() => onAddServer("stdio")}
        ref={addServerRef}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus aria-hidden="true" />
        Add server
      </Button>
    </div>
  )
}

/** Properties accepted by {@link McpServerRows}. */
type McpServerRowsProps = {
  /** Saved servers, in list order; at least one. */
  readonly servers: readonly McpServerSettings[]
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Lifecycle of the tool list. */
  readonly toolList: ToolListState
  /** Saved tool switches and approvals. */
  readonly toolSettings: ToolSettings
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Whether a save of the servers runs. */
  readonly isSaving: boolean
  /** Name of the server whose details are shown, or null when none is. */
  readonly expandedServerName: McpServerName | null
  /** Name of the server whose Edit button takes focus, or null. */
  readonly focusedServerName: McpServerName | null
  /** Proposes showing one server's details, or none with null. */
  readonly onExpandedServerNameChange: (
    serverName: McpServerName | null
  ) => void
  /** Requests that the parent connect one server again. */
  readonly onReconnectServer: (serverName: McpServerName) => void
  /** Requests that the parent open one saved server's editor. */
  readonly onEditServer: (server: McpServerSettings) => void
  /** Requests that the parent remove one server. */
  readonly onRemoveServer: (serverName: McpServerName) => void
  /** Proposes switching one tool on or off. */
  readonly onToolOnChange: (toolName: string, isOn: boolean) => void
  /** Proposes one approval for several tools. */
  readonly onToolApprovalChange: (
    toolNames: readonly string[],
    approval: ToolApproval
  ) => void
}

/**
 * Lists the saved servers, each with its row.
 *
 * @remarks The parent owns every value and action; the list owns no state.
 * Servers keep the saved order and are keyed by name; at most one shows its
 * details. The list is named MCP servers.
 * @param props - Servers, lists, tool choices, backend status, the save,
 * expansion, focus, and the parent-owned actions.
 * @returns The list of servers.
 */
function McpServerRows({
  servers,
  list,
  toolList,
  toolSettings,
  isBackendRunning,
  isSaving,
  expandedServerName,
  focusedServerName,
  onExpandedServerNameChange,
  onReconnectServer,
  onEditServer,
  onRemoveServer,
  onToolOnChange,
  onToolApprovalChange
}: McpServerRowsProps): ReactElement {
  return (
    <ul aria-label="MCP servers" className="settings-view__mcp-list">
      {servers.map((server) => (
        <McpServerRow
          isBackendRunning={isBackendRunning}
          isEditFocusedOnAttach={server.name === focusedServerName}
          isExpanded={server.name === expandedServerName}
          isSaving={isSaving}
          key={server.name}
          list={list}
          onEdit={() => onEditServer(server)}
          onIsExpandedChange={(isExpanded) =>
            onExpandedServerNameChange(isExpanded ? server.name : null)
          }
          onReconnect={() => onReconnectServer(server.name)}
          onRemove={() => onRemoveServer(server.name)}
          onToolApprovalChange={onToolApprovalChange}
          onToolOnChange={onToolOnChange}
          server={server}
          toolList={toolList}
          toolSettings={toolSettings}
        />
      ))}
    </ul>
  )
}

/** Properties accepted by {@link McpServerSection}. */
export type McpServerSectionProps = Omit<
  McpServerRowsProps,
  "focusedServerName"
> & {
  /** Control that takes focus when the section is attached. */
  readonly focusTarget: McpServerListFocusTarget
  /** Requests that the parent open an editor for a new server of a transport. */
  readonly onAddServer: (transport: McpServerTransport) => void
}

/**
 * Presents the saved servers and the action that adds one.
 *
 * @remarks The parent owns the servers, the lists, the tool choices, which
 * server's details are shown, the focus target, and every action; the
 * section owns no state. In the layout phase after it receives a new
 * request for Add server, it moves focus to Add server, also while it stays
 * mounted, as after a removal. The heading's meta says how many servers are
 * connected and what their tools that are on cost per request. Without
 * servers the section offers the two kinds of server instead of a list.
 * Add server, which adds a local program, is disabled once the most servers
 * the settings allow are saved, which a note then says, and while a save
 * runs. The section is named by its heading.
 * @param props - Servers, lists, tool choices, backend status, the save,
 * expansion, focus, and the parent-owned actions.
 * @returns The section of the saved servers.
 */
export function McpServerSection({
  focusTarget,
  onAddServer,
  ...rowsProps
}: McpServerSectionProps): ReactElement {
  const { servers, list, toolList, isBackendRunning } = rowsProps
  const headingId = useId()
  const addServerRef = useRef<HTMLButtonElement>(null)
  const meta = formatMcpServerListMeta({
    serverCount: servers.length,
    connectedCount: countConnectedMcpServers(servers, list, isBackendRunning),
    connectedTools: listConnectedMcpTools(
      servers,
      list,
      toolList,
      isBackendRunning
    ),
    toolSwitches: rowsProps.toolSettings.switches
  })

  useLayoutEffect(() => {
    if (focusTarget.kind === "add-server") addServerRef.current?.focus()
  }, [focusTarget])

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <McpServerListHeading
        addServerRef={addServerRef}
        headingId={headingId}
        isAddDisabled={rowsProps.isSaving || !canAddMcpServer(servers.length)}
        meta={meta}
        onAddServer={onAddServer}
      />
      {servers.length === 0 ? (
        <McpServerKindChoices onAddServer={onAddServer} />
      ) : (
        <McpServerRows
          {...rowsProps}
          focusedServerName={
            focusTarget.kind === "server" ? focusTarget.serverName : null
          }
        />
      )}
      {canAddMcpServer(servers.length) ? null : (
        <p className="settings-view__note">{MCP_SERVER_LIMIT_NOTE}</p>
      )}
    </section>
  )
}
