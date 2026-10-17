import {
  chatContextApi,
  createLlmHealthProblem,
  type ChatContextApiRequestBody,
  type ChatContextApiRoute
} from "@lys/protocol"
import type {
  Conversation,
  ConversationMessage,
  ToolDefinition
} from "@lys/share"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import handleLlmServiceRequestFailure from "../../llm/routes/handleLlmServiceRequestFailure"
import type { BuiltInToolEntry } from "../../tool/builtIn/builtInTool"
import {
  findRequestedAgent,
  findRequestedBuiltInTools,
  sendUnansweredTurnProblem,
  type TurnAgentLookups
} from "./turnRequest"

/** Lookups the chat-context route borrows for its lifetime. */
type ChatContextRouteDependencies = Pick<TurnAgentLookups, "findChatAgent"> &
  Readonly<{
    /**
     * Stored conversation with its messages; undefined means it is not
     * stored.
     */
    findConversation: (conversationId: string) => Conversation | undefined
    /** Every tool the backend runs, which a request may offer by name. */
    builtInTools: readonly BuiltInToolEntry[]
  }>

/** Stored messages of a conversation that has none yet. */
const NO_CONVERSATION_MESSAGES: readonly ConversationMessage[] = Object.freeze(
  []
)

/** Explanation sent when no loaded instance matches the requested model. */
const MODEL_NOT_LOADED_DETAIL =
  "The model is not loaded in LM Studio. Load it in Settings → Model to measure the conversation."

/**
 * Registers the endpoint that measures the context a conversation's next
 * message would be sent with.
 *
 * @param app - Backend with validation, the Zod response serializer, the
 * agent service, the conversation reader, the LLM service behind the agents,
 * and the backend tools installed.
 * @throws If route registration fails.
 * @remarks Every response prevents caching, because a measurement observes
 * the loaded model at the moment it ran. A full model-operation queue and a
 * missing or lost LLM runtime are answered with their 503 problems.
 */
export default function registerChatContextRoute(app: FastifyInstance): void {
  const dependencies = {
    findChatAgent: (code: string) => app.agentService.findChatAgent(code),
    findConversation: (conversationId: string) =>
      app.conversationHistoryReader.getConversation(conversationId),
    builtInTools: app.builtInTools
  } satisfies ChatContextRouteDependencies
  app.route<ChatContextApiRoute>({
    method: chatContextApi.method,
    url: chatContextApi.path,
    schema: { body: chatContextApi.body, response: chatContextApi.responses },
    onRequest: (_request, reply) => {
      reply.header("Cache-Control", "no-store")
      return Promise.resolve()
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request, reply) =>
      await handleChatContextRequest(request, reply, dependencies)
  })
}

/**
 * Measures the context of the requested conversation's next message and
 * sends it.
 *
 * @param request - Validated chat-context input.
 * @param reply - Response owner.
 * @param dependencies - Borrowed agent, conversation, and tool lookups.
 * @returns Settlement after the measurement or a problem is sent.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run; and the agent's measurement failure, for the route's
 * error handler.
 * @remarks A continued conversation is read once, and its agent and stored
 * messages both come from that read, before the measurement waits for the
 * model's runtime.
 */
async function handleChatContextRequest(
  request: FastifyRequest<ChatContextApiRoute>,
  reply: FastifyReply<ChatContextApiRoute>,
  dependencies: ChatContextRouteDependencies
): Promise<void> {
  const { body } = request
  const builtInTools = findRequestedBuiltInTools(
    dependencies.builtInTools,
    body.tools
  )
  const storedConversation =
    body.conversation.kind === "existing"
      ? dependencies.findConversation(body.conversation.id)
      : undefined
  const requestedAgent = findRequestedAgent(body.conversation, {
    findChatAgent: dependencies.findChatAgent,
    findConversationAgentCode: () => storedConversation?.agentCode
  })
  if (requestedAgent.status !== "found") {
    sendUnansweredTurnProblem(reply, requestedAgent, request.url)
    return
  }
  const measurement = await requestedAgent.agent.findContextMeasurement({
    history: storedConversation?.messages ?? NO_CONVERSATION_MESSAGES,
    model: body.model,
    tools: buildOfferedDefinitions(body, builtInTools)
  })
  if (measurement === undefined) {
    const problem = createLlmHealthProblem({
      reason: "model-not-loaded",
      detail: MODEL_NOT_LOADED_DETAIL,
      instance: request.url
    })
    reply.type("application/problem+json").code(problem.status).send(problem)
    return
  }
  reply.code(200).send(measurement)
}

/**
 * Builds the definitions of the tools a request offers, as a turn orders them.
 *
 * @param body - Validated chat-context input.
 * @param builtInTools - The offered backend tools, in offer order.
 * @returns The client definitions first, then the backend tools'.
 */
function buildOfferedDefinitions(
  body: ChatContextApiRequestBody,
  builtInTools: readonly BuiltInToolEntry[]
): readonly ToolDefinition[] {
  return [
    ...(body.tools?.definitions ?? []),
    ...builtInTools.map((entry) => entry.definition)
  ]
}
