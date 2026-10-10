import type {
  BuiltInAgentSummary,
  GetAgentApiResponse,
  ListAgentsApiResponse
} from "@lys/protocol"
import {
  agentChangesSchema,
  agentDefinitionSchema,
  agentSchema,
  type Agent as StoredAgent,
  type AgentChangesCandidate,
  type AgentDefinition,
  type AgentDefinitionCandidate,
  type BuiltInAgent
} from "@lys/share"
import Agent from "./agent"
import { calculateAgentCode } from "./agentCode"
import type {
  AgentCreator,
  AgentDeleter,
  AgentDeletionOutcome,
  AgentEditor,
  AgentLister,
  AgentReader,
  AgentUpdateOutcome
} from "./capabilities"
import { createAgentListCursor, type AgentListOptions } from "./listOptions"
import type { AgentRecordStore } from "./records"
import type { ReplyModel } from "./replyModel"

/** Records, built-in agents, and model access the agent service is built from. */
export type AgentServiceOptions = Readonly<{
  /** Agent records lent by the composition root, which closes their store. */
  recordStore: AgentRecordStore
  /**
   * Agents the backend ships with, each code once, in the order they are
   * listed; built once at startup.
   */
  builtInAgents: readonly BuiltInAgent[]
  /** Model access lent to every agent for the service's lifetime. */
  replyModel: ReplyModel
}>

/** Shared outcome of a change no agent could take. */
const MISSING_AGENT_UPDATE_OUTCOME = Object.freeze({
  status: "missing"
} satisfies AgentUpdateOutcome)

/** Shared outcome of a change refused because the agent is built in. */
const BUILT_IN_AGENT_UPDATE_OUTCOME = Object.freeze({
  status: "built-in"
} satisfies AgentUpdateOutcome)

/**
 * Builds the listed form of a built-in agent.
 * @param agent - Built-in agent as shipped.
 * @returns The frozen summary, without the system prompt.
 */
function buildBuiltInAgentSummary(agent: BuiltInAgent): BuiltInAgentSummary {
  return Object.freeze({ code: agent.code, name: agent.name, bio: agent.bio })
}

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
 * Owns the built-in agents and borrows agent records to list, define, and
 * find agents while keeping each agent code unique across both.
 *
 * @remarks A built-in agent ships with the backend: it is never stored,
 * changed, or deleted, and no stored agent can take its code. Every built-in
 * or stored agent answers chats under its code; the agent that answers a turn
 * is built from the current record when it is looked up, so a stored agent's
 * latest system prompt is the one sent. Each create or update reads the
 * current time once and passes it to everything it stores; nothing it calls
 * reads the clock. Each update or delete is one write transaction that
 * commits before it returns; a create is one write transaction per code it
 * tries. Owns no resource: the records' owner closes their store, after which
 * every records operation fails with `Database is closed`, and the model's
 * owner releases it. Concurrency model: single-owner, synchronous on the
 * backend's event loop.
 */
