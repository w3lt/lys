import { ARMITAGE_AGENT_CODE } from "@lys/share"

/**
 * Role of an agent: `leader` for the built-in agents that answer chats, which
 * see every agent and give work to other agents; `member` for the stored
 * agents, which see only themselves and take that work; and `tool-keeper`
 * for Armitage, which searches tools and sees no agent.
 */
export type AgentRole = "leader" | "member" | "tool-keeper"

/**
 * What an agent may learn about agents and do with them: `read-own-state`
 * read its own state, `find-agents` learn which agents exist,
 * `read-any-state` read another agent's state, `delegate-work` give work to
 * another agent, and `take-work` be given work by one.
 */
export type AgentPermission =
  | "read-own-state"
  | "find-agents"
  | "read-any-state"
  | "delegate-work"
  | "take-work"

/** What decides an agent's role: its code and its kind. */
export type AgentRoleSource = Readonly<{
  /** Code of the agent. */
  code: string
  /** Whether the agent ships with the backend or was stored. */
  kind: "built-in" | "custom"
}>

/** Who an agent is when it asks about agents: its code and its role. */
export type AgentIdentity = Readonly<{
  /** Code of the agent that asks. */
  code: string
  /** Role that decides what it may learn. */
  role: AgentRole
}>

/**
 * Permissions of a leader: its own state, which agents exist, and theirs,
 * and giving work to other agents.
 */
const LEADER_PERMISSIONS: readonly AgentPermission[] = Object.freeze([
  "read-own-state",
  "find-agents",
  "read-any-state",
  "delegate-work"
])

/** Permissions of a member: its own state, and being given work. */
const MEMBER_PERMISSIONS: readonly AgentPermission[] = Object.freeze([
  "read-own-state",
  "take-work"
])

/** Permissions of the tool keeper: none. */
const TOOL_KEEPER_PERMISSIONS: readonly AgentPermission[] = Object.freeze([])

/**
 * Permissions of each role; the tools an agent is offered and every check of
 * a state read or an agent search follow them.
 */
const AGENT_ROLE_PERMISSIONS: Readonly<
  Record<AgentRole, readonly AgentPermission[]>
> = Object.freeze({
  leader: LEADER_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  "tool-keeper": TOOL_KEEPER_PERMISSIONS
})

/**
 * Finds the role of an agent from its code and kind.
 * @param agent - Code and kind of the agent.
 * @returns `tool-keeper` for the built-in Armitage, `leader` for every other
 * built-in agent, and `member` for a stored one, whatever its code.
 */
export function calculateAgentRole(agent: AgentRoleSource): AgentRole {
  if (agent.kind === "custom") return "member"
  return agent.code === ARMITAGE_AGENT_CODE ? "tool-keeper" : "leader"
}

/**
 * Tells whether a role grants a permission.
 * @param role - Role of the agent that asks.
 * @param permission - What it asks to do.
 * @returns True when the role's permissions include the permission.
 */
export function hasAgentPermission(
  role: AgentRole,
  permission: AgentPermission
): boolean {
  return AGENT_ROLE_PERMISSIONS[role].includes(permission)
}
