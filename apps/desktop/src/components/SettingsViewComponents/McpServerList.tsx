import type {
  BuiltInMcpServerName,
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
  type ReactNode,
  type RefObject
} from "react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { McpServerListState } from "@/lib/store/mcp-servers"
import type { ToolSettings } from "@/lib/store/settings"
import type { ToolApproval } from "@/lib/store/tool-settings"
import { isToolOn, type ToolListState } from "@/lib/store/tools"

import {
  McpAddedServerDetails,
  McpServerDetails,
  type ConnectedMcpServerState
} from "./McpServerDetails"
import { isDocumentFocusLost } from "./focus-target"
import {
  canAddMcpServer,
  canSwitchMcpServer,
  calculateConnectedMcpServerCount,
  findMcpServerStatus,
  formatMcpListedServerKey,
  formatMcpServerListMeta,
  formatMcpServerStatus,
  formatMcpServerTarget,
  formatMcpServerToolCount,
  getMcpListedServerName,
  getMcpListedServerTransport,
  getMcpTransportPresentation,
  isMcpListedServerOn,
  listMcpServerTools,
  MCP_EMPTY_LIST_NOTE,
  MCP_SERVER_LIMIT_NOTE,
  MCP_SERVER_TRANSPORTS,
  type McpListedServer,
  type McpServerStatusPresentation
} from "./mcp-presentation"

/** The panel each server Lys ships adds to its details, by name. */
type BuiltInMcpServerPanels = Readonly<Record<BuiltInMcpServerName, ReactNode>>

/**
 * Request that a control of the server list receive focus.
 *
 * @remarks Each request is a new object. A server's Edit button takes focus
 * when its details appear; Add server takes focus once for each request the
 * list receives while focus is lost, so asking again, as after a second
 * removal, moves focus again, while a rerender with the same request does
 * not, and a control that holds focus keeps it.
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
  /** The listed server. */
  readonly server: McpListedServer
  /** The server's state. */
  readonly status: McpServerStatusPresentation
  /** Identifier the name takes. */
  readonly nameId: string
  /** Identifier the built-in tag takes, for a server Lys ships. */
  readonly builtInTagId: string
  /** Identifier the transport tag takes. */
  readonly transportId: string
  /** Identifier the state takes. */
  readonly stateId: string
}

/**
 * Presents a server's name, a tag when Lys ships it, its transport tag,
 * and its state.
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
  builtInTagId,
  transportId,
  stateId
}: McpServerTitleProps): ReactElement {
  const transport = getMcpListedServerTransport(server)

  return (
    <span className="settings-view__mcp-title">
      <span className="settings-view__mcp-name" id={nameId}>
        {getMcpListedServerName(server)}
      </span>
      {server.kind === "built-in" ? (
        <span className="settings-view__mcp-built-in-tag" id={builtInTagId}>
          built-in
        </span>
      ) : null}
      <span
        className="settings-view__mcp-transport-tag"
        data-transport={transport}
        id={transportId}
      >
        {getMcpTransportPresentation(transport).tag}
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
  /** The listed server. */
  readonly server: McpListedServer
  /** The server's state. */
  readonly status: McpServerStatusPresentation
  /** Identifier of the name, which names the server's list item. */
  readonly nameId: string
  /** Identifier of the state, which also describes the server's switch. */
  readonly stateId: string
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
 * shown. It shows the server's name, a tag when Lys ships it, its transport
 * tag, a tag for a state other than connected, what it runs, reaches, or
 * does, and how many tools it lists; a dot shows the state by colour, and
 * the state's heading is also read out when no tag shows it. The toggle is
 * named by the server's name and described by the built-in tag when there
 * is one, the transport, the state, the target, and the tool count. Values
 * that can be secrets are never shown.
 * @param props - Server, state, name and state identifiers, tool count,
 * expansion, and the proposal.
 * @returns The toggle button.
 */
