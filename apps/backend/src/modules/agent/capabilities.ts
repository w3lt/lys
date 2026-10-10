import type { GetAgentApiResponse, ListAgentsApiResponse } from "@lys/protocol"
import type {
  Agent,
  AgentChangesCandidate,
  AgentDefinitionCandidate
} from "@lys/share"
import type { AgentListOptions } from "./listOptions"

/** Outcome of asking to change one agent. */
export type AgentUpdateOutcome =
  | Readonly<{
      /** The stored agent was changed. */
      status: "updated"
      /** The agent with the change applied. */
      agent: Agent
    }>
  | Readonly<{
      /** No built-in or stored agent has the code; nothing changed. */
      status: "missing"
    }>
  | Readonly<{
      /** The code is a built-in agent's, which never changes. */
      status: "built-in"
    }>

/**
 * Outcome of asking to delete one agent: `deleted` when a stored agent was
 * removed, `missing` when no built-in or stored agent has the code, and
 * `built-in` when the code is a built-in agent's, which is never deleted.
 */
export type AgentDeletionOutcome = "deleted" | "missing" | "built-in"

/**
 * Synchronous listing of the built-in agents and one page of stored agents,
 * borrowed for one backend lifetime.
 */
export interface AgentLister {
  /**
   * Reads the stored agent count and one page of stored agent summaries from
   * one store snapshot, with every built-in agent's summary.
   * @param options - Validated cursor and bounded page size.
   * @returns The strict page in ascending creation-time and code order; its
   * cursor continues after the last listed agent while more follow. The
   * built-in agents are the same on every page, in shipped order.
   * @throws If the store is closed or holds an invalid agent.
   */
  listAgents(options: AgentListOptions): ListAgentsApiResponse
}

/**
 * Synchronous lookup of one built-in or stored agent, borrowed for one
 * backend lifetime.
 */
export interface AgentReader {
  /**
   * Reads one agent.
   * @param code - Code to look up, compared exactly.
   * @returns The built-in agent with that code, else the stored one, tagged
   * with its kind; undefined when no agent has the code.
   * @throws If the store is closed or the stored agent is invalid.
   */
  findAgent(code: string): GetAgentApiResponse | undefined
}

/** Synchronous creation of agents, borrowed for one backend lifetime. */
export interface AgentCreator {
  /**
   * Validates and stores a new agent; a definition without a code is stored
   * under the first free code that `calculateAgentCode` tries for its name.
   * A built-in agent's code is never free.
   * @param definition - Candidate definition, validated and trimmed before any
   * storage work.
   * @returns The stored agent, or undefined when the given code is a built-in
   * agent's or already stored, which stores nothing.
   * @throws If validation fails; with `Database is closed` once the store's
   * owner has closed it; or if the write fails. Nothing is then stored.
   */
  createAgent(definition: AgentDefinitionCandidate): Agent | undefined
}

/** Synchronous change of stored agents, borrowed for one backend lifetime. */
export interface AgentEditor {
  /**
   * Validates and applies a change to one stored agent.
   * @param code - Code of the agent to change, compared exactly.
   * @param changes - Candidate change, validated and trimmed before any
   * storage work.
   * @returns The changed agent; `missing` when no agent has the code and
   * `built-in` when a built-in agent has it, both of which change nothing.
   * @throws If validation fails, or the store is closed, the write fails, or
   * the changed agent is invalid; the agent is then unchanged.
   */
  updateAgent(code: string, changes: AgentChangesCandidate): AgentUpdateOutcome
}

/** Synchronous deletion of stored agents, borrowed for one backend lifetime. */
export interface AgentDeleter {
  /**
   * Permanently deletes one stored agent.
   * @param code - Code of the agent to delete, compared exactly.
   * @returns `deleted` when it was stored, `missing` when no agent has the
   * code, and `built-in` when a built-in agent has it, which deletes nothing.
   * Repetition does not recreate a deleted agent.
   * @throws If the store is closed or the deletion fails.
   */
  deleteAgent(code: string): AgentDeletionOutcome
}
