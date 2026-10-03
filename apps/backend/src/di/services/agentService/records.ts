import type { Agent, AgentUpdate } from "../../../modules/agent/agent"

/**
 * Keeps stored agent definitions for the agent service: lookup, creation,
 * change, and deletion by code.
 *
 * @remarks A lookup reads one consistent snapshot and changes nothing. Every
 * other call is one write transaction that commits before it returns and
 * changes nothing when it fails, including when the store cannot begin or
 * commit it; an `AggregateError` then holds that failure followed by each
 * failure to roll back. Returned agents are frozen independent values,
 * validated against the agent schema. The records never read the clock:
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
   * @param update - Agent code and the fields to replace; omitted fields keep
   * their stored values.
   * @param updatedAt - Time stored as the agent's last change, even when the
   * given values equal the stored ones.
   * @returns The changed agent, or undefined when no agent has the code, which
   * changes nothing.
   * @throws If the store is closed, the write fails, or the changed row
   * violates the agent schema; the agent is then unchanged.
   */
  updateAgent(update: AgentUpdate, updatedAt: string): Agent | undefined
  /**
   * Permanently deletes one stored agent.
   *
   * @param code - Code of the agent to delete, compared exactly.
   * @returns True when it was stored; false when it was already absent.
   * @throws If the store is closed or the deletion fails.
   */
  deleteAgent(code: string): boolean
}
