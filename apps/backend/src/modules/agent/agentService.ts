import type { ListAgentsApiResponse } from "@lys/protocol"
import {
  agentChangesSchema,
  agentDefinitionSchema,
  agentSchema,
  LYS_AGENT_CODE,
  type Agent as StoredAgent,
  type AgentChangesCandidate,
  type AgentDefinition,
  type AgentDefinitionCandidate
} from "@lys/share"
import Agent from "./agent"
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
import type { ReplyModel } from "./replyModel"

/** Records, settings, and model access the agent service is built from. */
export type AgentServiceOptions = Readonly<{
  /** Agent records lent by the composition root, which closes their store. */
  recordStore: AgentRecordStore
  /** Lys's system prompt: non-empty text read once at startup. */
  lysSystemPrompt: string
  /** Model access lent to Lys for the service's lifetime. */
  replyModel: ReplyModel
}>

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
function buildStoredAgent(
  code: string,
  definition: AgentDefinition,
  now: string
): StoredAgent {
  return agentSchema.parse({
    code,
    name: definition.name,
    bio: definition.bio,
    systemPrompt: definition.systemPrompt,
    createdAt: now,
    updatedAt: now
  } satisfies StoredAgent)
}

/**
 * Owns Lys and borrows agent records to list, define, and find agents while
 * keeping each agent code unique across Lys and the stored agents.
 *
 * @remarks Lys is built in: built from the configured prompt, answering chats
 * under the code `lys`, and never stored, so no stored agent can take that
 * code. Stored agents cannot answer chats yet. Each create or update
 * reads the current time once and passes it to everything it stores; nothing
 * it calls reads the clock. Each update or delete is one write transaction
 * that commits before it returns; a create is one write transaction per code
 * it tries. Owns no resource: the records' owner closes their store, after
 * which every records operation fails with `Database is closed`, and the
 * model's owner releases it. Concurrency model: single-owner, synchronous on
 * the backend's event loop.
 */
export default class AgentService
  implements AgentLister, AgentReader, AgentCreator, AgentEditor, AgentDeleter
{
  /** Borrowed records for every stored-agent listing, lookup, and change. */
  readonly #recordStore: AgentRecordStore

  /** Lys, built once from the configured prompt. */
  readonly #lys: Agent

  /**
   * Retains borrowed records and builds Lys without reading the records or
   * contacting the model.
   * @param options - Agent records, Lys's system prompt, and the model access
   * Lys borrows.
   */
  public constructor(options: AgentServiceOptions) {
    this.#recordStore = options.recordStore
    this.#lys = new Agent(
      { code: LYS_AGENT_CODE, systemPrompt: options.lysSystemPrompt },
      options.replyModel
    )
  }

  /**
   * Lists one page of stored agent summaries and continues the listing after
   * its last agent.
   * @param options - Validated cursor and page size from parseAgentListOptions.
   * @returns A strict page in ascending creation-time and code order, read
   * from one snapshot; its cursor names the last listed agent while more
   * follow, and is null on the final page. Lys is not listed.
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
   * @returns The frozen stored agent, or undefined when Lys or a stored agent
   * already has the given code, which leaves every agent unchanged.
   * @throws If validation fails, before any storage work, or the store is
   * closed or a write fails; nothing is then stored.
   */
  public createAgent(
    definition: AgentDefinitionCandidate
  ): StoredAgent | undefined {
    const parsedDefinition = agentDefinitionSchema.parse(definition)
    const now = new Date().toISOString()
    if (parsedDefinition.code === undefined)
      return this.#createAgentWithDerivedCode(parsedDefinition, now)
    const agent = buildStoredAgent(parsedDefinition.code, parsedDefinition, now)
    return this.#createAgentRecord(agent) ? agent : undefined
  }

  /**
   * Stores a new agent under the first free code derived from its name,
   * trying `calculateAgentCode` attempts in order.
   * @param definition - Validated definition without a code.
   * @param now - Creation time of the agent.
   * @returns The frozen stored agent.
   * @throws If the store is closed or a write fails; nothing is then stored.
   * @remarks Each refused try means Lys or a stored agent has that code, and
   * tries from the second on give distinct codes, so a free code is found.
   */
  #createAgentWithDerivedCode(
    definition: AgentDefinition,
    now: string
  ): StoredAgent {
    for (let attempt = 1; ; attempt += 1) {
      const agent = buildStoredAgent(
        calculateAgentCode(definition.name, attempt),
        definition,
        now
      )
      if (this.#createAgentRecord(agent)) return agent
    }
  }

  /**
   * Stores a new agent unless Lys or a stored agent has its code.
   * @param agent - Validated agent to store.
   * @returns True after the write commits; false when the code is Lys's or
   * already stored, which stores nothing.
   * @throws If the store is closed or the write fails; nothing is then stored.
   */
  #createAgentRecord(agent: StoredAgent): boolean {
    return agent.code !== this.#lys.code && this.#recordStore.createAgent(agent)
  }

  /**
   * Reads one stored agent.
   * @param code - Code to look up as given, compared exactly.
   * @returns The stored agent, or undefined when no stored agent has the
   * code, as for `lys`.
   * @throws If the store is closed or the stored agent is invalid.
   */
  public findAgent(code: string): StoredAgent | undefined {
    return this.#recordStore.findAgent(code)
  }

  /**
   * Validates and applies a change to one stored agent, last changed now.
   * @param code - Code of the agent to change, as given; a code no agent can
   * have finds nothing.
   * @param changes - Candidate change, validated and trimmed by the agent
   * changes schema before any storage work; it must change at least one field.
   * @returns The changed agent, or undefined when no stored agent has the
   * code.
   * @throws If validation fails, before any storage work, or the store is
   * closed, the write fails, or the changed agent is invalid; the agent is then
   * unchanged.
   */
  public updateAgent(
    code: string,
    changes: AgentChangesCandidate
  ): StoredAgent | undefined {
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

  /**
   * Finds the agent that answers chats under a code.
   * @param code - Agent code as given, compared exactly.
   * @returns Lys for the code `lys`; undefined for any other code, including
   * the code of a stored agent, since stored agents cannot answer chats yet.
   */
  public findChatAgent(code: string): Agent | undefined {
    return code === this.#lys.code ? this.#lys : undefined
  }
}
