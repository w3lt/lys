import type { GetAgentApiResponse } from "@lys/protocol"
import { ARMITAGE_AGENT_CODE } from "@lys/share"
import type { ToolSearchCallRecordWriter } from "../conversation/records"
import Agent, { type AgentProfile } from "./agent"
import type { AgentRequestLimits, AgentRequestState } from "./agentActivity"
import {
  calculateAgentRole,
  hasAgentPermission,
  type AgentIdentity
} from "./agentRoles"
import type {
  AgentListing,
  AgentRequestView,
  AgentSearchOutcome,
  AgentStateOutcome,
  AgentStateReader,
  AgentStateView,
  ConversationTitleLookup
} from "./agentStateTools"
import type {
  AgentReader,
  AgentSearcher,
  AgentSearchMatch,
  FoundAgent
} from "./capabilities"
import type { ToolKeeper, ToolSearch, ToolSearchOutcome } from "./findToolsTool"
import type { ReplyContextMeter } from "./replyContextMeter"
import type { ReplyModel } from "./replyModel"
import { runToolKeeperSearch } from "./toolKeeperSearch"

/**
 * Finds the title of a stored conversation.
 *
 * @param conversationId - UUIDv7 of the conversation.
 * @returns `found` with its title, null while it has none; `missing` when it
 * is not stored.
 * @throws If the store is closed or the conversation is invalid.
 */
export type FindConversationTitle = (
  conversationId: string
) => ConversationTitleLookup

/** Shared lookup of a conversation that is not stored. */
const MISSING_CONVERSATION_TITLE: ConversationTitleLookup = Object.freeze({
  status: "missing"
})

/**
 * Builds the title lookup of a conversation as its store found it.
 *
 * @param conversation - The stored conversation, or undefined when none has
 * the id.
 * @returns `missing` for no conversation; else frozen `found` with its title,
 * null while it has none.
 */
export function buildConversationTitleLookup(
  conversation: Readonly<{ title: string | null }> | undefined
): ConversationTitleLookup {
  if (conversation === undefined) return MISSING_CONVERSATION_TITLE
  return Object.freeze({ status: "found", title: conversation.title })
}

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
  /**
   * Request slots and waiting limit every live agent gets, each agent its
   * own slots and line.
   */
  requestLimits: AgentRequestLimits
  /**
   * Store of the decision records of tool searches' own tool calls, lent
   * for the service's lifetime.
   */
  toolSearchCallRecords: ToolSearchCallRecordWriter
}>

/** Shared outcome of a read or search the asking agent may not make. */
const FORBIDDEN_OUTCOME = Object.freeze({ status: "forbidden" } as const)

/** Shared outcome of a state read of a code no agent has. */
const MISSING_OUTCOME = Object.freeze({ status: "missing" } as const)

/** Requests of an agent that has no live instance. */
const NO_REQUESTS: readonly AgentRequestState[] = Object.freeze([])

/** Outcome of a tool search that could not run. */
const FAILED_TOOL_SEARCH: ToolSearchOutcome = Object.freeze({
  status: "failed"
})

/**
 * Builds the listing of an agent a search found.
 *
 * @param match - The search match.
 * @returns The frozen listing, with the role its code and kind give.
 */
function buildAgentListing(match: AgentSearchMatch): AgentListing {
  return Object.freeze({
    code: match.code,
    name: match.name,
    bio: match.bio,
    role: calculateAgentRole(match),
    deletedAt: match.deletedAt
  })
}

/**
 * Builds the profile a live agent answers with.
 *
 * @param agent - The built-in or stored agent as found now.
 * @param requestLimits - Request slots and waiting limit of every agent.
 * @returns Its code, the role its code and kind give, its system prompt,
 * and the request limits.
 */
function buildAgentProfile(
  agent: GetAgentApiResponse,
  requestLimits: AgentRequestLimits
): AgentProfile {
  return Object.freeze({
    code: agent.code,
    role: calculateAgentRole(agent),
    systemPrompt: agent.systemPrompt,
    requestLimits
  })
}

