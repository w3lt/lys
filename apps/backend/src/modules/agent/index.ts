import {
  apiAgentRoute,
  createAgentApi,
  deleteAgentApi,
  getAgentApi,
  listAgentsApi,
  updateAgentApi,
  type CreateAgentApiRoute,
  type DeleteAgentApiRoute,
  type GetAgentApiRoute,
  type ListAgentsApiRoute,
  type UpdateAgentApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import {
  createAgentCodeTakenProblem,
  createAgentNotFoundProblem
} from "./agentProblems"
import type {
  AgentCreator,
  AgentDeleter,
  AgentEditor,
  AgentLister,
  AgentReader
} from "./capabilities"
import { parseAgentListOptions } from "./listOptions"

/**
 * Registers all protocol-defined agent endpoints on a configured backend.
 * @param app - Application with validation and the agent service installed.
 * @returns A promise resolving after route registration.
 * @throws If route registration fails.
 */
export default async function updateFastifyWithAgentRoutes(
  app: FastifyInstance
): Promise<void> {
  app.setSerializerCompiler(serializerCompiler)
  registerAgentCollectionRoutes(app, app.agents)
  registerSingleAgentRoutes(app, app.agents)
}

/**
 * Registers the list and create endpoints, which address the agent collection.
 * @param app - Application receiving the routes.
 * @param agents - Borrowed listing and creation, valid for the application's
 * lifetime.
 */
function registerAgentCollectionRoutes(
  app: FastifyInstance,
  agents: AgentLister & AgentCreator
): void {
  app.route<ListAgentsApiRoute>({
    method: listAgentsApi.method,
    url: listAgentsApi.path,
    schema: {
      querystring: listAgentsApi.querystring,
      response: { 200: listAgentsApi.response }
    },
    handler: async (request) =>
      agents.listAgents(parseAgentListOptions(request.query))
  })
  app.route<CreateAgentApiRoute>({
    method: createAgentApi.method,
    url: createAgentApi.path,
    schema: {
      body: createAgentApi.body,
      response: {
        201: createAgentApi.response,
        ...createAgentApi.responses
      }
    },
    handler: async (request, reply) => handleCreateAgent(request, reply, agents)
  })
}

/**
 * Registers the get, update, and delete endpoints, which address one agent by
 * its code.
 * @param app - Application receiving the routes.
 * @param agents - Borrowed lookup, change, and deletion, valid for the
 * application's lifetime.
 */
function registerSingleAgentRoutes(
  app: FastifyInstance,
  agents: AgentReader & AgentEditor & AgentDeleter
): void {
  app.route<GetAgentApiRoute>({
    method: getAgentApi.method,
    url: getAgentApi.path,
    schema: {
      params: getAgentApi.params,
      response: { 200: getAgentApi.response, ...getAgentApi.responses }
    },
    handler: async (request, reply) => handleGetAgent(request, reply, agents)
  })
  app.route<UpdateAgentApiRoute>({
    method: updateAgentApi.method,
    url: updateAgentApi.path,
    schema: {
      params: updateAgentApi.params,
      body: updateAgentApi.body,
      response: { 200: updateAgentApi.response, ...updateAgentApi.responses }
    },
    handler: async (request, reply) => handleUpdateAgent(request, reply, agents)
  })
  app.route<DeleteAgentApiRoute>({
    method: deleteAgentApi.method,
    url: deleteAgentApi.path,
    schema: {
      params: deleteAgentApi.params,
      response: deleteAgentApi.responses
    },
    handler: async (request, reply) => handleDeleteAgent(request, reply, agents)
  })
}

/**
 * Stores a new agent, or sends the code-taken problem when its given code is
 * already stored.
 * @param request - Validated, trimmed definition.
 * @param reply - HTTP response owner.
 * @param agents - Borrowed agent creation.
 * @returns A promise resolving after the 201 with the agent and its
 * `Location`, or the 409 problem, is sent.
 * @throws If storage access fails.
 */
async function handleCreateAgent(
  request: FastifyRequest<CreateAgentApiRoute>,
  reply: FastifyReply<CreateAgentApiRoute>,
  agents: AgentCreator
): Promise<void> {
  const agent = agents.createAgent(request.body)
  if (agent === undefined) {
    reply
      .type("application/problem+json")
      .code(409)
      .send(createAgentCodeTakenProblem(request.url))
    return
  }
  reply.header("location", apiAgentRoute.replace(":agentCode", agent.code))
  reply.code(201).send(agent)
}

/**
 * Reads one agent or sends the missing-agent problem.
 * @param request - Validated agent code.
 * @param reply - HTTP response owner.
 * @param agents - Borrowed agent lookup.
 * @returns A promise resolving after the status-specific response is sent.
 * @throws If storage access fails.
 */
async function handleGetAgent(
  request: FastifyRequest<GetAgentApiRoute>,
  reply: FastifyReply<GetAgentApiRoute>,
  agents: AgentReader
): Promise<void> {
  const agent = agents.findAgent(request.params.agentCode)
  if (agent === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createAgentNotFoundProblem(request.params.agentCode, request.url))
    return
  }
  reply.code(200).send(agent)
}

/**
 * Applies a change to one agent or sends the missing-agent problem.
 * @param request - Validated agent code and trimmed fields to replace.
 * @param reply - HTTP response owner.
 * @param agents - Borrowed agent change.
 * @returns A promise resolving after the status-specific response is sent.
 * @throws If storage access fails.
 */
async function handleUpdateAgent(
  request: FastifyRequest<UpdateAgentApiRoute>,
  reply: FastifyReply<UpdateAgentApiRoute>,
  agents: AgentEditor
): Promise<void> {
  const agent = agents.updateAgent(request.params.agentCode, request.body)
  if (agent === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createAgentNotFoundProblem(request.params.agentCode, request.url))
    return
  }
  reply.code(200).send(agent)
}

/**
 * Deletes one agent before sending a bodyless success, or sends the
 * missing-agent problem.
 * @param request - Validated agent code.
 * @param reply - HTTP response owner.
 * @param agents - Borrowed agent deletion.
 * @returns A promise resolving after the deletion outcome is sent.
 * @throws If storage access fails.
 */
async function handleDeleteAgent(
  request: FastifyRequest<DeleteAgentApiRoute>,
  reply: FastifyReply<DeleteAgentApiRoute>,
  agents: AgentDeleter
): Promise<void> {
  if (!agents.deleteAgent(request.params.agentCode)) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createAgentNotFoundProblem(request.params.agentCode, request.url))
    return
  }
  reply.code(204).send()
}
