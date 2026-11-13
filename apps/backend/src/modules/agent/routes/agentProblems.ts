import {
  agentBuiltInProblemSchema,
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  conversationAgentMissingProblemSchema,
  type AgentBuiltInProblem,
  type AgentCodeTakenProblem,
  type AgentNotFoundProblem,
  type ConversationAgentMissingProblem
} from "@lys/protocol"

/**
 * Creates the caller-safe missing-agent response.
 *
 * @param agentCode - Validated code that no built-in or stored agent has.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by agent and chat endpoint consumers.
 */
export function createAgentNotFoundProblem(
  agentCode: string,
  instance: string
): AgentNotFoundProblem {
  const { shape } = agentNotFoundProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `Agent ${agentCode} was not found.`,
    instance
  }
}

/**
 * Creates the caller-safe response for a request to change or delete a
 * built-in agent.
 *
 * @param agentCode - Validated code of the built-in agent.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by update and delete agent consumers.
 */
export function createBuiltInAgentProblem(
  agentCode: string,
  instance: string
): AgentBuiltInProblem {
  const { shape } = agentBuiltInProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `Agent ${agentCode} is built in and cannot be changed or deleted.`,
    instance
  }
}

/**
 * Creates the caller-safe response for a turn in a stored conversation whose
 * agent no longer exists.
 *
 * @param agentCode - Valid code stored with the conversation, which no
 * built-in or stored agent has.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by chat endpoint consumers.
 */
export function createConversationAgentMissingProblem(
  agentCode: string,
  instance: string
): ConversationAgentMissingProblem {
  const { shape } = conversationAgentMissingProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `The agent ${agentCode} that answers this conversation no longer exists.`,
    instance
  }
}

/**
 * Creates the caller-safe response for creating an agent under a taken code.
 *
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by create-agent consumers. Its detail
 * does not repeat the code: only a code the caller sent can be taken.
 */
export function createAgentCodeTakenProblem(
  instance: string
): AgentCodeTakenProblem {
  const { shape } = agentCodeTakenProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: "Another agent already has the requested code.",
    instance
  }
}