/**
 * Keeps one live {@link Agent} per agent a request has loaded, tells agents
 * about themselves and each other as their roles allow, and has Armitage,
 * the tool keeper, find the tools a routed turn needs.
 *
 * @remarks An agent becomes live the first time a chat or a context
 * measurement loads it, even for a request refused after the load, and
 * Armitage on its first tool search; each stays live for the service's
 * lifetime, so every turn of an agent, overlapping or
 * not, runs on one instance that knows all of them and shares its request
 * slots among them; each live agent has its own slots. Each load gives the live
 * agent the system prompt the agent has now; a reply already running keeps
 * the prompt it started with. A deleted agent answers no new turn, but its
 * live instance stays, so the replies it still writes stay listed. A state
 * read or search checks the asking agent's permission before it reads
 * anything, and never makes an agent live: an agent that is not live is
 * working on no request. Owns its live agents, which own no resource; the
 * model's owner releases the model access and its meter, and the records'
 * owner closes the store. After that, a load of a stored agent's code and a
 * permitted read or search fail with `Database is closed`, and so does
 * the record of a tool search's first tool call, which fails the search; a
 * built-in agent's load and a refused read or search touch no store. Concurrency model: single-owner on the backend's event loop; loads,
 * reads, and searches of agents are synchronous, and tool searches run
 * asynchronously as requests of Armitage's live agent, overlapping searches
 * sharing its request slots.
 */
