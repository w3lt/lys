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
 * @throws If route registration fails. The failure rejects the promise, so
 * `app.register` reports it rather than an uncaught exception.
 */
export default function updateFastifyWithAgentRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    app.setSerializerCompiler(serializerCompiler)
    registerAgentCollectionRoutes(app, app.agents)
    registerSingleAgentRoutes(app, app.agents)
    resolve()
  })
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
    handler: (request) =>
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
    handler: (request, reply) => handleCreateAgent(request, reply, agents)
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
    handler: (request, reply) => handleGetAgent(request, reply, agents)
  })
  app.route<UpdateAgentApiRoute>({
    method: updateAgentApi.method,
    url: updateAgentApi.path,
    schema: {
      params: updateAgentApi.params,
      body: updateAgentApi.body,
      response: { 200: updateAgentApi.response, ...updateAgentApi.responses }
    },
    handler: (request, reply) => handleUpdateAgent(request, reply, agents)
  })
  app.route<DeleteAgentApiRoute>({
    method: deleteAgentApi.method,
    url: deleteAgentApi.path,
    schema: {
      params: deleteAgentApi.params,
      response: deleteAgentApi.responses
    },
    handler: (request, reply) => handleDeleteAgent(request, reply, agents)
  })
}

/**
 * Stores a new agent and sends it with a 201 and its `Location`, or sends the
 * 409 code-taken problem when its given code is already stored.
 * @param request - Validated, trimmed definition.
 * @param reply - HTTP response owner.
 * @param agents - Borrowed agent creation.
 * @throws If storage access fails.
 */
function handleCreateAgent(
  request: FastifyRequest<CreateAgentApiRoute>,
  reply: FastifyReply<CreateAgentApiRoute>,
  agents: AgentCreator
): void {
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
 * @throws If storage access fails.
 */
function handleGetAgent(
  request: FastifyRequest<GetAgentApiRoute>,
  reply: FastifyReply<GetAgentApiRoute>,
  agents: AgentReader
): void {
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
 * @throws If storage access fails.
 */
function handleUpdateAgent(
  request: FastifyRequest<UpdateAgentApiRoute>,
  reply: FastifyReply<UpdateAgentApiRoute>,
  agents: AgentEditor
): void {
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
 * @throws If storage access fails.
 */
function handleDeleteAgent(
  request: FastifyRequest<DeleteAgentApiRoute>,
  reply: FastifyReply<DeleteAgentApiRoute>,
  agents: AgentDeleter
): void {
  if (!agents.deleteAgent(request.params.agentCode)) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createAgentNotFoundProblem(request.params.agentCode, request.url))
    return
  }
  reply.code(204).send()
}
