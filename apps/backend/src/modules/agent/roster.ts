import Agent from "./agent"
import type { ReplyModel } from "./replyModel"

/**
 * Code of Lys, the agent every new conversation gets.
 *
 * @remarks Stored on conversations since schema version 7, which recorded it
 * on every earlier conversation; changing it orphans those conversations.
 */
const LYS_AGENT_CODE = "lys"

/** Settings and model access the roster builds its agents from. */
export type AgentRosterOptions = Readonly<{
  /** Lys's system prompt: non-empty text read once at startup. */
  lysSystemPrompt: string
  /** Model access lent to every agent for the roster's lifetime. */
  replyModel: ReplyModel
}>

/**
 * Retains the agents that can answer chats to resolve the agent of each
 * turn.
 *
 * @remarks Holds only Lys, under the code `lys`; stored agents cannot answer
 * chats yet. Owns no resource: the model's owner releases it. Concurrency
 * model: reentrant; nothing changes after construction and every agent is
 * reentrant.
 */
export default class AgentRoster {
  /** Lys, built once from the configured prompt. */
  readonly #lys: Agent

  /**
   * Builds the agents without contacting their model.
   * @param options - Lys's system prompt and the model access every agent
   * borrows.
   */
  public constructor(options: AgentRosterOptions) {
    this.#lys = new Agent(
      { code: LYS_AGENT_CODE, systemPrompt: options.lysSystemPrompt },
      options.replyModel
    )
  }

  /**
   * Returns the agent a new conversation gets.
   * @returns Lys.
   */
  public getDefaultAgent(): Agent {
    return this.#lys
  }

  /**
   * Finds the agent that answers conversations stored with a code.
   * @param code - Agent code as stored, compared exactly.
   * @returns The agent, or undefined when no agent in the roster has the code.
   */
  public findAgent(code: string): Agent | undefined {
    return code === this.#lys.code ? this.#lys : undefined
  }
}
