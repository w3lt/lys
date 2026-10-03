import type { AgentSummary } from "@lys/protocol"
import { useEffect, useState, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"
import { useAgentStore } from "@/lib/store/agents"

import { AgentEditor, AgentReadStatus } from "./AgentEditor"
import {
  AgentListStatus,
  BuiltInAgentSection,
  CustomAgentSection,
  type AgentListFocusTarget
} from "./AgentList"
import PaneSkeleton from "./PaneSkeleton"

/** Message shown instead of the agents while the backend is not running. */
const BACKEND_STOPPED_AGENTS_MESSAGE = "Start the backend to manage agents."

/** Shared focus target that leaves focus where it is. */
const NO_LIST_FOCUS_TARGET: AgentListFocusTarget = Object.freeze({
  kind: "none"
})

/** Shared focus target naming the New agent button. */
const NEW_AGENT_FOCUS_TARGET: AgentListFocusTarget = Object.freeze({
  kind: "new-agent"
})

/**
 * Calculates the list control that takes focus when the list returns from
 * an editor.
 *
 * @param returnTarget - Control recorded when the editor was opened; `none`
 * when no editor was opened since the pane appeared.
 * @param savedAgentCode - Code of the agent saved most recently, or null.
 * @param agents - Every listed agent.
 * @returns The saved agent's row, else the row of the agent that was opened,
 * else the New agent button when that row is gone or a new agent was being
 * written; `none` while no editor was opened.
 */
function calculateListFocusTarget(
  returnTarget: AgentListFocusTarget,
  savedAgentCode: string | null,
  agents: readonly AgentSummary[]
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
export type AgentWorkspaceProps = {
  /** Every stored agent, oldest first, as last read. */
  readonly agents: readonly AgentSummary[]
}

/**
 * Presents the agent list or the editor the agent store has open.
 *
 * @remarks Primary category: composition/view. The agent store owns the
 * editor, the saved marker, and every read and change; the parent supplies
 * the listed agents. The workspace owns only which list control takes focus
 * when the list returns from an editor it opened: the saved agent's row, the
 * opened agent's row, or the New agent button. While the editor is closed,
 * the built-in section, marked coming soon, precedes the user's agents.
 * Each agent's editor is a separate instance, keyed by its code or `new`.
 * @param props - Listed agents.
 * @returns The agent list, the read status of an agent being opened, or its
 * editor.
 */
export function AgentWorkspace({ agents }: AgentWorkspaceProps): ReactElement {
  const editor = useAgentStore((state) => state.editor)
  const savedAgentCode = useAgentStore((state) => state.savedAgentCode)
  const openAgent = useAgentStore((state) => state.openAgent)
  const openNewAgent = useAgentStore((state) => state.openNewAgent)
  const closeAgentEditor = useAgentStore((state) => state.closeAgentEditor)
  const [returnTarget, setReturnTarget] =
    useState<AgentListFocusTarget>(NO_LIST_FOCUS_TARGET)

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
    case "closed":
      return (
        <div className="settings-view__stack">
          <BuiltInAgentSection />
          <CustomAgentSection
            agents={agents}
            focusTarget={calculateListFocusTarget(
              returnTarget,
              savedAgentCode,
              agents
            )}
            onOpenAgent={handleOpenAgent}
            onOpenNewAgent={handleOpenNewAgent}
            savedAgentCode={savedAgentCode}
          />
        </div>
      )
    case "opening":
    case "unavailable":
      return (
        <AgentReadStatus
          editor={editor}
          key={editor.status}
          onCloseAgentEditor={closeAgentEditor}
          onRetryAgent={() => void openAgent(editor.agentCode)}
        />
      )
    case "creating":
      return <AgentEditor agents={agents} editor={editor} key="new" />
    case "editing":
      return (
        <AgentEditor agents={agents} editor={editor} key={editor.agent.code} />
      )
  }
}

/**
 * Presents agent management: the list of agents and the editor.
 *
 * @remarks Primary category: composition/view. The application store owns
 * the backend status and the agent store owns the list; the pane reads every
 * stored agent when it appears and whenever the backend starts running, and
 * leaving it cancels nothing. While the backend is not running the pane says
 * so; a first read shows the agents placeholder, and a failed read offers
 * Retry. A displayed list stays while it is read again. The pane accepts no
 * props and is loaded lazily by the settings view.
 * @returns The agents pane body.
 */
export default function AgentPane(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const list = useAgentStore((state) => state.list)
  const loadAgents = useAgentStore((state) => state.loadAgents)

  useEffect(() => {
    if (backendStatus === "running") void loadAgents()
  }, [backendStatus, loadAgents])

  if (backendStatus !== "running") {
    return <AgentListStatus message={BACKEND_STOPPED_AGENTS_MESSAGE} />
  }

  switch (list.status) {
    case "idle":
    case "loading":
      return <PaneSkeleton pane="agents" />
    case "failed":
      return (
        <AgentListStatus
          message={list.error}
          onRetryAgents={() => void loadAgents()}
        />
      )
    case "loaded":
      return <AgentWorkspace agents={list.agents} />
  }
}
