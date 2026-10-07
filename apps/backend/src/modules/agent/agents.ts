import type { ListAgentsApiResponse } from "@lys/protocol"
import {
  agentChangesSchema,
  agentDefinitionSchema,
  agentSchema,
  type Agent,
  type AgentChangesCandidate,
  type AgentDefinition,
  type AgentDefinitionCandidate
} from "@lys/share"
import { calculateAgentCode } from "./agentCode"
import type {
  AgentCreator,
  AgentDeleter,
  AgentEditor,
  AgentLister,
  AgentReader
} from "./capabilities"
import { createAgentListCursor, type AgentListOptions } from "./listOptions"
import type { AgentRecordStore } from "./records"

/**
 * Builds and validates the stored form of a new agent, created and last
 * changed at one time.
 * @param code - Code the agent is stored under, given or derived.
 * @param definition - Validated, trimmed definition.
 * @param now - Creation time, also stored as the time of the last change.
 * @returns The frozen agent, validated against the agent schema.
 * @throws If the code or the time violates the agent schema, before any
 * storage work.
 */
function buildAgent(
  code: string,
  definition: AgentDefinition,
  now: string
): Agent {
  return agentSchema.parse({
    code,
    name: definition.name,
    bio: definition.bio,
    systemPrompt: definition.systemPrompt,
    createdAt: now,
    updatedAt: now
  } satisfies Agent)
}

/**
 * Retains borrowed agent records to list agents and to validate and store
 * agent definitions, stamping each stored change with the current time.
 *
 * @remarks Owns no resource: the records' owner closes the store, after which
 * every operation fails with `Database is closed`. Each create or update
 * reads the current time once and passes it to everything it stores; nothing
 * it calls reads the clock. Each update or delete is one write transaction
 * that commits before it returns; a create is one write transaction per code
 * it tries. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export default class StoredAgents
  implements AgentLister, AgentReader, AgentCreator, AgentEditor, AgentDeleter
{
  /** Borrowed records for every agent listing, lookup, and change. */
  readonly #recordStore: AgentRecordStore

  /**
   * Retains borrowed records without reading them.
   * @param recordStore - Agent records lent by the composition root.
   */
  public constructor(recordStore: AgentRecordStore) {
    this.#recordStore = recordStore
  }

  /**
   * Lists one page of agent summaries and continues the listing after its
   * last agent.
   * @param options - Validated cursor and page size from parseAgentListOptions.
   * @returns A strict page in ascending creation-time and code order, read
   * from one snapshot; its cursor names the last listed agent while more
   * follow, and is null on the final page.
   * @throws If the store is closed or a listed agent is invalid.
   */
  public listAgents(options: AgentListOptions): ListAgentsApiResponse {
    const page = this.#recordStore.listAgents({
      after: options.cursor,
      limit: options.limit
    })
    const lastAgent = page.agents.at(-1)
    return {
      agents: page.agents,
      storedCount: page.storedCount,
      nextCursor:
        page.hasMore && lastAgent !== undefined
          ? createAgentListCursor(lastAgent)
          : null
    }
  }

  /**
   * Validates and stores a new agent, created and last changed now.
   * @param definition - Candidate definition, validated and trimmed by the
   * agent definition schema before any storage work. Without a code, the
   * agent is stored under the first free code derived from its name.
   * @returns The frozen stored agent, or undefined when the given code is
   * already stored, which leaves that agent unchanged.
   * @throws If validation fails, before any storage work, or the store is
   * closed or a write fails; nothing is then stored.
   */
  public createAgent(definition: AgentDefinitionCandidate): Agent | undefined {
    const parsedDefinition = agentDefinitionSchema.parse(definition)
    const now = new Date().toISOString()
    if (parsedDefinition.code === undefined)
      return this.#createAgentWithDerivedCode(parsedDefinition, now)
    const agent = buildAgent(parsedDefinition.code, parsedDefinition, now)
    return this.#recordStore.createAgent(agent) ? agent : undefined
  }

  /**
   * Stores a new agent under the first free code derived from its name,
   * trying `calculateAgentCode` attempts in order.
   * @param definition - Validated definition without a code.
   * @param now - Creation time of the agent.
   * @returns The frozen stored agent.
   * @throws If the store is closed or a write fails; nothing is then stored.
   * @remarks Each refused try means another stored agent has that code, and
   * tries from the second on give distinct codes, so a free code is found.
   */
  #createAgentWithDerivedCode(definition: AgentDefinition, now: string): Agent {
    for (let attempt = 1; ; attempt += 1) {
      const agent = buildAgent(
        calculateAgentCode(definition.name, attempt),
        definition,
        now
      )
      if (this.#recordStore.createAgent(agent)) return agent
    }
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
   * @param code - Code of the agent to change, as given; a code no agent can
   * have finds nothing.
   * @param changes - Candidate change, validated and trimmed by the agent
   * changes schema before any storage work; it must change at least one field.
   * @returns The changed agent, or undefined when no agent has the code.
   * @throws If validation fails, before any storage work, or the store is
   * closed, the write fails, or the changed agent is invalid; the agent is then
   * unchanged.
   */
  public updateAgent(
    code: string,
    changes: AgentChangesCandidate
  ): Agent | undefined {
    const parsedChanges = agentChangesSchema.parse(changes)
    return this.#recordStore.updateAgent({
      code,
      changes: parsedChanges,
      updatedAt: new Date().toISOString()
    })
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
