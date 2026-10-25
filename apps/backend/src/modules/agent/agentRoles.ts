/**
 * Role of an agent: `leader` for the built-in agents, which see every agent,
 * and `member` for the stored agents, which see only themselves.
 */
export type AgentRole = "leader" | "member"

/**
 * What an agent may learn about agents: `read-own-state` its own state,
 * `find-agents` which agents exist, and `read-any-state` another agent's
 * state.
 */
export type AgentPermission =
  "read-own-state" | "find-agents" | "read-any-state"

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
  member: Object.freeze<AgentPermission[]>(["read-own-state"])
})

/**
 * Finds the role of an agent from its kind.
 * @param kind - Whether the agent ships with the backend or was stored.
 * @returns `leader` for a built-in agent, `member` for a stored one.
 */
export function calculateAgentRole(kind: "built-in" | "custom"): AgentRole {
  return kind === "built-in" ? "leader" : "member"
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