export default class AgentRuntimeService
  implements AgentStateReader, ToolKeeper
{
  /** Borrowed lookup and search of every agent. */
  readonly #agents: AgentReader & AgentSearcher

  /** Borrowed model access every live agent writes its replies through. */
  readonly #replyModel: ReplyModel

  /** Borrowed meter every live agent measures its contexts with. */
  readonly #replyContextMeter: ReplyContextMeter

  /** Borrowed lookup of the titles of the requests' conversations. */
  readonly #findConversationTitle: FindConversationTitle

  /** Request slots and waiting limit every live agent gets. */
  readonly #requestLimits: AgentRequestLimits

  /** Borrowed store of the records of tool searches' own tool calls. */
  readonly #toolSearchCallRecords: ToolSearchCallRecordWriter

  /** Live agents by code, each created on its agent's first load. */
  readonly #liveAgents = new Map<string, Agent>()

  /**
   * Retains the borrowed lookups and model access without reading anything.
   * @param options - Agent lookup and search, model access, its meter, the
   * conversation title lookup, the request limits of every agent, and the
   * store of tool searches' call records.
   */
  public constructor(options: AgentRuntimeServiceOptions) {
    this.#agents = options.agents
    this.#replyModel = options.replyModel
    this.#replyContextMeter = options.replyContextMeter
    this.#findConversationTitle = options.findConversationTitle
    this.#requestLimits = options.requestLimits
    this.#toolSearchCallRecords = options.toolSearchCallRecords
  }

  /**
   * Loads the live agent that answers chats under a code: makes the agent
   * live on its first load and gives it the system prompt it has now.
   * @param code - Agent code as given, compared exactly.
   * @returns The agent's live instance, created on its first load with every
   * request slot free and the service's request limits, and holding the
   * system prompt the built-in or stored agent has now; undefined
   * when no agent has the code, its agent is deleted, or it is Armitage, the
   * tool keeper, which answers agents, not chats; that creates nothing.
   * @throws For a code that is not a built-in agent's, if the store is closed
   * or the stored agent is invalid.
   */
  public loadChatAgent(code: string): Agent | undefined {
    if (code === ARMITAGE_AGENT_CODE) return undefined
    const found = this.#agents.findAgent(code)
    if (found?.deletedAt !== null) return undefined
    return this.#loadLiveAgent(found.agent)
  }

  /**
   * Has Armitage, the tool keeper, find the tools that fit a task.
   *
   * @param search - As {@link ToolKeeper.findTools} takes it.
   * @returns As {@link ToolKeeper.findTools} returns; `failed`, after
   * reporting why, also when Armitage is not one of the built-in agents.
   * The search runs on Armitage's live agent, made live on the first
   * search, as {@link runToolKeeperSearch} runs it.
   * @throws The signal's abort reason once `search.abortSignal` aborts.
   */
  public async findTools(search: ToolSearch): Promise<ToolSearchOutcome> {
    const found = this.#agents.findAgent(ARMITAGE_AGENT_CODE)
    if (found === undefined) {
      search.reportFailure(
        new Error("Armitage, the built-in tool keeper, is not defined")
      )
      return FAILED_TOOL_SEARCH
    }
    return await runToolKeeperSearch(
      this.#loadLiveAgent(found.agent),
      search,
      this.#toolSearchCallRecords
    )
  }

  /**
   * Lists the agents whose code, name, or bio contains a text.
   * @param reader - The agent that asks.
   * @param query - Trimmed, bounded text, as
   * {@link AgentStateReader.listAgentMatches} takes it.
   * @returns `forbidden` without searching when the reader's role does not
   * grant `find-agents`; otherwise `found` with the frozen first matches in
   * search order, deleted agents included, each with the role its kind
   * gives, and the number of all matches.
   * @throws If the store is closed or a matched agent is invalid.
   */
  public listAgentMatches(
    reader: AgentIdentity,
    query: string
  ): AgentSearchOutcome {
    if (!hasAgentPermission(reader.role, "find-agents"))
      return FORBIDDEN_OUTCOME
    const result = this.#agents.listAgentMatches(query)
    return Object.freeze({
      status: "found",
      matches: Object.freeze(result.matches.map(buildAgentListing)),
      matchCount: result.matchCount
    })
  }

  /**
   * Finds the state of one agent.
   * @param reader - The agent that asks.
   * @param code - Code of the agent to read, compared exactly.
   * @returns `forbidden` without reading when the reader's role does not
   * grant `read-own-state` for its own code or `read-any-state` for another;
   * `missing` when no agent has the code; else `found` with the frozen state:
   * the agent's name, role, deletion, and request slot count, and the
   * requests its live instance is working on or that wait for a slot, each
   * with its conversation's title read now; none when the agent is not
   * live. The read makes no agent live.
   * @throws If the store is closed, or the agent or a conversation is
   * invalid.
   */
  public findAgentState(
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
   * Loads the live agent of an agent as found now.
   * @param agent - The built-in or stored agent.
   * @returns Its live instance, holding the agent's system prompt now;
   * created on the agent's first load with every request slot free and the
   * service's request limits.
   */
  #loadLiveAgent(agent: GetAgentApiResponse): Agent {
    const liveAgent = this.#liveAgents.get(agent.code)
    if (liveAgent !== undefined) {
      liveAgent.updateSystemPrompt(agent.systemPrompt)
      return liveAgent
    }
    const createdAgent = new Agent(
      buildAgentProfile(agent, this.#requestLimits),
      {
        replyModel: this.#replyModel,
        replyContextMeter: this.#replyContextMeter,
        stateReader: this,
        toolKeeper: this
      }
    )
    this.#liveAgents.set(agent.code, createdAgent)
    return createdAgent
  }

  /**
   * Builds the state of one found agent.
   * @param found - The agent and its deletion.
   * @returns The frozen state, with the request slot count every agent has
   * and the requests of its live instance.
   * @throws If the store is closed or a conversation is invalid.
   */
  #buildState(found: FoundAgent): AgentStateView {
    const requests =
      this.#liveAgents.get(found.agent.code)?.listRequests() ?? NO_REQUESTS
    return Object.freeze({
      code: found.agent.code,
      name: found.agent.name,
      role: calculateAgentRole(found.agent),
      deletedAt: found.deletedAt,
      requestSlotCount: this.#requestLimits.slotCount,
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
