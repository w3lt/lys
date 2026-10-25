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
 * marked deleted, `missing` when no built-in or stored agent that is not
 * deleted has the code, and `built-in` when the code is a built-in agent's,
 * which is never deleted.
 */
export type AgentDeletionOutcome = "deleted" | "missing" | "built-in"

/** One built-in or stored agent, with the time it was deleted, if it was. */
export type FoundAgent = Readonly<{
  /** The agent tagged with its kind, as the agent API returns it. */
  agent: GetAgentApiResponse
  /**
   * Time a stored agent was deleted; null while it is not deleted, and
   * always null for a built-in agent.
   */
  deletedAt: string | null
}>

/**
 * Synchronous listing of the built-in agents and one page of stored agents,
 * borrowed for one backend lifetime.
 */
export interface AgentLister {
  /**
   * Reads the stored agent count and one page of stored agent summaries from
   * one store snapshot, with every built-in agent's summary.
   * @param options - Validated cursor and bounded page size.
   * @returns The strict page in ascending creation-time and code order,
   * without deleted agents; its cursor continues after the last listed agent
   * while more follow. The built-in agents are the same on every page, in
   * shipped order.
   * @throws With `Database is closed` once the store's owner has closed it,
   * or if the store holds an invalid agent.
   */
  listAgents(options: AgentListOptions): ListAgentsApiResponse
}

/**
 * Synchronous lookup of one built-in or stored agent, borrowed for one
 * backend lifetime.
 */
export interface AgentReader {
  /**
   * Reads one agent, deleted or not.
   * @param code - Code to look up, compared exactly.
   * @returns The frozen built-in agent with that code, else the stored one,
   * deleted or not, tagged with its kind and given with its deletion time;
   * undefined when no agent has the code.
   * @throws With `Database is closed` once the store's owner has closed it
   * and the code is not a built-in agent's, or if the stored agent is invalid.
   */
  findAgent(code: string): FoundAgent | undefined
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
   * agent's or already stored, by a deleted agent too, which stores nothing.
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
   * @returns The changed agent; `missing` when no agent that is not deleted
   * has the code and `built-in` when a built-in agent has it, both of which
   * change nothing.
   * @throws If validation fails, before any storage work; with
   * `Database is closed` once the store's owner has closed it and the code is
   * not a built-in agent's; or if the write fails or the changed agent is
   * invalid. The agent is then unchanged.
   */
  updateAgent(code: string, changes: AgentChangesCandidate): AgentUpdateOutcome
}

/** Synchronous deletion of stored agents, borrowed for one backend lifetime. */
export interface AgentDeleter {
  /**
   * Marks one stored agent deleted at the current time; it stays stored, so
   * its code is never free again.
   * @param code - Code of the agent to delete, compared exactly.
   * @returns `deleted` when it was stored and not deleted, `missing` when no
   * such agent has the code, which keeps an earlier deletion's time, and
   * `built-in` when a built-in agent has it, which deletes nothing.
   * @throws With `Database is closed` once the store's owner has closed it
   * and the code is not a built-in agent's, or if the deletion fails; the
   * agent is then unchanged.
   */
  deleteAgent(code: string): AgentDeletionOutcome
}

/** Largest number of matches one agent search returns. */
export const MAXIMUM_AGENT_SEARCH_MATCHES = 20

/** One built-in or stored agent that matches a search. */
export type AgentSearchMatch = Readonly<{
  /** Whether the agent ships with the backend or was stored. */
  kind: "built-in" | "custom"
  /** Code of the agent. */
  code: string
  /** Display name of the agent. */
  name: string
  /** Short description of what the agent does. */
  bio: string
  /**
   * Time a stored agent was deleted; null while it is not deleted, and
   * always null for a built-in agent.
   */
  deletedAt: string | null
}>

/** The first matches of one agent search and how many agents match in all. */
export type AgentSearchResult = Readonly<{
  /**
   * At most {@link MAXIMUM_AGENT_SEARCH_MATCHES} matches: agents whose code
   * or name equals the query first, built-in before stored; then the other
   * built-in agents in shipped order; then the other stored agents by
   * creation time and code.
   */
  matches: readonly AgentSearchMatch[]
  /** Number of built-in and stored agents that match, deleted ones included. */
  matchCount: number
}>

/** Synchronous search of every agent, borrowed for one backend lifetime. */
export interface AgentSearcher {
  /**
   * Finds the built-in and stored agents, deleted ones included, whose code,
   * name, or bio contains a text.
   * @param query - Text found literally, under Unicode simple case folding;
   * the caller bounds and trims it.
   * @returns The frozen first matches and the number of all matches.
   * @throws With `Database is closed` once the store's owner has closed it,
   * or if the store holds an invalid agent.
   */
  listAgentMatches(query: string): AgentSearchResult
}
