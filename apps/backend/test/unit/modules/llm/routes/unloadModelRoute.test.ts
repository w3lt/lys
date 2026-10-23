import {
  createLlmServiceBusyProblem,
  llmModelNotFoundProblemSchema,
  llmRuntimeUnavailableProblemSchema,
  llmUnloadFailedProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
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
  it("responds 204 without a body when every instance Lys loaded stopped", async () => {
    const testApp = createLlmRouteTestApp()
    const stopLysLlmModelInstances = vi
      .spyOn(testApp.service, "stopLysLlmModelInstances")
      .mockResolvedValue({ status: "stopped", diagnostics: [] })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
    expect(stopLysLlmModelInstances).toHaveBeenCalledExactlyOnceWith(MODEL_KEY)
    expect(
      testApp.log.records.filter(
        ({ level }) => level === "warn" || level === "error"
      )
    ).toEqual([])
  })

  it("warns about stop failures that reconciliation resolved", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "stop-model-instance",
        modelIdentifier: MODEL_KEY,
        message: "unload timed out"
      }
    ] as const
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockResolvedValue({
      status: "stopped",
      diagnostics
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(204)
    expect(testApp.log.records.filter(({ level }) => level === "warn")).toEqual(
      [expect.objectContaining({ modelKey: MODEL_KEY, diagnostics })]
    )
  })

  it("responds with the model-not-found problem, without logging, when no instance Lys loaded is loaded", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockResolvedValue({
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
    expect(response.json()).toMatchObject({
      detail: `Model "${MODEL_KEY}" has no instance that Lys loaded.`
    })
    expect(
      testApp.log.records.filter(
        ({ level }) => level === "warn" || level === "error"
      )
    ).toEqual([])
  })

  it("warns about a record that could not be read before responding model-not-found", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "read-lys-instance-identifiers",
        message: "The loaded models file is not JSON."
      }
    ] as const
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockResolvedValue({
      status: "not-loaded",
      diagnostics
    })
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await sendUnloadRequest(testApp)

    expect(response.statusCode).toBe(404)
    expect(testApp.log.records.filter(({ level }) => level === "warn")).toEqual(
      [expect.objectContaining({ modelKey: MODEL_KEY, diagnostics })]
    )
  })

  it("responds with the runtime-unavailable problem and logs the diagnostics", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      { operation: "list-initial-model-instances", message: "socket closed" }
    ] as const
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockResolvedValue({
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
    expect(
      testApp.log.records.filter(({ level }) => level === "error")
    ).toEqual([expect.objectContaining({ modelKey: MODEL_KEY, diagnostics })])
  })

  it("responds with the unload-failed problem and logs the remaining instances", async () => {
    const testApp = createLlmRouteTestApp()
    const diagnostics = [
      {
        operation: "stop-model-instance",
        modelIdentifier: MODEL_KEY,
        message: "refused"
      }
    ] as const
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockResolvedValue({
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
    expect(
      testApp.log.records.filter(({ level }) => level === "error")
    ).toEqual([
      expect.objectContaining({
        modelKey: MODEL_KEY,
        remainingModelIdentifiers: [MODEL_KEY],
        diagnostics
      })
    ])
  })

  it.each([
    ["a missing model identifier", {}],
    ["an empty model identifier", { modelId: "" }],
    ["an additional property", { modelId: MODEL_KEY, force: true }]
  ])("rejects %s before stopping", async (_label, payload) => {
    const testApp = createLlmRouteTestApp()
    const stopLysLlmModelInstances = vi.spyOn(
      testApp.service,
      "stopLysLlmModelInstances"
    )
    await updateFastifyWithLlmModelUnloadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "PATCH",
      url: UNLOAD_MODEL_PATH,
      payload
    })

    expect(response.statusCode).toBe(400)
    expect(stopLysLlmModelInstances).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockRejectedValue(
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
    vi.spyOn(testApp.service, "stopLysLlmModelInstances").mockRejectedValue(
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
})
