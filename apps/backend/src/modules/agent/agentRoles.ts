import { ARMITAGE_AGENT_CODE } from "@lys/share"

/**
 * Role of an agent: `leader` for the built-in agents that answer chats, which
 * see every agent; `member` for the stored agents, which see only
 * themselves; and `tool-keeper` for Armitage, which searches tools and sees
 * no agent.
 */
export type AgentRole = "leader" | "member" | "tool-keeper"

/**
 * What an agent may learn about agents: `read-own-state` its own state,
 * `find-agents` which agents exist, and `read-any-state` another agent's
 * state.
 */
export type AgentPermission =
  "read-own-state" | "find-agents" | "read-any-state"

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
 * Permissions of each role; the tools an agent is offered and every check of
 * a state read or an agent search follow them.
 */
const AGENT_ROLE_PERMISSIONS: Readonly<
  Record<AgentRole, readonly AgentPermission[]>
> = Object.freeze({
  leader: Object.freeze<AgentPermission[]>([
    "read-own-state",
    "find-agents",
    "read-any-state"
  ]),
  member: Object.freeze<AgentPermission[]>(["read-own-state"]),
  "tool-keeper": Object.freeze<AgentPermission[]>([])
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
 * @returns True when {@link AGENT_ROLE_PERMISSIONS} lists the permission for
 * the role.
 */
export function hasAgentPermission(
  role: AgentRole,
  permission: AgentPermission
): boolean {
  return AGENT_ROLE_PERMISSIONS[role].includes(permission)
}
