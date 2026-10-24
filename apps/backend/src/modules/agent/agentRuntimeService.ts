import type { GetAgentApiResponse } from "@lys/protocol"
import Agent, { type AgentProfile } from "./agent"
import type { AgentRequestState } from "./agentActivity"
import {
  findAgentRole,
  hasAgentPermission,
  type AgentIdentity
} from "./agentRoles"
import type {
  AgentListing,
  AgentRequestView,
  AgentSearchOutcome,
  AgentStateOutcome,
  AgentStateReader,
  AgentStateView
} from "./agentStateTools"
import type {
  AgentReader,
  AgentSearcher,
  AgentSearchMatch,
  FoundAgent
} from "./capabilities"
import type { ReplyContextMeter } from "./replyContextMeter"
import type { ReplyModel } from "./replyModel"

/**
 * Finds the title of a stored conversation.
 *
 * @param conversationId - UUIDv7 of the conversation.
 * @returns Its title; null while it has none, and undefined when it is not
 * stored.
 * @throws If the store is closed or the conversation is invalid.
 */
export type FindConversationTitle = (
  conversationId: string
) => string | null | undefined

/** What the agent runtime service is built from. */
export type AgentRuntimeServiceOptions = Readonly<{
  /** Lookup and search of every built-in and stored agent, deleted ones included. */
  agents: AgentReader & AgentSearcher
  /** Model access lent to every live agent for the service's lifetime. */
  replyModel: ReplyModel
  /**
   * Context meter of the same model, lent to every live agent for the
   * service's lifetime.
   */
  replyContextMeter: ReplyContextMeter
  /** Titles of the conversations the agents' requests belong to. */
  findConversationTitle: FindConversationTitle
}>

/** Shared outcome of a read or search the asking agent may not make. */
const FORBIDDEN_OUTCOME = Object.freeze({ status: "forbidden" } as const)

/** Shared outcome of a state read of a code no agent has. */
const MISSING_OUTCOME = Object.freeze({ status: "missing" } as const)

/** Requests of an agent that has no live instance. */
const NO_REQUESTS: readonly AgentRequestState[] = Object.freeze([])

/**
 * Builds the listing of an agent a search found.
 *
 * @param match - The search match.
 * @returns The frozen listing, with the role its kind gives.
 */
function buildAgentListing(match: AgentSearchMatch): AgentListing {
  return Object.freeze({
    code: match.code,
    name: match.name,
    bio: match.bio,
    role: findAgentRole(match.kind),
    deletedAt: match.deletedAt
  })
}

/**
 * Builds the profile a live agent answers with.
 *
 * @param agent - The built-in or stored agent as found now.
 * @returns Its code, the role its kind gives, and its system prompt.
 */
function buildAgentProfile(agent: GetAgentApiResponse): AgentProfile {
  return Object.freeze({
    code: agent.code,
    role: findAgentRole(agent.kind),
    systemPrompt: agent.systemPrompt
  })
}

