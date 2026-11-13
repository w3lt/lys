/**
 * Role of an agent: `leader` for the built-in agents, which see every agent
 * and give work to other agents, and `member` for the stored agents, which
 * see only themselves and take that work.
 */
export type AgentRole = "leader" | "member"

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

/** Who an agent is when it asks about agents: its code and its role. */
export type AgentIdentity = Readonly<{
  /** Code of the agent that asks. */
  code: string
  /** Role that decides what it may learn. */
  role: AgentRole
}>

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
 * @returns True when the role's permissions include the permission.
 */
export function hasAgentPermission(
  role: AgentRole,
  permission: AgentPermission
): boolean {
  /**
   * Permissions of each role; the tools an agent is offered and every check of
   * a state read or an agent search follow them.
   */
  const agentRolePermissions: Readonly<
    Record<AgentRole, readonly AgentPermission[]>
  > = Object.freeze({
    leader: Object.freeze<AgentPermission[]>([
      "read-own-state",
      "find-agents",
      "read-any-state",
      "delegate-work"
    ]),
    member: Object.freeze<AgentPermission[]>(["read-own-state", "take-work"])
  })

  return agentRolePermissions[role].includes(permission)
}
