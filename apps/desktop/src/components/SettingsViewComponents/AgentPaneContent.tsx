import type { AgentSummary, BuiltInAgentSummary } from "@lys/protocol"
import { useEffect, useState, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"
import {
  useAgentStore,
  type AgentEditorState,
  type AgentListState,
  type ListedAgentIdentity
} from "@/lib/store/agents"

import { AgentEditor, AgentReadStatus } from "./AgentEditor"
import {
  AgentListStatus,
  BuiltInAgentSection,
  CustomAgentSection,
  type AgentListFocusTarget
} from "./AgentList"
import { formatAgentListStatus } from "./agent-presentation"
import BuiltInAgentView from "./BuiltInAgentView"
import PaneSkeleton from "./PaneSkeleton"

/** Shared focus target naming the New agent button. */
const NEW_AGENT_FOCUS_TARGET: AgentListFocusTarget = Object.freeze({
  kind: "new-agent"
})

/**
 * Calculates the list control that takes focus when the list returns from
 * the editor that is open when the workspace appears.
 *
 * @param editor - Editor the agent store has open.
 * @returns The row of the agent being read, viewed, or edited, the New agent
 * button for a new agent, or `none` while no editor is open.
 */
function calculateEditorReturnTarget(
  editor: AgentEditorState
): AgentListFocusTarget {
  switch (editor.status) {
    case "closed":
      return { kind: "none" }
    case "opening":
    case "unavailable":
      return { kind: "agent", agentCode: editor.agentCode }
    case "creating":
      return NEW_AGENT_FOCUS_TARGET
    case "viewing":
    case "editing":
      return { kind: "agent", agentCode: editor.agent.code }
  }
}

/**
 * Calculates the list control that takes focus when the list returns from
 * an editor.
 *
 * @param returnTarget - Control recorded when the editor was opened; `none`
 * when no editor was opened since the pane appeared.
 * @param savedAgentCode - Code of the agent saved most recently, or null.
 * @param agents - Every listed agent, built-in or the user's own.
 * @returns The saved agent's row, else the row of the agent that was opened,
 * else the New agent button when that row is gone or a new agent was being
 * written; `none` while no editor was opened.
 */
function calculateListFocusTarget(
  returnTarget: AgentListFocusTarget,
  savedAgentCode: string | null,
  agents: readonly ListedAgentIdentity[]
): AgentListFocusTarget {
  if (returnTarget.kind === "none") return returnTarget

  const openedAgentCode =
    returnTarget.kind === "agent" ? returnTarget.agentCode : null
  const focusedAgentCode = savedAgentCode ?? openedAgentCode
  const isFocusedAgentListed = agents.some(
    (agent) => agent.code === focusedAgentCode
  )
  return isFocusedAgentListed && focusedAgentCode !== null
    ? { kind: "agent", agentCode: focusedAgentCode }
    : NEW_AGENT_FOCUS_TARGET
}

/** Properties accepted by {@link AgentWorkspace}. */
type AgentWorkspaceProps = {
  /** Every built-in agent, in shipped order, as last read. */
  readonly builtInAgents: readonly BuiltInAgentSummary[]
  /** Every stored agent, oldest first, as last read. */
  readonly agents: readonly AgentSummary[]
}

/**
 * Presents the agent list or the editor the agent store has open.
 *
 * @remarks The agent store owns the editor, the saved marker, and every read
 * and change; the parent supplies the listed agents. A built-in agent opens
 * in a read-only view, and a stored one in its editor; drafts are checked
 * against the names and codes of both kinds. The workspace owns only
 * which list control takes focus when the list returns from an editor: the
 * saved agent's row, the opened agent's row, or the New agent button. It
 * records that control when it opens an editor, and when it appears with an
 * editor already open, as after the pane was left and entered again, it
 * starts from that editor's agent. Each agent's editor is a separate
 * instance, keyed by its code; the new agent's editor is keyed `:new`, which
 * no code can take because codes never contain `:`.
 * @param props - Listed agents.
 * @returns The agent list, the read status of an agent being opened, its
 * read-only view, or its editor.
 */
function AgentWorkspace({
  builtInAgents,
  agents
}: AgentWorkspaceProps): ReactElement {
  const editor = useAgentStore((state) => state.editor)
  const savedAgentCode = useAgentStore((state) => state.savedAgentCode)
  const openAgent = useAgentStore((state) => state.openAgent)
  const openNewAgent = useAgentStore((state) => state.openNewAgent)
  const openAgentCopy = useAgentStore((state) => state.openAgentCopy)
  const closeAgentEditor = useAgentStore((state) => state.closeAgentEditor)
  const [returnTarget, setReturnTarget] = useState(() =>
    calculateEditorReturnTarget(editor)
  )
  const listedAgents: readonly ListedAgentIdentity[] = [
    ...builtInAgents,
    ...agents
  ]

  /**
   * Opens one agent's editor, recording its row as the return target.
   *
   * @param agentCode - Code of the agent to open.
   */
  function handleOpenAgent(agentCode: string): void {
    setReturnTarget({ kind: "agent", agentCode })
    void openAgent(agentCode)
  }

  /** Opens a new agent's editor, recording New agent as the return target. */
  function handleOpenNewAgent(): void {
    setReturnTarget(NEW_AGENT_FOCUS_TARGET)
    openNewAgent()
  }

  switch (editor.status) {
    case "closed": {
      const focusTarget = calculateListFocusTarget(
        returnTarget,
        savedAgentCode,
        listedAgents
      )

      return (
        <div className="settings-view__stack">
          <BuiltInAgentSection
            agents={builtInAgents}
            focusTarget={focusTarget}
            onOpenAgent={handleOpenAgent}
          />
          <CustomAgentSection
            agents={agents}
            focusTarget={focusTarget}
            onOpenAgent={handleOpenAgent}
            onOpenNewAgent={handleOpenNewAgent}
            savedAgentCode={savedAgentCode}
          />
        </div>
      )
    }
    case "opening":
    case "unavailable":
      return (
        <AgentReadStatus
          editor={editor}
          key={editor.agentCode}
          onCloseAgentEditor={closeAgentEditor}
          onRetryAgent={() => void openAgent(editor.agentCode)}
        />
      )
    case "viewing":
      return (
        <BuiltInAgentView
          agent={editor.agent}
          key={editor.agent.code}
          onCloseAgentView={closeAgentEditor}
          onDuplicateAgent={openAgentCopy}
        />
      )
    case "creating":
      return <AgentEditor agents={listedAgents} editor={editor} key=":new" />
    case "editing":
      return (
        <AgentEditor
          agents={listedAgents}
          editor={editor}
          key={editor.agent.code}
        />
      )
  }
}

/** Properties accepted by {@link AgentListBody}. */
type AgentListBodyProps = {
  /** Lifecycle of the list of every agent, owned by the agent store. */
  readonly list: AgentListState
}

/**
 * Presents the agents once they are read.
 *
 * @remarks The parent owns the list state and says why the agents are not
 * shown; the component owns no state or effects. While the first read is
 * pending, the agents placeholder stands in. A read list shows the
 * workspace, which stays while the list is read again. After a failed read
 * nothing is rendered here.
 * @param props - List state.
 * @returns The placeholder, the workspace, or null after a failed read.
 */
function AgentListBody({ list }: AgentListBodyProps): ReactElement | null {
  switch (list.status) {
    case "idle":
    case "loading":
      return <PaneSkeleton pane="agents" />
    case "failed":
      return null
    case "loaded":
      return (
        <AgentWorkspace
          agents={list.agents}
          builtInAgents={list.builtInAgents}
        />
      )
  }
}

/**
 * Presents agent management: the list of agents and the editor.
 *
 * @remarks The application store owns the backend status and the agent store
 * owns the list; the pane reads every built-in and stored agent when it
 * appears and
 * whenever the backend starts running, and leaving it cancels nothing. A
 * status line stays mounted above the agents: while the backend is not
 * running it says so instead of showing them, and after a failed read it
 * shows the failure and offers Retry. A first read shows the agents
 * placeholder, and a displayed list stays while it is read again. The pane
 * accepts no props and is loaded lazily by the settings view.
 * @returns The agents pane body.
 */
export default function AgentPane(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const list = useAgentStore((state) => state.list)
  const loadAgents = useAgentStore((state) => state.loadAgents)
  const isBackendRunning = backendStatus === "running"

  useEffect(() => {
    if (backendStatus === "running") void loadAgents()
  }, [backendStatus, loadAgents])

  return (
    <div className="settings-view__agent-pane">
      <AgentListStatus
        message={formatAgentListStatus(isBackendRunning, list)}
        onRetryAgents={
          isBackendRunning && list.status === "failed"
            ? () => void loadAgents()
            : undefined
        }
      />
      {isBackendRunning ? <AgentListBody list={list} /> : null}
    </div>
  )
}
