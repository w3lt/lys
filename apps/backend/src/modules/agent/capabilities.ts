import type { ListAgentsApiResponse } from "@lys/protocol"
import type {
  Agent,
  AgentChangesCandidate,
  AgentDefinitionCandidate
} from "@lys/share"
import type { AgentListOptions } from "./listOptions"

/** Synchronous paged listing of stored agents, borrowed for one backend lifetime. */
export interface AgentLister {
  /**
   * Reads the agent count and one page of agent summaries from one store
   * snapshot.
   * @param options - Validated cursor and bounded page size.
   * @returns The strict page in ascending creation-time and code order; its
   * cursor continues after the last listed agent while more follow.
   * @throws If the store is closed or holds an invalid agent.
   */
  listAgents(options: AgentListOptions): ListAgentsApiResponse
}

/** Synchronous lookup of one stored agent, borrowed for one backend lifetime. */
export interface AgentReader {
  /**
   * Reads one stored agent.
   * @param code - Code to look up, compared exactly.
   * @returns The agent, or undefined when no agent has the code.
   * @throws If the store is closed or the stored agent is invalid.
   */
  findAgent(code: string): Agent | undefined
}

/** Synchronous creation of agents, borrowed for one backend lifetime. */
export interface AgentCreator {
  /**
   * Validates and stores a new agent; a definition without a code is stored
   * under a free code derived from its name. Lys's code is never free.
   * @param definition - Candidate definition, validated and trimmed before any
   * storage work.
   * @returns The stored agent, or undefined when the given code is Lys's or
   * already stored, which stores nothing.
   * @throws If validation fails, or the store is closed or the write fails;
   * nothing is then stored.
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
   * @returns The changed agent, or undefined when no agent has the code,
   * which changes nothing.
   * @throws If validation fails, or the store is closed, the write fails, or
   * the changed agent is invalid; the agent is then unchanged.
   */
  updateAgent(code: string, changes: AgentChangesCandidate): Agent | undefined
}

/** Synchronous deletion of stored agents, borrowed for one backend lifetime. */
export interface AgentDeleter {
  /**
   * Permanently deletes one stored agent.
   * @param code - Code of the agent to delete, compared exactly.
   * @returns True when it was stored; false when it was already absent.
   * Repetition does not recreate it.
   * @throws If the store is closed or the deletion fails.
   */
  deleteAgent(code: string): boolean
}
