import type { AgentSummary } from "@lys/protocol"
import type { Agent, AgentChanges } from "@lys/share"

/**
 * Position after which an agent list page starts: the creation time and code
 * of the last agent on the previous page.
 */
export type AgentListBoundary = Readonly<{
  /** Creation time of the boundary agent, as listed. */
  createdAt: string
  /** Code of the boundary agent, which breaks creation-time ties. */
  code: string
}>

/** Selection of one page of agent summaries. */
export type ListAgentsInput = Readonly<{
  /** Last agent of the previous page; undefined for the first page. */
  after: AgentListBoundary | undefined
  /**
   * Inclusive maximum number of summaries, from one to
   * `MAXIMUM_AGENT_LIST_PAGE_SIZE` of `@lys/protocol`.
   */
  limit: number
}>

/** One page of agent summaries read from one consistent snapshot. */
export type AgentPage = Readonly<{
  /**
   * Agents after the boundary in ascending creation-time and then code order,
   * at most the requested limit.
   */
  agents: readonly AgentSummary[]
  /** Number of stored agents, including those on other pages. */
  storedCount: number
  /** Whether a stored agent follows the last one on this page. */
  hasMore: boolean
}>

/** One validated change to a stored agent and the time it is made. */
export type UpdateAgentInput = Readonly<{
  /** Code of the agent to change, compared exactly. */
  code: string
  /** Fields to replace; omitted fields keep their stored values. */
  changes: AgentChanges
  /**
   * Time stored as the agent's last change, even when the given values equal
   * the stored ones.
   */
  updatedAt: string
}>

/**
 * Keeps stored agent definitions for the agent service: paged listing, and
 * lookup, creation, change, and deletion by code.
 *
 * @remarks A listing or lookup reads one consistent snapshot and changes
 * nothing. Every other call is one write transaction that commits before it
 * returns and changes nothing when it fails, including when the store cannot
 * begin or commit it; an `AggregateError` then holds that failure followed by
 * each failure to roll back. Returned agents and summaries are frozen
 * independent values, validated against the agent schema. The records never read the clock:
 * callers pass every time they store. Borrowed from the store's owner without
 * the authority to close it; every call fails with `Database is closed` after
 * the owner closes the store. Calls cannot be nested: a call made while
 * another operation on the store runs fails with
 * `Database transactions cannot be nested` and leaves that operation
 * untouched. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export interface AgentRecordStore {
  /**
   * Reads the number of stored agents and one page of their summaries.
   *
   * @param input - Boundary after which the page starts and its size.
   * @returns The page, its summaries frozen and without system prompts.
   * @throws If the store is closed or a listed row violates the agent schema;
   * the records stay usable.
   */
  listAgents(input: ListAgentsInput): AgentPage
  /**
   * Reads one stored agent.
   *
   * @param code - Code to look up, compared exactly.
   * @returns The stored agent, or undefined when no agent has this code.
   * @throws If the store is closed or the stored row violates the agent
   * schema; the records stay usable.
   */
  findAgent(code: string): Agent | undefined
  /**
   * Stores a new agent exactly as given.
   *
   * @param agent - Validated agent whose times the caller chose.
   * @returns True when stored; false when an agent with the same code is
   * already stored, which changes nothing.
   * @throws If the store is closed or the write fails.
   */
  createAgent(agent: Agent): boolean
  /**
   * Applies a validated change to one stored agent and stores the time of the
   * change.
   *
   * @param input - Code of the agent, the fields to replace, and the time of
   * the change.
   * @returns The changed agent, or undefined when no agent has the code, which
   * changes nothing.
   * @throws If the store is closed, the write fails, or the changed row
   * violates the agent schema; the agent is then unchanged.
   */
  updateAgent(input: UpdateAgentInput): Agent | undefined
  /**
   * Permanently deletes one stored agent.
   *
   * @param code - Code of the agent to delete, compared exactly.
   * @returns True when it was stored; false when it was already absent.
   * @throws If the store is closed or the deletion fails.
   */
  deleteAgent(code: string): boolean
}
