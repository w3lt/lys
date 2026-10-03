import {
  agentDefinitionSchema,
  agentUpdateSchema,
  type Agent,
  type AgentDefinitionCandidate,
  type AgentUpdateCandidate
} from "../../../modules/agent/agent"
import type { AgentRecordStore } from "./records"

/**
 * Retains borrowed agent records to validate and store agent definitions,
 * stamping each stored change with the current time.
 *
 * @remarks Owns no resource: the records' owner closes the store, after which
 * every operation fails with `Database is closed`. Each create or update
 * reads the current time once and passes it to everything it stores; nothing
 * it calls reads the clock. Each change is one write transaction that commits
 * before it returns. Concurrency model: single-owner, synchronous on the
 * backend's event loop.
 */
export default class StoredAgents {
  /** Borrowed records for every agent lookup and change. */
  readonly #recordStore: AgentRecordStore

  /**
   * Retains borrowed records without reading them.
   * @param recordStore - Agent records lent by the composition root.
   */
  public constructor(recordStore: AgentRecordStore) {
    this.#recordStore = recordStore
  }

  /**
   * Validates and stores a new agent, created and last changed now.
   * @param definition - Candidate definition, validated and trimmed by the
   * agent definition schema before any storage work.
   * @returns The frozen stored agent, or undefined when an agent with the same
   * code is already stored, which is left unchanged.
   * @throws If validation fails, before any storage work, or the store is
   * closed or the write fails; nothing is then stored.
   */
  public createAgent(definition: AgentDefinitionCandidate): Agent | undefined {
    const parsedDefinition = agentDefinitionSchema.parse(definition)
    const now = new Date().toISOString()
    const agent = Object.freeze({
      code: parsedDefinition.code,
      name: parsedDefinition.name,
      bio: parsedDefinition.bio,
      systemPrompt: parsedDefinition.systemPrompt,
      createdAt: now,
      updatedAt: now
    } satisfies Agent)
    return this.#recordStore.createAgent(agent) ? agent : undefined
  }

  /**
   * Reads one stored agent.
   * @param code - Code to look up as given, compared exactly.
   * @returns The stored agent, or undefined when no agent has the code.
   * @throws If the store is closed or the stored agent is invalid.
   */
  public findAgent(code: string): Agent | undefined {
    return this.#recordStore.findAgent(code)
  }

  /**
   * Validates and applies a change to one stored agent, last changed now.
   * @param update - Candidate change, validated and trimmed by the agent
   * update schema before any storage work; it must change at least one field.
   * @returns The changed agent, or undefined when no agent has the code.
   * @throws If validation fails, before any storage work, or the store is
   * closed, the write fails, or the changed agent is invalid; the agent is then
   * unchanged.
   */
  public updateAgent(update: AgentUpdateCandidate): Agent | undefined {
    const parsedUpdate = agentUpdateSchema.parse(update)
    return this.#recordStore.updateAgent(parsedUpdate, new Date().toISOString())
  }

  /**
   * Permanently deletes one stored agent.
   * @param code - Code of the agent to delete, as given.
   * @returns True when it was stored; false when it was already absent.
   * @throws If the store is closed or the deletion fails.
   */
  public deleteAgent(code: string): boolean {
    return this.#recordStore.deleteAgent(code)
  }
}
