import {
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  type AgentCodeTakenProblem,
  type AgentNotFoundProblem
} from "@lys/protocol"

/**
 * Creates the caller-safe missing-agent response.
 *
 * @param agentCode - Validated code that no stored agent has.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by agent endpoint consumers.
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
 * Creates the caller-safe response for a new conversation naming an agent
 * that cannot answer chats.
 *
 * @param agentCode - Validated code that no agent able to answer chats has; a
 * stored agent may have it.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by chat endpoint consumers. Its detail
 * does not claim that no agent has the code.
 */
export function createChatAgentNotFoundProblem(
  agentCode: string,
  instance: string
): AgentNotFoundProblem {
  const { shape } = agentNotFoundProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `No agent that can answer chats has the code ${agentCode}.`,
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
