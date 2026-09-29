import { agentCreationOptionsSchema, type AgentCreationOptions } from "../agentManager"

export class Agent {
  /**
   * Code is the identifier of agent
   */
  readonly #code: string

  /**
   * Agent name
   */
  readonly #name: string

  /**
   * Bio of agent
   */
  readonly #bio: string

  /**
   * Agent system prompt
   */
  readonly #systemPrompt: string
  

  constructor(options: AgentCreationOptions) {
    const { code, name, bio, systemPrompt } = agentCreationOptionsSchema.parse(options)
    this.#code = code
    this.#name = name
    this.#bio = bio
    this.#systemPrompt = systemPrompt
  }
}
