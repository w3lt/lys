import {
  createLlmProviderLoadsModelsProblem,
  createLlmServiceBusyProblem,
  llmRuntimeUnavailableProblemSchema
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createLlmProviderLoadsModelsError } from "../../../../../src/modules/llm/llmProviderLoadsModelsError"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import handleLlmServiceRequestFailure from "../../../../../src/modules/llm/routes/handleLlmServiceRequestFailure"
import {
  createTestFastify,
  type CapturedLogDestination
} from "../../../support/fastifyTestApp"

/**
 * Registers routes whose handler rejects with the given failure and whose
 * error boundary is the handler under test: `GET /failing`, which names no
 * provider; `GET /llm/:provider/:modelId/failing`, whose path names a
 * provider beside another parameter, as the model-health route's does; and
 * `POST /chat/failing`, whose body may name a model, as a chat request's
 * does.
 *
 * @param failure - Rejection raised by every route's handler.
 * @returns The test application.
 */
function createFailingRouteApp(failure: unknown) {
  const testFastify = createTestFastify()
  const failingRoute = {
    errorHandler: handleLlmServiceRequestFailure,
    handler: async () => {
      throw failure
    }
  }
  testFastify.app.get("/failing", failingRoute)
  testFastify.app.get("/llm/:provider/:modelId/failing", failingRoute)
  testFastify.app.post("/chat/failing", failingRoute)
  return testFastify
}

/**
 * Lists the warnings an application logged.
 *
 * @param log - Destination of the application's log.
 * @returns The records at `warn`, in write order.
 */
function listWarnings(log: CapturedLogDestination) {
  return log.records.filter(({ level }) => level === "warn")
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

  it("answers a load or unload refused by a provider that loads its own models with the provider-loads-models problem", async () => {
    const { app } = createFailingRouteApp(createLlmProviderLoadsModelsError())

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(409)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(
      createLlmProviderLoadsModelsProblem(
        "The model provider decides which models are in memory, so Lys does not load or unload its models."
      )
    )
  })

  it("names the provider the path names in the provider-loads-models problem", async () => {
    const { app } = createFailingRouteApp(createLlmProviderLoadsModelsError())

    const response = await app.inject({
      method: "GET",
      url: "/llm/ollama/llama3.2/failing"
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual(
      createLlmProviderLoadsModelsProblem(
        "Ollama decides which models are in memory, so Lys does not load or unload its models."
      )
    )
  })

  it("names the provider of the model a chat request's body names in the runtime-unavailable problem", async () => {
    const { app } = createFailingRouteApp(createLlmRuntimeUnavailableError([]))

    const response = await app.inject({
      method: "POST",
      url: "/chat/failing",
      payload: { model: { provider: "groq", modelKey: "llama-3.3-70b" } }
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      detail:
        "Groq is not reachable. Check it in Settings → Providers, then refresh its status in Lys."
    })
  })

  it("speaks of the model provider in the runtime-unavailable problem when the request names none", async () => {
    const { app } = createFailingRouteApp(createLlmRuntimeUnavailableError([]))

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.json()).toMatchObject({
      detail:
        "The model provider is not reachable. Check it in Settings → Providers, then refresh its status in Lys."
    })
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
    const { app, log } = createFailingRouteApp(
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
    expect(log.records.filter((record) => "err" in record)).toEqual([])
  })

  it("logs retained runtime failures at warn, with the provider the path names, before answering with the runtime-unavailable problem", async () => {
    const runtimeFailure = new Error("connect ECONNREFUSED /private/lms.sock")
    const { app, log } = createFailingRouteApp(
      createLlmRuntimeUnavailableError([runtimeFailure])
    )
    let logCountAtSend: number | undefined = undefined
    app.addHook("onSend", async () => {
      logCountAtSend = log.records.length
    })

    const response = await app.inject({
      method: "GET",
      url: "/llm/groq/llama-3.3-70b-versatile/failing"
    })

    expect(response.statusCode).toBe(503)
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
    expect(response.body).not.toContain("ECONNREFUSED")
    expect(listWarnings(log)).toEqual([
      expect.objectContaining({
        provider: "groq",
        err: expect.objectContaining({
          aggregateErrors: [
            expect.objectContaining({ message: runtimeFailure.message })
          ]
        })
      })
    ])
    const warningIndex = log.records.findIndex(({ level }) => level === "warn")
    expect(logCountAtSend).toBeGreaterThan(warningIndex)
  })

  it("logs retained runtime failures with the provider of the model a chat request's body names", async () => {
    const { app, log } = createFailingRouteApp(
      createLlmRuntimeUnavailableError([new Error("socket closed")])
    )

    const response = await app.inject({
      method: "POST",
      url: "/chat/failing",
      payload: {
        message: "Hello",
        model: { provider: "ollamaCloud", modelKey: "gpt-oss:120b" }
      }
    })

    expect(response.statusCode).toBe(503)
    expect(listWarnings(log)).toEqual([
      expect.objectContaining({ provider: "ollamaCloud" })
    ])
  })

  it("logs retained runtime failures without a provider for a request that names none", async () => {
    const { app, log } = createFailingRouteApp(
      createLlmRuntimeUnavailableError([new Error("socket closed")])
    )

    const response = await app.inject({ method: "GET", url: "/failing" })

    expect(response.statusCode).toBe(503)
    const warnings = listWarnings(log)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toHaveProperty("provider")
  })
})
