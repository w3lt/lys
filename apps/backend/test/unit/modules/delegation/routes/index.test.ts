import {
  conversationNotFoundProblemSchema,
  stopConversationJobsApi
} from "@lys/protocol"
import type { JobState } from "@lys/share"
import { describe, expect, it } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import { stopConversationJobs } from "../../../../../src/modules/delegation/jobStops"
import registerDelegationRoutes from "../../../../../src/modules/delegation/routes"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import {
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  startPersonTurn,
  type DelegationTestServices,
  type JobMessageRequest
} from "../../../support/delegationTestServices"
import { createTestFastify } from "../../../support/fastifyTestApp"

/** Work a case gives {@link SECOND_MEMBER} beside the moths job. */
const ARCHIVE_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: SECOND_MEMBER,
  title: "Archive",
  instructions: "File what is known about moths",
  jobNumber: undefined
})

/**
 * Creates an application with the HTTP transport and the delegation routes
 * registered over a delegation runtime.
 *
 * @returns The application, the destination of its log, and the delegation
 * test services the routes use.
 * @remarks The routes read the services' history reader and stop the jobs
 * of a conversation as the services' runtime stops them for the person, so
 * a case starts a person's turn and its jobs with the services. When the
 * test finishes, the services' registry is disposed first, then their
 * in-memory database is closed, then the application.
 */
async function createDelegationRouteApp() {
  const testFastify = createTestFastify()
  const services = openDelegationTestServices()
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate(
    "conversationHistoryReader",
    services.conversation.history
  )
  testFastify.app.decorate("stopConversationJobs", (conversationId) =>
    stopConversationJobs(services.runtime, conversationId)
  )
  await registerDelegationRoutes(testFastify.app)
  return { ...testFastify, services }
}

/**
 * Fills the jobs-stop path with a raw conversation identifier.
 *
 * @param conversationId - Raw conversation identifier, possibly malformed.
 * @returns The request URL.
 */
function createJobsStopUrl(conversationId: string): string {
  return stopConversationJobsApi.path.replace(":conversationId", conversationId)
}

/**
 * Lists the states of a conversation's jobs.
 *
 * @param services - The case's runtime.
 * @param conversationId - UUIDv7 of the conversation.
 * @returns The state of each job, in number order.
 */
function listJobStates(
  services: Pick<DelegationTestServices, "runtime">,
  conversationId: string
): readonly JobState[] {
  return services.runtime.jobs.listJobs(conversationId).map((job) => job.state)
}

describe("registerDelegationRoutes", () => {
  it("POST /api/v1/chat/:conversationId/jobs/stop answers 204 and stops the working jobs", async () => {
    const { app, services } = await createDelegationRouteApp()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    sendJobMessage(services, lead, MOTHS_REQUEST)
    sendJobMessage(services, lead, ARCHIVE_REQUEST)

    const response = await app.inject({
      method: stopConversationJobsApi.method,
      url: createJobsStopUrl(conversationId)
    })

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
    expect(listJobStates(services, conversationId)).toEqual([
      "stopped",
      "stopped"
    ])
    expect(services.runtime.jobActivity.hasStreamingReply(conversationId)).toBe(
      true
    )
  })

  it("answers 204 when no job is working and leaves the finished jobs and the conversation's reply as they are", async () => {
    const { app, services } = await createDelegationRouteApp()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(job.replyId, "completed")

    const response = await app.inject({
      method: stopConversationJobsApi.method,
      url: createJobsStopUrl(conversationId)
    })

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
    expect(listJobStates(services, conversationId)).toEqual(["replied"])
    expect(services.runtime.jobActivity.hasStreamingReply(conversationId)).toBe(
      true
    )
  })

  it("answers 404 with the conversation-not-found problem for an unknown conversation, and stops nothing", async () => {
    const { app, services } = await createDelegationRouteApp()
    const conversationId = createFixtureUuidV7(404)
    const url = createJobsStopUrl(conversationId)

    const response = await app.inject({
      method: stopConversationJobsApi.method,
      url
    })

    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    const problem: unknown = response.json()
    expect(conversationNotFoundProblemSchema.safeParse(problem).success).toBe(
      true
    )
    expect(problem).toEqual({
      type: "urn:lys:problem:conversation:not-found",
      title: "Conversation not found",
      status: 404,
      detail: `Conversation ${conversationId} was not found.`,
      instance: url
    })
    expect(services.reportEvent).not.toHaveBeenCalled()
  })

  it("rejects a conversation identifier that is not a UUIDv7 with 400 and stops nothing", async () => {
    const { app, services } = await createDelegationRouteApp()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    sendJobMessage(services, lead, MOTHS_REQUEST)

    const response = await app.inject({
      method: stopConversationJobsApi.method,
      url: createJobsStopUrl("conversation-1")
    })

    expect(response.statusCode).toBe(400)
    expect(listJobStates(services, conversationId)).toEqual(["working"])
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stop-requested" })
    )
  })
})
