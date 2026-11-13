import type { OpenAIFunctionTool } from "@lys/share"
import type { AgentToolset } from "./toolCallRound"

/**
 * Owns which of a turn's tools one reply offers its model, so each round
 * sends the offer as it is when the round starts.
 *
 * @remarks Invariant: every offered name is a tool of the turn, and the
 * offer lists the offered tools in the turn's toolset order whatever order
 * they were added in. An offer only grows: a tool offered once stays offered
 * until the reply ends. Each list or toolset it returns is a snapshot that
 * later additions leave as it was. Created per reply and dropped with it;
 * holds no resource. Concurrency model: single-owner, used by one reply on
 * the backend's event loop; calls that run in parallel add their tools one
 * after another, each in one synchronous step.
 */
export default class ReplyToolOffer {
  /** Tools of the turn, by name, in toolset order; borrowed for the reply. */
  readonly #tools: AgentToolset

  /** Names of the offered tools, each a tool of the turn. */
  readonly #offeredNames: Set<string>

  /**
   * Creates the offer of one reply.
   *
   * @param tools - Tools of the reply's turn, lent for the reply.
   * @param offeredNames - Names of the tools offered from the first round;
   * a name that is not a tool of the turn is ignored.
   */
  public constructor(tools: AgentToolset, offeredNames: Iterable<string>) {
    this.#tools = tools
    this.#offeredNames = new Set(
      [...offeredNames].filter((name) => tools.has(name))
    )
  }

  /**
   * Offers more of the turn's tools from the next round on.
   *
   * @param names - Names of the tools to offer; a name already offered, or
   * one that is not a tool of the turn, changes nothing.
   */
  public addTools(names: Iterable<string>): void {
    for (const name of names)
      if (this.#tools.has(name)) this.#offeredNames.add(name)
  }

  /**
   * Lists the offered tools as the round that starts now answers their
   * calls.
   *
   * @returns A new toolset of the offered tools in the turn's toolset
   * order, each as the turn's toolset holds it; later additions leave it as
   * it was.
   */
  public listOfferedToolset(): AgentToolset {
    return new Map(
      [...this.#tools].filter(([name]) => this.#offeredNames.has(name))
    )
  }

  /**
   * Lists the offered tools as the model is offered them.
   *
   * @returns A frozen list of function tools in the turn's toolset order;
   * empty when nothing is offered.
   */
  public listOfferedTools(): readonly OpenAIFunctionTool[] {
    return Object.freeze(
      [...this.#tools]
        .filter(([name]) => this.#offeredNames.has(name))
        .map(([, tool]) => tool.agentTool.buildAgentFormat())
    )
  }
}