/**
 * Keeps one live {@link Agent} per agent that has answered a turn, and tells
 * agents about themselves and each other as their roles allow.
 *
 * @remarks An agent becomes live the first time a turn or a measurement loads
 * it, and stays live for the service's lifetime, so every turn of an agent,
 * overlapping or not, runs on one instance that knows all of them. Each load
 * gives the live agent the system prompt the agent has now; a
 * reply already running keeps the prompt it started with. A deleted agent
 * answers no new turn, but its live instance stays, so the replies it still
 * writes stay listed. A state read or search checks the asking agent's
 * permission before it reads anything, and never makes an agent live: an
 * agent that is not live is working on no request. Owns its live agents,
 * which own no resource; the model's owner releases the model access and its
 * meter, and the records' owner closes the store, after which every load,
 * read, and search fails with `Database is closed`. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export default class AgentRuntimeService implements AgentStateReader {
  /** Borrowed lookup and search of every agent. */
  readonly #agents: AgentReader & AgentSearcher

  /** Borrowed model access every live agent writes its replies through. */
  readonly #replyModel: ReplyModel

  /** Borrowed meter every live agent measures its contexts with. */
  readonly #replyContextMeter: ReplyContextMeter

  /** Borrowed lookup of the titles of the requests' conversations. */
  readonly #findConversationTitle: FindConversationTitle

  /** Live agents by code, each created on its agent's first load. */
  readonly #liveAgents = new Map<string, Agent>()

  /**
   * Retains the borrowed lookups and model access without reading anything.
   * @param options - Agent lookup and search, model access, its meter, and
   * the conversation title lookup.
   */
  public constructor(options: AgentRuntimeServiceOptions) {
    this.#agents = options.agents
    this.#replyModel = options.replyModel
    this.#replyContextMeter = options.replyContextMeter
    this.#findConversationTitle = options.findConversationTitle
  }

  /**
   * Loads the live agent that answers chats under a code: makes the agent
   * live on its first load and gives it the system prompt it has now.
   * @param code - Agent code as given, compared exactly.
   * @returns The agent's live instance, created on its first load and
   * holding the system prompt the built-in or stored agent has now; undefined
   * when no agent has the code or its agent is deleted, which creates
   * nothing.
   * @throws If the store is closed or the stored agent is invalid.
   */
  public loadChatAgent(code: string): Agent | undefined {
    const found = this.#agents.findAgent(code)
    if (found === undefined || found.deletedAt !== null) return undefined
    const liveAgent = this.#liveAgents.get(code)
    if (liveAgent !== undefined) {
      liveAgent.updateSystemPrompt(found.agent.systemPrompt)
      return liveAgent
    }
    const createdAgent = new Agent(buildAgentProfile(found.agent), {
      replyModel: this.#replyModel,
      replyContextMeter: this.#replyContextMeter,
      stateReader: this
    })
    this.#liveAgents.set(code, createdAgent)
    return createdAgent
  }

  /**
   * Finds the agents whose code, name, or bio contains a text.
   * @param reader - The agent that asks.
   * @param query - Trimmed, bounded text, as
   * {@link AgentStateReader.findAgents} takes it.
   * @returns `forbidden` without searching when the reader's role does not
   * grant `find-agents`; otherwise `found` with the frozen first matches in
   * search order, deleted agents included, each with the role its kind
   * gives, and the number of all matches.
   * @throws If the store is closed or a matched agent is invalid.
   */
  public findAgents(reader: AgentIdentity, query: string): AgentSearchOutcome {
    if (!hasAgentPermission(reader.role, "find-agents"))
      return FORBIDDEN_OUTCOME
    const result = this.#agents.searchAgents(query)
    return Object.freeze({
      status: "found",
      matches: Object.freeze(result.matches.map(buildAgentListing)),
      matchCount: result.matchCount
    })
  }

  /**
   * Reads the state of one agent.
   * @param reader - The agent that asks.
   * @param code - Code of the agent to read, compared exactly.
   * @returns `forbidden` without reading when the reader's role does not
   * grant `read-own-state` for its own code or `read-any-state` for another;
   * `missing` when no agent has the code; else `found` with the frozen state:
   * the agent's name, role, and deletion, and the requests its live instance
   * is working on, each with its conversation's title read now; none when
   * the agent is not live. The read makes no agent live.
   * @throws If the store is closed, or the agent or a conversation is
   * invalid.
   */
  public readAgentState(
    reader: AgentIdentity,
    code: string
  ): AgentStateOutcome {
    const permission =
      code === reader.code ? "read-own-state" : "read-any-state"
    if (!hasAgentPermission(reader.role, permission)) return FORBIDDEN_OUTCOME
    const found = this.#agents.findAgent(code)
    if (found === undefined) return MISSING_OUTCOME
    return Object.freeze({ status: "found", state: this.#buildState(found) })
  }

  /**
   * Builds the state of one found agent.
   * @param found - The agent and its deletion.
   * @returns The frozen state, with the requests of its live instance.
   * @throws If the store is closed or a conversation is invalid.
   */
  #buildState(found: FoundAgent): AgentStateView {
    const requests =
      this.#liveAgents.get(found.agent.code)?.listRequests() ?? NO_REQUESTS
    return Object.freeze({
      code: found.agent.code,
      name: found.agent.name,
      role: findAgentRole(found.agent.kind),
      deletedAt: found.deletedAt,
      requests: Object.freeze(
        requests.map((request): AgentRequestView =>
          Object.freeze({
            ...request,
            conversationTitle: this.#findConversationTitle(
              request.conversationId
            )
          })
        )
      )
    })
  }
}