export default class AgentService
  implements AgentLister, AgentReader, AgentCreator, AgentEditor, AgentDeleter
{
  /** Borrowed records for every stored-agent listing, lookup, and change. */
  readonly #recordStore: AgentRecordStore

  /** Built-in agents by code, in the order they are listed. */
  readonly #builtInAgents: ReadonlyMap<string, BuiltInAgent>

  /** Listed form of every built-in agent, in listing order. */
  readonly #builtInAgentSummaries: readonly BuiltInAgentSummary[]

  /** Borrowed model access that writes every agent's replies. */
  readonly #replyModel: ReplyModel

  /**
   * Retains the borrowed records, the built-in agents, and the model access
   * without reading the records or contacting the model.
   * @param options - Agent records, the built-in agents, and the model access
   * every agent borrows.
   */
  public constructor(options: AgentServiceOptions) {
    this.#recordStore = options.recordStore
    this.#builtInAgents = new Map(
      options.builtInAgents.map((agent) => [agent.code, agent])
    )
    this.#builtInAgentSummaries = Object.freeze(
      options.builtInAgents.map(buildBuiltInAgentSummary)
    )
    this.#replyModel = options.replyModel
  }

  /**
   * Lists every built-in agent with one page of stored agent summaries, and
   * continues the stored listing after its last agent.
   * @param options - Validated cursor and page size from parseAgentListOptions.
   * @returns A strict page of stored agents in ascending creation-time and
   * code order, read from one snapshot; its cursor names the last listed
   * agent while more follow, and is null on the final page. The built-in
   * agents are the same on every page, in shipped order.
   * @throws If the store is closed or a listed agent is invalid.
   */
  public listAgents(options: AgentListOptions): ListAgentsApiResponse {
    const page = this.#recordStore.listAgents({
      after: options.cursor,
      limit: options.limit
    })
    const lastAgent = page.agents.at(-1)
    return {
      builtInAgents: this.#builtInAgentSummaries,
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
   * @returns The frozen stored agent, or undefined when a built-in or stored
   * agent already has the given code, which leaves every agent unchanged.
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
   * @remarks Each refused try means a built-in or stored agent has that code,
   * and tries from the second on give distinct codes, so a free code is found.
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
   * Stores a new agent unless a built-in or stored agent has its code.
   * @param agent - Validated agent to store.
   * @returns True after the write commits; false when the code is a built-in
   * agent's or already stored, which stores nothing.
   * @throws If the store is closed or the write fails; nothing is then stored.
   */
  #createAgentRecord(agent: StoredAgent): boolean {
    return (
      !this.#builtInAgents.has(agent.code) &&
      this.#recordStore.createAgent(agent)
    )
  }

  /**
   * Reads one built-in or stored agent.
   * @param code - Code to look up as given, compared exactly.
   * @returns The frozen built-in agent with that code, else the frozen stored
   * one, tagged with its kind; undefined when no agent has the code.
   * @throws If the store is closed or the stored agent is invalid.
   */
  public findAgent(code: string): GetAgentApiResponse | undefined {
    const builtInAgent = this.#builtInAgents.get(code)
    if (builtInAgent !== undefined)
      return Object.freeze({ kind: "built-in", ...builtInAgent })
    const storedAgent = this.#recordStore.findAgent(code)
    return storedAgent === undefined
      ? undefined
      : Object.freeze({ kind: "custom", ...storedAgent })
  }

  /**
   * Validates and applies a change to one stored agent, last changed now.
   * @param code - Code of the agent to change, as given; a code no agent can
   * have finds nothing.
   * @param changes - Candidate change, validated and trimmed by the agent
   * changes schema before any storage work; it must change at least one field.
   * @returns The changed agent; `missing` when no agent has the code and
   * `built-in` when a built-in agent has it, both of which change nothing.
   * @throws If validation fails, before any storage work, or the store is
   * closed, the write fails, or the changed agent is invalid; the agent is then
   * unchanged.
   */
  public updateAgent(
    code: string,
    changes: AgentChangesCandidate
  ): AgentUpdateOutcome {
    const parsedChanges = agentChangesSchema.parse(changes)
    if (this.#builtInAgents.has(code)) return BUILT_IN_AGENT_UPDATE_OUTCOME
    const agent = this.#recordStore.updateAgent({
      code,
      changes: parsedChanges,
      updatedAt: new Date().toISOString()
    })
    return agent === undefined
      ? MISSING_AGENT_UPDATE_OUTCOME
      : { status: "updated", agent }
  }

  /**
   * Permanently deletes one stored agent.
   * @param code - Code of the agent to delete, as given.
   * @returns `deleted` when it was stored, `missing` when no agent has the
   * code, and `built-in` when a built-in agent has it, which deletes nothing.
   * @throws If the store is closed or the deletion fails.
   * @remarks A conversation the deleted agent answered keeps its code, so
   * {@link AgentService.findChatAgent} finds no agent for it until an agent
   * is stored under that code again.
   */
  public deleteAgent(code: string): AgentDeletionOutcome {
    if (this.#builtInAgents.has(code)) return "built-in"
    return this.#recordStore.deleteAgent(code) ? "deleted" : "missing"
  }

  /**
   * Finds the agent that answers chats under a code.
   * @param code - Agent code as given, compared exactly.
   * @returns A new agent that answers with the system prompt the built-in or
   * stored agent has now; undefined when no agent has the code.
   * @throws If the store is closed or the stored agent is invalid.
   */
  public findChatAgent(code: string): Agent | undefined {
    const profile =
      this.#builtInAgents.get(code) ?? this.#recordStore.findAgent(code)
    return profile === undefined
      ? undefined
      : new Agent(
          { code: profile.code, systemPrompt: profile.systemPrompt },
          this.#replyModel
        )
  }
}
