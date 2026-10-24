import type { McpServerState, SkippedMcpTool } from "@lys/protocol"
import type { McpServerName, McpServerSettings } from "@lys/share"
import { ChevronRight, Plus } from "lucide-react"
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from "react"

import { Button } from "@/components/ui/button"
import type { McpServerListState } from "@/lib/store/mcp-servers"

import {
  canAddMcpServer,
  findMcpServerStatus,
  formatMcpServerCount,
  formatMcpServerRowState,
  formatMcpServerTarget,
  formatMcpServerTransportLabel,
  formatSkippedMcpToolName,
  formatSkippedMcpToolReason,
  listSkippedMcpTools,
  MCP_TOOL_LIST_CUT_NOTE
} from "./mcp-presentation"

/**
 * Request that a control of the server list receive focus.
 *
 * @remarks Each request is a new object. A server's Edit button takes focus
 * when its row appears; Add server takes focus once for each request the
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

/** Connected state of a server whose skipped tools a row can list. */
type ConnectedMcpServerState = Extract<
  McpServerState,
  { readonly status: "connected" }
>

/**
 * Handles the attachment of an element that takes focus when it appears, by
 * focusing it.
 *
 * @param element - Attached element, or null when React detaches it, which
 * is ignored.
 */
function handleFocusTargetAttach(element: HTMLElement | null): void {
  element?.focus()
}

/**
 * Finds the connected state of a server whose row lists skipped tools.
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

/** Properties accepted by {@link McpSkippedTools}. */
type McpSkippedToolsProps = {
  /** Name of the server, which the toggle's name ends with. */
  readonly serverName: McpServerName
  /** Connected state whose skipped tools are listed. */
  readonly state: ConnectedMcpServerState
}

