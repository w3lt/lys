import {
  createLlmServiceBusyProblem,
  createLlmUnloadProblem
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import updateFastifyWithLlmModelUnloadRoute from "../../../../src/modules/llm/routes/unloadModelRoute"
import { findLogRecords } from "../../../support/fastifyTestApp"
import {
  createLlmRouteTestApp,
  occupyLlmServiceCapacity,
  type LlmRouteTestApp
} from "../../../support/llmRouteTestApp"

/** Published path of the unload route. */
const UNLOAD_MODEL_PATH = "/api/v1/llm/unload"

/** Model key requested by every case. */
const MODEL_KEY = "qwen/qwen3-8b"

/**
 * Requests an unload of {@link MODEL_KEY}.
 *
 * @param testApp - Application with the unload route registered.
 * @returns The completed response.
 */
async function requestUnload(testApp: LlmRouteTestApp) {
  return await testApp.app.inject({
    method: "PATCH",
    url: UNLOAD_MODEL_PATH,
    payload: { modelId: MODEL_KEY }
  })
}

describe("updateFastifyWithLlmModelUnloadRoute", () => {
  it("responds 204 without a body when every instance stopped", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances
      .mockResolvedValueOnce([
        { modelKey: MODEL_KEY, modelIdentifier: MODEL_KEY }
      ])
      .mockResolvedValueOnce([])
    testApp.runtime.stopLoadedLlmModelInstance.mockResolvedValue(undefined)
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await requestUnload(testApp)

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
    expect(
      findLogRecords(
        testApp.logs,
        "LLM model stop reconciled after runtime failures"
      )
    ).toEqual([])
  })

  it("warns about stop failures that reconciliation resolved", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances
      .mockResolvedValueOnce([
        { modelKey: MODEL_KEY, modelIdentifier: MODEL_KEY }
      ])
      .mockResolvedValueOnce([])
    testApp.runtime.stopLoadedLlmModelInstance.mockRejectedValue(
      new Error("unload timed out")
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await requestUnload(testApp)

    expect(response.statusCode).toBe(204)
    expect(
      findLogRecords(
        testApp.logs,
        "LLM model stop reconciled after runtime failures"
      )
    ).toEqual([
      expect.objectContaining({
        level: "warn",
        modelKey: MODEL_KEY,
        diagnostics: [
          {
            operation: "stop-model-instance",
            modelIdentifier: MODEL_KEY,
            message: "unload timed out"
          }
        ]
      })
    ])
  })

  it("responds with the model-not-found problem when the model is not loaded", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockResolvedValue([])
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await requestUnload(testApp)

    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(
      createLlmUnloadProblem({
        reason: "model-not-found",
        detail: `Model "${MODEL_KEY}" is not loaded.`
      })
    )
  })

  it("responds with the runtime-unavailable problem and logs the diagnostics", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockRejectedValue(
      new Error("socket closed")
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await requestUnload(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual(
      createLlmUnloadProblem({
        reason: "runtime-unavailable",
        detail: "The LLM runtime could not be queried."
      })
    )
    expect(response.body).not.toContain("socket closed")
    expect(
      findLogRecords(
        testApp.logs,
        "LLM runtime state could not be established during model stop"
      )
    ).toEqual([
      expect.objectContaining({
        level: "error",
        modelKey: MODEL_KEY,
        diagnostics: [
          {
            operation: "list-initial-model-instances",
            message: "socket closed"
          }
        ]
      })
    ])
  })

  it("responds with the unload-failed problem and logs the remaining instances", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockResolvedValue([
      { modelKey: MODEL_KEY, modelIdentifier: MODEL_KEY }
    ])
    testApp.runtime.stopLoadedLlmModelInstance.mockRejectedValue(
      new Error("refused")
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await requestUnload(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual(
      createLlmUnloadProblem({
        reason: "unload-failed",
        detail: `Model "${MODEL_KEY}" remains loaded.`
      })
    )
    expect(
      findLogRecords(
        testApp.logs,
        "LLM model instances remain loaded after stop reconciliation"
      )
    ).toEqual([
      expect.objectContaining({
        level: "error",
        modelKey: MODEL_KEY,
        remainingModelIdentifiers: [MODEL_KEY],
        diagnostics: [
          {
            operation: "stop-model-instance",
            modelIdentifier: MODEL_KEY,
            message: "refused"
          }
        ]
      })
    ])
  })

  it.each([
    ["a missing model identifier", {}],
    ["an empty model identifier", { modelId: "" }],
    ["an additional property", { modelId: MODEL_KEY, force: true }]
  ])("rejects %s before stopping", async (_label, payload) => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "PATCH",
      url: UNLOAD_MODEL_PATH,
      payload
    })

    expect(response.statusCode).toBe(400)
    expect(testApp.runtime.listLoadedLlmModelInstances).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)
    const releaseCapacity = occupyLlmServiceCapacity(testApp)

    const response = await requestUnload(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
    await releaseCapacity()
    expect(testApp.runtime.stopLoadedLlmModelInstance).not.toHaveBeenCalled()
  })
})
