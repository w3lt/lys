import type { BuiltInAgentSummary, ListAgentsApiResponse } from "@lys/protocol"
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
import { isExactSearchMatch, hasSearchText } from "../../utils/search"
import { calculateAgentCode } from "./agentCode"
import {
  MAXIMUM_AGENT_SEARCH_MATCHES,
  type AgentCreator,
  type AgentDeleter,
  type AgentDeletionOutcome,
  type AgentEditor,
  type AgentLister,
  type AgentReader,
  type AgentSearcher,
  type AgentSearchMatch,
  type AgentSearchResult,
  type AgentUpdateOutcome,
  type FoundAgent
} from "./capabilities"
import { createAgentListCursor, type AgentListOptions } from "./listOptions"
import type {
  AgentRecordSearcher,
  AgentRecordStore,
  StoredAgentMatch
} from "./records"

/** Records and built-in agents the agent service is built from. */
export type AgentServiceOptions = Readonly<{
  /**
   * Agent records and their search, lent by the composition root, which
   * closes their store.
   */
  recordStore: AgentRecordStore & AgentRecordSearcher
  /**
   * Agents the backend ships with, each code once, in the order they are
   * listed; built once at startup.
   */
  builtInAgents: readonly BuiltInAgent[]
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
 * Tells whether a built-in agent's code, name, or bio contains a search text.
 * @param agent - Listed built-in agent.
 * @param query - Search text, taken literally, ignoring case.
 * @returns True when the agent matches, as a stored agent would.
 */
function hasAgentSearchMatch(
  agent: BuiltInAgentSummary,
  query: string
): boolean {
  return (
    hasSearchText(agent.code, query) ||
    hasSearchText(agent.name, query) ||
    hasSearchText(agent.bio, query)
  )
}

/**
 * Tells whether a built-in agent's code or name equals a search text.
 * @param agent - Listed built-in agent.
 * @param query - Search text, taken literally, ignoring case.
 * @returns True for an exact match, as the records tell for a stored agent.
 */
function isExactAgentSearchMatch(
  agent: BuiltInAgentSummary,
  query: string
): boolean {
  return (
    isExactSearchMatch(agent.code, query) ||
    isExactSearchMatch(agent.name, query)
  )
}

/**
 * Builds the search match of a built-in agent.
 * @param agent - Listed built-in agent.
 * @returns The frozen match; a built-in agent is never deleted.
 */
function buildBuiltInAgentMatch(agent: BuiltInAgentSummary): AgentSearchMatch {
  return Object.freeze({ kind: "built-in", ...agent, deletedAt: null })
}

/**
 * Builds the search match of a stored agent.
 * @param match - Match read from the records.
 * @returns The frozen match with the agent's deletion time.
 */
function buildStoredAgentMatch(match: StoredAgentMatch): AgentSearchMatch {
  return Object.freeze({
    kind: "custom",
    code: match.agent.code,
    name: match.agent.name,
    bio: match.agent.bio,
    deletedAt: match.deletedAt
  })
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
 * or stored agent answers chats under its code through the agent runtime
 * service, which reads it here each time a turn looks it up, so a stored
 * agent's latest system prompt is the one sent. Each create, update, or
 * delete reads the current time once and passes it to everything it stores;
 * nothing it calls reads the clock. Each update or delete is one write
 * transaction that commits before it returns; a create is one write
 * transaction per code it tries. Owns no resource: the records' owner closes
 * their store, after which every records operation fails with `Database is
 * closed`. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export default class AgentService
  implements
    AgentLister,
    AgentReader,
    AgentSearcher,
    AgentCreator,
    AgentEditor,
    AgentDeleter
{
  /**
   * Borrowed records for every stored-agent listing, search, lookup, and
   * change.
   */
  readonly #recordStore: AgentRecordStore & AgentRecordSearcher

  /** Built-in agents by code, in the order they are listed. */
  readonly #builtInAgents: ReadonlyMap<string, BuiltInAgent>

  /** Listed form of every built-in agent, in listing order. */
  readonly #builtInAgentSummaries: readonly BuiltInAgentSummary[]

  /**
   * Retains the borrowed records and the built-in agents without reading the
   * records.
   * @param options - Agent records and the built-in agents.
   */
  public constructor(options: AgentServiceOptions) {
    this.#recordStore = options.recordStore
    this.#builtInAgents = new Map(
      options.builtInAgents.map((agent) => [agent.code, agent])
    )
    this.#builtInAgentSummaries = Object.freeze(
      options.builtInAgents.map(buildBuiltInAgentSummary)
    )
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
   * Finds the built-in and stored agents, deleted ones included, whose code,
   * name, or bio contains a text.
   * @param query - Text found literally, under Unicode simple case folding.
   * @returns At most {@link MAXIMUM_AGENT_SEARCH_MATCHES} frozen matches,
   * read from one store snapshot: exact built-in matches, exact stored ones,
   * the other built-in agents in shipped order, then the other stored agents
   * by creation time and code; and the number of all matches.
   * @throws If the store is closed or a matched agent is invalid.
   */
  public searchAgents(query: string): AgentSearchResult {
    const builtInAgents = this.#builtInAgentSummaries.filter((agent) =>
      hasAgentSearchMatch(agent, query)
    )
    const page = this.#recordStore.searchAgents({
      query,
      limit: MAXIMUM_AGENT_SEARCH_MATCHES
    })
    const matches = [
      ...builtInAgents
        .filter((agent) => isExactAgentSearchMatch(agent, query))
        .map(buildBuiltInAgentMatch),
      ...page.matches
        .filter((match) => match.isExactMatch)
        .map(buildStoredAgentMatch),
      ...builtInAgents
        .filter((agent) => !isExactAgentSearchMatch(agent, query))
        .map(buildBuiltInAgentMatch),
      ...page.matches
        .filter((match) => !match.isExactMatch)
        .map(buildStoredAgentMatch)
    ]
    return Object.freeze({
      matches: Object.freeze(matches.slice(0, MAXIMUM_AGENT_SEARCH_MATCHES)),
      matchCount: builtInAgents.length + page.matchCount
    })
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
   * Reads one built-in or stored agent, deleted or not.
   * @param code - Code to look up as given, compared exactly.
   * @returns The frozen built-in agent with that code, never deleted, else
   * the frozen stored one with its deletion time, each tagged with its kind;
   * undefined when no agent has the code.
   * @throws If the store is closed or the stored agent is invalid.
   */
  public findAgent(code: string): FoundAgent | undefined {
    const builtInAgent = this.#builtInAgents.get(code)
    if (builtInAgent !== undefined)
      return Object.freeze({
        agent: Object.freeze({ kind: "built-in", ...builtInAgent }),
        deletedAt: null
      })
    const record = this.#recordStore.findAgent(code)
    return record === undefined
      ? undefined
      : Object.freeze({
          agent: Object.freeze({ kind: "custom", ...record.agent }),
          deletedAt: record.deletedAt
        })
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
   * Marks one stored agent deleted now, in one write transaction.
   * @param code - Code of the agent to delete, as given.
   * @returns `deleted` when it was stored and not deleted, `missing` when no
   * such agent has the code, and `built-in` when a built-in agent has it,
   * which deletes nothing.
   * @throws If the store is closed or the write fails.
   * @remarks The agent stays stored with the time of its deletion, so its
   * code is never free again: a conversation it answered keeps the code and
   * finds no agent to answer it for good.
   */
  public deleteAgent(code: string): AgentDeletionOutcome {
    if (this.#builtInAgents.has(code)) return "built-in"
    return this.#recordStore.deleteAgent(code, new Date().toISOString())
      ? "deleted"
      : "missing"
  }
}