/**
 * Lets the person show which tools of a connected server the backend does
 * not list, and why.
 *
 * @remarks The component owns only whether the list is shown, which starts
 * hidden. The toggle is named `Skipped tools of <server>`, so each row's is
 * distinct, and exposes its state through `aria-expanded`. Each skipped
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

/** Properties accepted by {@link McpServerRemoveConfirmation}. */
type McpServerRemoveConfirmationProps = {
  /** Name of the server to remove. */
  readonly serverName: McpServerName
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
 * state. The question is a group named `Remove <server>?`; its choices are
 * named `Keep <server>` and `Remove <server>`. Focus starts on Keep, the
 * least destructive choice, and Escape on either choice keeps the server.
 * While a save runs, both choices are disabled.
 * @param props - Server, the save, and the parent-owned choices.
 * @returns The confirmation group.
 */
function McpServerRemoveConfirmation({
  serverName,
  isSaving,
  onKeep,
  onRemove
}: McpServerRemoveConfirmationProps): ReactElement {
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
      aria-label={`Remove ${serverName}?`}
      className="settings-view__mcp-confirm"
      disabled={isSaving}
    >
      <span aria-hidden="true">remove?</span>
      <Button
        aria-label={`Keep ${serverName}`}
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
        aria-label={`Remove ${serverName}`}
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

/** Properties accepted by {@link McpServerActions}. */
type McpServerActionsProps = {
  /** Name of the server the actions concern. */
  readonly serverName: McpServerName
  /** Whether the backend is running, which Reconnect needs. */
  readonly isBackendRunning: boolean
  /** Whether a save of the servers runs, which disables Edit and Remove. */
  readonly isSaving: boolean
  /** Whether the Edit button takes focus when it is attached. */
  readonly isEditFocusedOnAttach: boolean
  /** Requests that the parent reconnect the server. */
  readonly onReconnect: () => void
  /** Requests that the parent open the server's editor. */
  readonly onEdit: () => void
  /** Requests that the parent remove the server, after the person confirmed. */
  readonly onRemove: () => void
}

/**
 * Offers reconnecting, editing, and removing one server, confirming removal
 * first.
 *
 * @remarks The parent owns every action; the component owns only whether
 * removal is being confirmed, and whether focus must come back to Remove
 * when the confirmation leaves. Each button is named by its text and the
 * server, such as `Edit <server>`, so the rows' buttons are distinct.
 * Reconnect is disabled while the backend is not running; Edit and Remove
 * while a save of the servers runs.
 * @param props - Server, backend status, the save, focus, and the actions.
 * @returns The row's actions, or the removal confirmation.
 */
function McpServerActions({
  serverName,
  isBackendRunning,
  isSaving,
  isEditFocusedOnAttach,
  onReconnect,
  onEdit,
  onRemove
}: McpServerActionsProps): ReactElement {
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false)
  const [hasConfirmationOpened, setHasConfirmationOpened] = useState(false)

  /** Asks whether to remove, remembering that focus must come back. */
  function handleRequestRemoval(): void {
    setHasConfirmationOpened(true)
    setIsConfirmingRemoval(true)
  }

  if (isConfirmingRemoval) {
    return (
      <McpServerRemoveConfirmation
        isSaving={isSaving}
        onKeep={() => setIsConfirmingRemoval(false)}
        onRemove={onRemove}
        serverName={serverName}
      />
    )
  }

  return (
    <div className="settings-view__mcp-actions">
      <Button
        aria-label={`Reconnect ${serverName}`}
        disabled={!isBackendRunning}
        onClick={onReconnect}
        size="sm"
        type="button"
        variant="outline"
      >
        Reconnect
      </Button>
      <Button
        aria-label={`Edit ${serverName}`}
        disabled={isSaving}
        onClick={onEdit}
        ref={isEditFocusedOnAttach ? handleFocusTargetAttach : undefined}
        size="sm"
        type="button"
        variant="outline"
      >
        Edit
      </Button>
      <Button
        aria-label={`Remove ${serverName}`}
        disabled={isSaving}
        onClick={handleRequestRemoval}
        ref={hasConfirmationOpened ? handleFocusTargetAttach : undefined}
        size="sm"
        type="button"
        variant="destructive"
      >
        Remove
      </Button>
    </div>
  )
}

/** Properties accepted by {@link McpServerRow}. */
type McpServerRowProps = {
  /** Saved settings of the server. */
  readonly server: McpServerSettings
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Whether a save of the servers runs. */
  readonly isSaving: boolean
  /** Whether the Edit button takes focus when it is attached. */
  readonly isEditFocusedOnAttach: boolean
  /** Requests that the parent reconnect the server. */
  readonly onReconnect: () => void
  /** Requests that the parent open the server's editor. */
  readonly onEdit: () => void
  /** Requests that the parent remove the server. */
  readonly onRemove: () => void
}

/**
 * Presents one saved server: its name, how Lys reaches it, what it runs or
 * reaches, its state, and its actions.
 *
 * @remarks The parent owns the settings, the list, and every action; the row
 * owns no state of its own. The item is named by the server's name. The
 * state line shows the backend's state of the server while the backend runs
 * and its list is loaded. It is the server's own polite, atomic status,
 * mounted with the row and empty while there is no state, so each change of
 * the state, such as the outcome of a save or a reconnect, is announced once,
 * after the server's name, which only assistive technology reads; the state
 * the row appears with is not announced. A connected server whose tools the
 * backend skipped lets the person list them.
 * @param props - Server, list, backend status, the save, focus, and actions.
 * @returns One list item.
 */
function McpServerRow({
  server,
  list,
  isBackendRunning,
  isSaving,
  isEditFocusedOnAttach,
  onReconnect,
  onEdit,
  onRemove
}: McpServerRowProps): ReactElement {
  const nameId = useId()
  const state = formatMcpServerRowState({
    isBackendRunning,
    list,
    serverName: server.name
  })
  const skippedToolsState = findSkippedToolsState(list, server.name)

  return (
    <li aria-labelledby={nameId} className="settings-view__mcp-row">
      <div className="settings-view__mcp-row-main">
        <div className="settings-view__mcp-lines">
          <span className="settings-view__mcp-title">
            <span className="settings-view__mcp-name" id={nameId}>
              {server.name}
            </span>
            <span className="settings-view__mcp-kind">
              {formatMcpServerTransportLabel(server.transport)}
            </span>
          </span>
          <span className="settings-view__mcp-target">
            {formatMcpServerTarget(server)}
          </span>
          <span
            aria-atomic="true"
            aria-live="polite"
            className="settings-view__mcp-state"
            data-tone={state.tone}
            role="status"
          >
            {state.text === "" ? null : (
              <>
                <span className="sr-only">{server.name}: </span>
                {state.text}
              </>
            )}
          </span>
        </div>
        <McpServerActions
          isBackendRunning={isBackendRunning}
          isEditFocusedOnAttach={isEditFocusedOnAttach}
          isSaving={isSaving}
          onEdit={onEdit}
          onReconnect={onReconnect}
          onRemove={onRemove}
          serverName={server.name}
        />
      </div>
      {skippedToolsState === undefined ? null : (
        <McpSkippedTools serverName={server.name} state={skippedToolsState} />
      )}
    </li>
  )
}

/** Properties accepted by {@link McpServerSection}. */
export type McpServerSectionProps = {
  /** Saved servers, in list order. */
  readonly servers: readonly McpServerSettings[]
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Whether a save of the servers runs. */
  readonly isSaving: boolean
  /** Control that takes focus when the section is attached. */
  readonly focusTarget: McpServerListFocusTarget
  /** Requests that the parent open an editor for a new server. */
  readonly onAddServer: () => void
  /** Requests that the parent reconnect one server. */
  readonly onReconnectServer: (serverName: McpServerName) => void
  /** Requests that the parent open one server's editor. */
  readonly onEditServer: (serverName: McpServerName) => void
  /** Requests that the parent remove one server. */
  readonly onRemoveServer: (serverName: McpServerName) => void
}

/**
 * Presents the saved servers and the action that adds one.
 *
 * @remarks The parent owns the servers, the list, the focus target, and
 * every action; the section owns no state. In the layout phase after it
 * receives a new request for Add server, it moves focus to Add server, also
 * while it stays mounted, as after a removal. Servers keep the saved order and
 * are keyed by name. Without servers the section says so instead of showing
 * a list. Add server is disabled once the most servers the settings allow
 * are saved, and while a save runs. The section is named by its heading,
 * and the list is named MCP servers.
 * @param props - Servers, list, backend status, the save, focus, and the
 * parent-owned actions.
 * @returns The section of the saved servers.
 */
export function McpServerSection({
  servers,
  list,
  isBackendRunning,
  isSaving,
  focusTarget,
  onAddServer,
  onReconnectServer,
  onEditServer,
  onRemoveServer
}: McpServerSectionProps): ReactElement {
  const headingId = useId()
  const addServerRef = useRef<HTMLButtonElement>(null)
  const focusedServerName =
    focusTarget.kind === "server" ? focusTarget.serverName : null

  useLayoutEffect(() => {
    if (focusTarget.kind === "add-server") addServerRef.current?.focus()
  }, [focusTarget])

  /**
   * Builds the row of one saved server.
   *
   * @param server - Saved server.
   * @returns The server's row, keyed by its name.
   */
  function buildServerRow(server: McpServerSettings): ReactElement {
    return (
      <McpServerRow
        isBackendRunning={isBackendRunning}
        isEditFocusedOnAttach={server.name === focusedServerName}
        isSaving={isSaving}
        key={server.name}
        list={list}
        onEdit={() => onEditServer(server.name)}
        onReconnect={() => onReconnectServer(server.name)}
        onRemove={() => onRemoveServer(server.name)}
        server={server}
      />
    )
  }

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>servers</h2>
        <div className="settings-view__mcp-tools">
          <span>{formatMcpServerCount(servers.length)}</span>
          <Button
            disabled={isSaving || !canAddMcpServer(servers.length)}
            onClick={onAddServer}
            ref={addServerRef}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" />
            Add server
          </Button>
        </div>
      </div>
      {servers.length === 0 ? (
        <p className="settings-view__note">
          No MCP servers yet. Add one to give the agents its tools.
        </p>
      ) : (
        <ul aria-label="MCP servers" className="settings-view__mcp-list">
          {servers.map(buildServerRow)}
        </ul>
      )}
    </section>
  )
}
