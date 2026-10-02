import {
  createLlmServiceBusyProblem,
  llmRuntimeUnavailableProblemSchema
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import handleLlmServiceRequestFailure from "../../../../../src/modules/llm/routes/handleLlmServiceRequestFailure"
import { createTestFastify } from "../../../support/fastifyTestApp"

/**
 * Registers a route whose handler rejects with the given failure and whose
 * error boundary is the handler under test.
 *
 * @param failure - Rejection raised by the route handler.
 * @returns The test application.
 */
function createFailingRouteApp(failure: unknown) {
  const testFastify = createTestFastify()
  testFastify.app.get("/failing", {
    errorHandler: handleLlmServiceRequestFailure,
    handler: async () => {
      throw failure
    }
  })
  return testFastify
}

describe("handleLlmServiceRequestFailure", () => {
  it("answers a refused admission with the service-busy problem", async () => {
    const { app } = createFailingRouteApp(createLlmServiceBusyError())

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
  })

  it("delegates any other failure to the application error handler", async () => {
    const failure = new Error("The LLM runtime could not load the model.")
    const { app } = createFailingRouteApp(failure)
    const handledFailures: unknown[] = []
    app.setErrorHandler(async (error, _request, reply) => {
      handledFailures.push(error)
      return reply.code(502).send({ handledBy: "application" })
    })

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ handledBy: "application" })
    expect(handledFailures).toEqual([failure])
    expect(handledFailures[0]).toBe(failure)
  })

  it("leaves an unrecognized failure to Fastify's default error response", async () => {
    const { app } = createFailingRouteApp(new Error("socket closed"))

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(500)
    expect(response.headers["content-type"]).not.toMatch(
      /application\/problem\+json/
    )
  })

  it("answers a runtime refusal without runtime work with the runtime-unavailable problem and no log", async () => {
    const { app, logs } = createFailingRouteApp(
      createLlmRuntimeUnavailableError([])
    )

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
    expect(logs.filter((record) => "err" in record)).toEqual([])
  })

  it("logs retained runtime failures at warn before answering with the runtime-unavailable problem", async () => {
    const runtimeFailure = new Error("connect ECONNREFUSED /private/lms.sock")
    const { app, logs } = createFailingRouteApp(
      createLlmRuntimeUnavailableError([runtimeFailure])
    )
    let logCountAtSend: number | undefined = undefined
    app.addHook("onSend", async () => {
      logCountAtSend = logs.length
    })

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(503)
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
    expect(response.body).not.toContain("ECONNREFUSED")
    const warnings = logs.filter(({ level }) => level === "warn")
    expect(warnings).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({
          aggregateErrors: [
            expect.objectContaining({ message: runtimeFailure.message })
          ]
        })
      })
    ])
    const warningIndex = logs.findIndex(({ level }) => level === "warn")
    expect(logCountAtSend).toBeGreaterThan(warningIndex)
  })
})
