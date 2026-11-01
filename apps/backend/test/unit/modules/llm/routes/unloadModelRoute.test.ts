import {
  createLlmServiceBusyProblem,
  llmModelNotFoundProblemSchema,
  llmProviderLoadsModelsProblemSchema,
  llmRuntimeUnavailableProblemSchema,
  llmUnloadFailedProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import { createLlmProviderLoadsModelsError } from "../../../../../src/modules/llm/llmProviderLoadsModelsError"
import { createLlmRuntimeFailureEvidence } from "../../../../../src/modules/llm/llmRuntimeFailureEvidence"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmModelUnloadRoute from "../../../../../src/modules/llm/routes/unloadModelRoute"
import {
  createLlmRouteTestApp,
  type LlmRouteTestApp
} from "../../../support/llmRouteTestApp"

/** Published path of the unload route. */
const UNLOAD_MODEL_PATH = "/api/v1/llm/unload"

/** Model key requested by every case. */
const MODEL_KEY = "qwen/qwen3-8b"

/** Lists the records of one level, in write order. */
function listRecordsAtLevel(testApp: LlmRouteTestApp, level: string) {
  return testApp.log.records.filter((record) => record.level === level)
}

/**
 * Sends an unload request for {@link MODEL_KEY}.
 *
 * @param testApp - Application with the unload route registered.
 * @returns The completed response.
 */
async function sendUnloadRequest(testApp: LlmRouteTestApp) {
  return await testApp.app.inject({
    method: "PATCH",
    url: UNLOAD_MODEL_PATH,
    payload: { modelId: MODEL_KEY }
  })
}

describe("updateFastifyWithLlmModelUnloadRoute", () => {
  it("responds 204 without a body when every instance stopped", async () => {
    const testApp = createLlmRouteTestApp()
    const stopLlmModelsByKey = vi
      .spyOn(testApp.service, "stopLlmModelsByKey")
      .mockResolvedValue({ status: "stopped", diagnostics: [] })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
    expect(stopLlmModelsByKey).toHaveBeenCalledExactlyOnceWith(MODEL_KEY)
    expect(
      testApp.log.records.filter(
        ({ level }) => level === "warn" || level === "error"
      )
    ).toEqual([])
  })

  it("warns about each stop failure that reconciliation resolved, with the failure itself", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "stop-model-instance",
        modelIdentifier: `${MODEL_KEY}:2`,
        evidence: createLlmRuntimeFailureEvidence(new Error("unload timed out"))
      }
    ] as const
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockResolvedValue({
      status: "stopped",
      diagnostics
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(204)
    expect(listRecordsAtLevel(testApp, "warn")).toEqual([
      expect.objectContaining({
        msg: "LLM model instance could not be stopped",
        modelKey: MODEL_KEY,
        operation: "stop-model-instance",
        modelIdentifier: `${MODEL_KEY}:2`,
        err: expect.objectContaining({ message: "unload timed out" })
      })
    ])
    expect(listRecordsAtLevel(testApp, "error")).toEqual([])
  })

  it("responds with the model-not-found problem when the model is not loaded", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockResolvedValue({
      status: "not-loaded",
      diagnostics: []
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmModelNotFoundProblemSchema.safeParse(response.json()).success
    ).toBe(true)
  })

  it("responds with the runtime-unavailable problem and logs the inventory failure with its cause, out of the body", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "list-initial-model-instances",
        evidence: createLlmRuntimeFailureEvidence(
          new Error("socket closed", { cause: new Error("read ECONNRESET") })
        )
      }
    ] as const
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockResolvedValue({
      status: "runtime-unavailable",
      diagnostics
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
    expect(response.body).not.toContain("socket closed")
    expect(response.body).not.toContain("ECONNRESET")
    expect(listRecordsAtLevel(testApp, "error")).toEqual([
      expect.objectContaining({
        msg: "LLM runtime inventory could not be read before the model stop",
        modelKey: MODEL_KEY,
        operation: "list-initial-model-instances",
        err: expect.objectContaining({
          message: "socket closed: read ECONNRESET",
          stack: expect.stringContaining("read ECONNRESET")
        })
      })
    ])
    expect(listRecordsAtLevel(testApp, "warn")).toEqual([])
  })

  it("logs each diagnostic of a runtime-unavailable outcome after stop failures, in order", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "stop-model-instance",
        modelIdentifier: MODEL_KEY,
        evidence: createLlmRuntimeFailureEvidence(new Error("refused"))
      },
      {
        operation: "list-reconciled-model-instances",
        evidence: createLlmRuntimeFailureEvidence(new Error("socket closed"))
      }
    ] as const
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockResolvedValue({
      status: "runtime-unavailable",
      diagnostics
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(503)
    expect(listRecordsAtLevel(testApp, "error")).toEqual([
      expect.objectContaining({
        msg: "LLM model instance could not be stopped",
        modelKey: MODEL_KEY,
        operation: "stop-model-instance",
        modelIdentifier: MODEL_KEY,
        err: expect.objectContaining({ message: "refused" })
      }),
      expect.objectContaining({
        msg: "LLM runtime inventory could not be read after the model stop",
        modelKey: MODEL_KEY,
        operation: "list-reconciled-model-instances",
        err: expect.objectContaining({ message: "socket closed" })
      })
    ])
  })

  it("responds with the unload-failed problem and logs each stop failure, then the remaining instances", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "stop-model-instance",
        modelIdentifier: MODEL_KEY,
        evidence: createLlmRuntimeFailureEvidence(new Error("refused"))
      }
    ] as const
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockResolvedValue({
      status: "stop-failed",
      remainingModelIdentifiers: [MODEL_KEY],
      diagnostics
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmUnloadFailedProblemSchema.safeParse(response.json()).success
    ).toBe(true)
    expect(response.body).not.toContain("refused")
    expect(listRecordsAtLevel(testApp, "error")).toEqual([
      expect.objectContaining({
        msg: "LLM model instance could not be stopped",
        modelKey: MODEL_KEY,
        operation: "stop-model-instance",
        modelIdentifier: MODEL_KEY,
        err: expect.objectContaining({ message: "refused" })
      }),
      expect.objectContaining({
        msg: "LLM model instances remain loaded after stop reconciliation",
        modelKey: MODEL_KEY,
        remainingModelIdentifiers: [MODEL_KEY]
      })
    ])
  })

  it.each([
    ["a missing model identifier", {}],
    ["an empty model identifier", { modelId: "" }],
    ["an additional property", { modelId: MODEL_KEY, force: true }]
  ])("rejects %s before stopping", async (_label, payload) => {
    const testApp = createLlmRouteTestApp()
    const stopLlmModelsByKey = vi.spyOn(testApp.service, "stopLlmModelsByKey")
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "PATCH",
      url: UNLOAD_MODEL_PATH,
      payload
    })

    expect(response.statusCode).toBe(400)
    expect(stopLlmModelsByKey).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockRejectedValue(
      createLlmServiceBusyError()
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
  })

  it("responds with the runtime-unavailable problem when no runtime is connected", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockRejectedValue(
      createLlmRuntimeUnavailableError([])
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
  })

  it("responds 409 with the provider-loads-models problem when the provider loads its own models", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "stopLlmModelsByKey").mockRejectedValue(
      createLlmProviderLoadsModelsError()
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(409)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmProviderLoadsModelsProblemSchema.safeParse(response.json()).success
    ).toBe(true)
  })
})