function McpServerToggle({
  server,
  status,
  nameId,
  stateId,
  toolCount,
  isExpanded,
  detailsId,
  onIsExpandedChange
}: McpServerToggleProps): ReactElement {
  const builtInTagId = useId()
  const transportId = useId()
  const targetId = useId()
  const countId = useId()
  const descriptionIds = [
    server.kind === "built-in" ? builtInTagId : undefined,
    transportId,
    stateId,
    targetId,
    toolCount === "" ? undefined : countId
  ].filter((id) => id !== undefined)

  return (
    <button
      aria-controls={isExpanded ? detailsId : undefined}
      aria-describedby={descriptionIds.join(" ")}
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
          builtInTagId={builtInTagId}
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

/** Properties accepted by {@link McpServerRowLine}. */
type McpServerRowLineProps = {
  /** The listed server. */
  readonly server: McpListedServer
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
  /** Whether a save of the servers runs, which disables the switch. */
  readonly isSaving: boolean
  /** Proposes showing or hiding the server's details. */
  readonly onIsExpandedChange: (isExpanded: boolean) => void
  /** Proposes switching the server on or off. */
  readonly onServerOnChange: (server: McpListedServer, isOn: boolean) => void
}

/**
 * Presents the line a server's row always shows: the toggle with the
 * server's summary, and the server's switch.
 *
 * @remarks The row owns every value and both proposals; the line owns no
 * state. The switch is named by the server's name followed by `on`,
 * described by the server's state, and disabled while a save runs or while
 * a server Lys ships cannot be switched on: while an added server has its
 * name, or while it lacks what it needs.
 * @param props - Server, state, identifiers, tool count, expansion, the
 * save, and the proposals.
 * @returns The toggle and the switch.
 */
function McpServerRowLine({
  server,
  status,
  nameId,
  toolCount,
  isExpanded,
  detailsId,
  isSaving,
  onIsExpandedChange,
  onServerOnChange
}: McpServerRowLineProps): ReactElement {
  const stateId = useId()

  return (
    <div className="settings-view__mcp-row-line">
      <McpServerToggle
        detailsId={detailsId}
        nameId={nameId}
        isExpanded={isExpanded}
        onIsExpandedChange={onIsExpandedChange}
        server={server}
        stateId={stateId}
        status={status}
        toolCount={toolCount}
      />
      <Switch
        aria-describedby={stateId}
        aria-label={`${getMcpListedServerName(server)} on`}
        checked={isMcpListedServerOn(server)}
        disabled={isSaving || !canSwitchMcpServer(server)}
        onCheckedChange={(isOn) => onServerOnChange(server, isOn)}
        size="lg"
      />
    </div>
  )
}

/** Properties accepted by {@link McpServerRow}. */
type McpServerRowProps = {
  /** The listed server. */
  readonly server: McpListedServer
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
  /** Proposes showing or hiding the server's details. */
  readonly onIsExpandedChange: (isExpanded: boolean) => void
  /** Proposes switching the server on or off. */
  readonly onServerOnChange: (server: McpListedServer, isOn: boolean) => void
  /** Requests that the parent connect the server again. */
  readonly onReconnect: () => void
  /** Proposes switching one tool on or off. */
  readonly onToolOnChange: (toolName: string, isOn: boolean) => void
  /** Proposes one approval for several tools. */
  readonly onToolApprovalChange: (
    toolNames: readonly string[],
    approval: ToolApproval
  ) => void
  /**
   * What the details end with: an added server's configuration and
   * actions, or the panel of a server Lys ships; mounted only while the
   * details are shown.
   */
  readonly children: ReactNode
}

/**
 * Presents one listed server: its line, whose toggle shows or hides its
 * details, and the details while shown.
 *
 * @remarks The parent owns the server, the lists, the choices about tools,
 * whether the details are shown, what they end with, and every action; the
 * row owns no state of its own. The item is named by the server's name.
 * The server's tools are the listed tools of its connected server; the row
 * counts those that are on.
 * @param props - Server, lists, tool choices, backend status, the save,
 * expansion, the actions, and what the details end with.
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
  onIsExpandedChange,
  onServerOnChange,
  onReconnect,
  onToolOnChange,
  onToolApprovalChange,
  children
}: McpServerRowProps): ReactElement {
  const nameId = useId()
  const detailsId = useId()
  const serverName = getMcpListedServerName(server)
  const status = formatMcpServerStatus({ isBackendRunning, list, server })
  const tools = listMcpServerTools(toolList, serverName, status.condition)
  const onCount = tools.filter((tool) =>
    isToolOn(toolSettings.switches, tool)
  ).length

  return (
    <li
      aria-labelledby={nameId}
      className="settings-view__mcp-row"
      data-expanded={isExpanded ? "" : undefined}
    >
      <McpServerRowLine
        detailsId={detailsId}
        isExpanded={isExpanded}
        isSaving={isSaving}
        nameId={nameId}
        onIsExpandedChange={onIsExpandedChange}
        onServerOnChange={onServerOnChange}
        server={server}
        status={status}
        toolCount={formatMcpServerToolCount(onCount, tools.length)}
      />
      {isExpanded ? (
        <McpServerDetails
          detailsId={detailsId}
          isBackendRunning={isBackendRunning}
          onReconnect={onReconnect}
          onToolApprovalChange={onToolApprovalChange}
          onToolOnChange={onToolOnChange}
          server={server}
          skippedToolsState={findSkippedToolsState(list, serverName)}
          status={status}
          toolSettings={toolSettings}
          toolList={toolList}
          tools={tools}
        >
          {children}
        </McpServerDetails>
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
 * Says that no server is added yet and offers adding a local program or a
 * remote server.
 *
 * @remarks The parent opens the editor; the component owns no state. Each
 * choice is a button named by its kind and tag, with an example of what
 * such a server runs or reaches, in the editor's order of transports.
 * @param props - The request to add a server.
 * @returns The note and the choices.
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

/** Facts the connected servers' tools are drawn from. */
type McpConnectedToolFacts = Pick<
  McpServerSectionProps,
  "servers" | "list" | "toolList" | "isBackendRunning"
>

/**
 * Lists the tools of the connected servers.
 *
 * @param facts - Listed servers, the lifecycles of the list of applied
 * servers and of the tool list, and whether the backend is running.
 * @returns Every connected server's listed tools, or undefined while the
 * tool list is not read.
 */
function listConnectedMcpTools(
  facts: McpConnectedToolFacts
): readonly McpToolDefinition[] | undefined {
  const { servers, list, toolList, isBackendRunning } = facts
  if (toolList.status !== "loaded") return undefined
  return servers.flatMap((server) => {
    const { condition } = formatMcpServerStatus({
      isBackendRunning,
      list,
      server
    })
    return listMcpServerTools(
      toolList,
      getMcpListedServerName(server),
      condition
    )
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
  /**
   * Listed servers: those Lys ships first, then the added ones in list
   * order; at least one.
   */
  readonly servers: readonly McpListedServer[]
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
  /**
   * Key of the server whose details are shown, by its kind and name, or
   * null when none is.
   */
  readonly expandedServerKey: string | null
  /** Name of the added server whose Edit button takes focus, or null. */
  readonly focusedServerName: McpServerName | null
  /** The panel each server Lys ships adds to its details. */
  readonly builtInPanels: BuiltInMcpServerPanels
  /** Proposes showing one server's details, by its key, or none with null. */
  readonly onExpandedServerKeyChange: (serverKey: string | null) => void
  /** Proposes switching one server on or off. */
  readonly onServerOnChange: (server: McpListedServer, isOn: boolean) => void
  /** Requests that the parent connect one server again. */
  readonly onReconnectServer: (serverName: McpServerName) => void
  /** Requests that the parent open one added server's editor. */
  readonly onEditServer: (server: McpServerSettings) => void
  /** Requests that the parent remove one added server. */
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
 * Lists the servers, each with its row.
 *
 * @remarks The parent owns every value and action; the list owns no state.
 * Servers keep the listed order and are keyed by kind and name, and the
 * details shown are those of the server with the chosen key, so a server
 * Lys ships and an added server with its name expand apart. An added server's
 * details end with its configuration and actions, whose Edit button takes
 * focus when the parent names the server; the details of a server Lys
 * ships end with its own panel. The list is named MCP servers.
 * @param props - Servers, lists, tool choices, backend status, the save,
 * expansion, focus, the panels, and the parent-owned actions.
 * @returns The list of servers.
 */
function McpServerRows({
  servers,
  list,
  toolList,
  toolSettings,
  isBackendRunning,
  isSaving,
  expandedServerKey,
  focusedServerName,
  builtInPanels,
  onExpandedServerKeyChange,
  onServerOnChange,
  onReconnectServer,
  onEditServer,
  onRemoveServer,
  onToolOnChange,
  onToolApprovalChange
}: McpServerRowsProps): ReactElement {
  /**
   * Builds what one server's details end with.
   *
   * @param server - The listed server.
   * @returns An added server's configuration and actions, or the panel of
   * a server Lys ships.
   */
  function buildServerPanel(server: McpListedServer): ReactNode {
    if (server.kind === "built-in") return builtInPanels[server.name]
    return (
      <McpAddedServerDetails
        isEditFocusedOnAttach={server.settings.name === focusedServerName}
        isSaving={isSaving}
        onEdit={() => onEditServer(server.settings)}
        onRemove={() => onRemoveServer(server.settings.name)}
        server={server.settings}
      />
    )
  }

  /**
   * Builds one server's row.
   *
   * @param server - The listed server.
   * @returns The row, keyed by the server's kind and name.
   */
  function buildServerRow(server: McpListedServer): ReactElement {
    const serverName = getMcpListedServerName(server)
    const serverKey = formatMcpListedServerKey(server.kind, serverName)
    return (
      <McpServerRow
        isBackendRunning={isBackendRunning}
        isExpanded={serverKey === expandedServerKey}
        isSaving={isSaving}
        key={serverKey}
        list={list}
        onIsExpandedChange={(isExpanded) =>
          onExpandedServerKeyChange(isExpanded ? serverKey : null)
        }
        onReconnect={() => onReconnectServer(serverName)}
        onServerOnChange={onServerOnChange}
        onToolApprovalChange={onToolApprovalChange}
        onToolOnChange={onToolOnChange}
        server={server}
        toolList={toolList}
        toolSettings={toolSettings}
      >
        {buildServerPanel(server)}
      </McpServerRow>
    )
  }

  return (
    <ul aria-label="MCP servers" className="settings-view__mcp-list">
      {servers.map(buildServerRow)}
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

/** Facts the meta line of the servers is drawn from. */
type McpServerSectionMetaFacts = Pick<
  McpServerSectionProps,
  "servers" | "list" | "toolList" | "toolSettings" | "isBackendRunning"
>

/**
 * Formats the meta line beside the heading of the servers.
 *
 * @param facts - Servers, lists, tool choices, and backend status.
 * @returns How many servers are listed and connected, and what their tools
 * that are on cost per request.
 */
function formatMcpServerSectionMeta(facts: McpServerSectionMetaFacts): string {
  const { servers, list, toolSettings, isBackendRunning } = facts
  return formatMcpServerListMeta({
    serverCount: servers.length,
    connectedCount: calculateConnectedMcpServerCount(
      servers,
      list,
      isBackendRunning
    ),
    connectedTools: listConnectedMcpTools(facts),
    toolSwitches: toolSettings.switches
  })
}

/**
 * Moves focus to Add server for each new request for it while focus is
 * lost.
 *
 * @remarks Runs in the layout phase after the request changes, so focus
 * moves before the browser paints, also while the section stays mounted, as
 * after a removal. A rerender with the same request moves nothing, a
 * control that still holds focus keeps it, and a request while Add server
 * is not attached moves nothing. The hook owns the ref, which React sets to
 * the attached button.
 * @param focusTarget - Control that takes focus; reactive, and each new
 * request object is a new request.
 * @returns The ref to attach to Add server, stable for the section's
 * lifetime.
 */
function useAddServerFocus(
  focusTarget: McpServerListFocusTarget
): RefObject<HTMLButtonElement | null> {
  const addServerRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (focusTarget.kind === "add-server" && isDocumentFocusLost()) {
      addServerRef.current?.focus()
    }
  }, [focusTarget])

  return addServerRef
}

/**
 * Presents the servers Lys ships and the added servers, and the action
 * that adds one.
 *
 * @remarks The parent owns the servers, the lists, the tool choices, which
 * server's details are shown, the focus target, the panels, and every
 * action; the section owns no state. In the
 * layout phase after it receives a new request for Add server, it moves
 * focus to Add server while focus is lost, as after the focused row was
 * removed, also while it stays mounted; it never takes focus from a control
 * that still holds it, such as another server's toggle the person moved to
 * while a removal was saved. The heading's meta says how many servers are
 * listed and connected and what their tools that are on cost per request.
 * While no server is added, the section offers the two kinds of server
 * under the list. Add server, which adds a local program, is disabled once
 * the most added servers the settings allow are saved, which a note then
 * says, and while a save runs. The section is named by its heading.
 * @param props - Servers, lists, tool choices, backend status, the save,
 * expansion, focus, the panels, and the parent-owned actions.
 * @returns The section of the servers.
 */
export function McpServerSection({
  servers,
  list,
  toolList,
  toolSettings,
  isBackendRunning,
  isSaving,
  expandedServerKey,
  focusTarget,
  builtInPanels,
  onAddServer,
  onExpandedServerKeyChange,
  onServerOnChange,
  onReconnectServer,
  onEditServer,
  onRemoveServer,
  onToolOnChange,
  onToolApprovalChange
}: McpServerSectionProps): ReactElement {
  const headingId = useId()
  const addServerRef = useAddServerFocus(focusTarget)
  const addedCount = servers.filter((server) => server.kind === "added").length
  const meta = formatMcpServerSectionMeta({
    servers,
    list,
    toolList,
    toolSettings,
    isBackendRunning
  })

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <McpServerListHeading
        addServerRef={addServerRef}
        headingId={headingId}
        isAddDisabled={isSaving || !canAddMcpServer(addedCount)}
        meta={meta}
        onAddServer={onAddServer}
      />
      <McpServerRows
        builtInPanels={builtInPanels}
        expandedServerKey={expandedServerKey}
        focusedServerName={
          focusTarget.kind === "server" ? focusTarget.serverName : null
        }
        isBackendRunning={isBackendRunning}
        isSaving={isSaving}
        list={list}
        onEditServer={onEditServer}
        onExpandedServerKeyChange={onExpandedServerKeyChange}
        onReconnectServer={onReconnectServer}
        onRemoveServer={onRemoveServer}
        onServerOnChange={onServerOnChange}
        onToolApprovalChange={onToolApprovalChange}
        onToolOnChange={onToolOnChange}
        servers={servers}
        toolList={toolList}
        toolSettings={toolSettings}
      />
      {addedCount === 0 ? (
        <McpServerKindChoices onAddServer={onAddServer} />
      ) : null}
      {canAddMcpServer(addedCount) ? null : (
        <p className="settings-view__note">{MCP_SERVER_LIMIT_NOTE}</p>
      )}
    </section>
  )
}
