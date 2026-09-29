import { describe, expect, it, vi } from "vitest"
import LlmRuntimeService from "../../../../src/di/services/llmRuntimeService"
import type { LlmEngineOperation } from "../../../../src/di/services/llmService"
import { isLlmServiceBusyError } from "../../../../src/modules/llm/llmServiceBusyError"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import { flushMicrotasks } from "../../support/microtasks"

/** Accepted operations the service admits at once: one active and eight waiting. */
const SERVICE_CAPACITY = 9

/** Message of the failure raised for work requested after cleanup begins. */
const CLOSED_MESSAGE = "The LLM runtime is closed."

/**
 * Creates a service and connects it to a runtime double.
 *
 * @returns The connected service, its runtime, and the acquisition spy.
 * @remarks The first connection acquires the runtime without probing it, so
 * the double's unconfigured availability probe is never reached. Operations
 * in these cases never call the engine, so no availability probe follows them.
 */
async function createConnectedService() {
  const runtime = createFakeLlmRuntime()
  const acquireLlmRuntime = vi.fn(async () => runtime)
  const service = new LlmRuntimeService({
    acquireLlmRuntime,
    reportLlmRuntimeAcquisitionFailure: vi.fn(),
    reportLlmRuntimeAvailabilityCheckFailure: vi.fn()
  })
  expect(await service.connectLlmRuntime()).toBe("connected")
  return { service, runtime, acquireLlmRuntime }
}

/**
 * Creates an operation that settles only when its gate is released.
 *
 * @param gate - Barrier the operation waits for before resolving.
 * @returns An operation spy that resolves after the gate without engine work.
 */
function createGatedOperation(gate: Promise<void>) {
  return vi.fn<LlmEngineOperation<void>>(async () => {
    await gate
  })
}

describe("LlmRuntimeService", () => {
  describe("operation queue", () => {
    it("runs accepted operations one at a time in admission order", async () => {
      const { service } = await createConnectedService()
      const first = Promise.withResolvers<string>()
      const firstOperation = vi.fn<LlmEngineOperation<string>>(
        async () => await first.promise
      )
      const secondOperation = vi.fn<LlmEngineOperation<string>>(
        async () => "second"
      )

      const firstResult =
        service.handleLlmEngineOperationRequest(firstOperation)
      const secondResult =
        service.handleLlmEngineOperationRequest(secondOperation)
      await flushMicrotasks()
      expect(firstOperation).toHaveBeenCalledOnce()
      expect(secondOperation).not.toHaveBeenCalled()

      first.resolve("first")
      await expect(firstResult).resolves.toBe("first")
      await expect(secondResult).resolves.toBe("second")
    })

    it("continues with the next operation after an operation fails", async () => {
      const { service } = await createConnectedService()
      const failure = new Error("load failed")

      const failed = service.handleLlmEngineOperationRequest(async () => {
        throw failure
      })
      const next = service.handleLlmEngineOperationRequest(async () => "next")

      await expect(failed).rejects.toBe(failure)
      await expect(next).resolves.toBe("next")
    })

    it("refuses an operation beyond one active and eight waiting without running it", async () => {
      const { service } = await createConnectedService()
      const gate = Promise.withResolvers<void>()
      const acceptedOperation = createGatedOperation(gate.promise)
      const accepted = Array.from({ length: SERVICE_CAPACITY }, () =>
        service.handleLlmEngineOperationRequest(acceptedOperation)
      )
      const refusedOperation = vi.fn<LlmEngineOperation<void>>(
        async () => undefined
      )

      const refused = service
        .handleLlmEngineOperationRequest(refusedOperation)
        .then(
          () => "accepted",
          (error: unknown) => error
        )
      gate.resolve()
      await Promise.all(accepted)

      expect(isLlmServiceBusyError(await refused)).toBe(true)
      expect(acceptedOperation).toHaveBeenCalledTimes(SERVICE_CAPACITY)
      expect(refusedOperation).not.toHaveBeenCalled()
    })

    it("admits new work after accepted work settles", async () => {
      const { service } = await createConnectedService()
      const gate = Promise.withResolvers<void>()
      const accepted = Array.from({ length: SERVICE_CAPACITY }, () =>
        service.handleLlmEngineOperationRequest(
          createGatedOperation(gate.promise)
        )
      )
      gate.resolve()
      await Promise.all(accepted)

      await expect(
        service.handleLlmEngineOperationRequest(async () => "next")
      ).resolves.toBe("next")
    })

    it("releases capacity held by a failed operation", async () => {
      const { service } = await createConnectedService()
      const failed = Array.from({ length: SERVICE_CAPACITY }, () =>
        service
          .handleLlmEngineOperationRequest(async () => {
            throw new Error("offline")
          })
          .catch(() => undefined)
      )
      await Promise.all(failed)

      await expect(
        service.handleLlmEngineOperationRequest(async () => "next")
      ).resolves.toBe("next")
    })
  })

  describe("disposal", () => {
    it("releases the runtime only after accepted work settles", async () => {
      const { service, runtime } = await createConnectedService()
      const gate = Promise.withResolvers<void>()
      const accepted = service.handleLlmEngineOperationRequest(
        createGatedOperation(gate.promise)
      )

      const disposal = service[Symbol.asyncDispose]()
      await flushMicrotasks()
      expect(runtime[Symbol.asyncDispose]).not.toHaveBeenCalled()

      gate.resolve()
      await expect(accepted).resolves.toBeUndefined()
      await disposal
      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
    })

    it("refuses every connection attempt and operation once cleanup begins", async () => {
      const { service, acquireLlmRuntime } = await createConnectedService()
      const operation = vi.fn<LlmEngineOperation<void>>(async () => undefined)

      const disposal = service[Symbol.asyncDispose]()

      await expect(
        service.handleLlmEngineOperationRequest(operation)
      ).rejects.toThrow(CLOSED_MESSAGE)
      await expect(service.connectLlmRuntime()).rejects.toThrow(CLOSED_MESSAGE)
      await disposal
      await expect(
        service.handleLlmEngineOperationRequest(operation)
      ).rejects.toThrow(CLOSED_MESSAGE)
      await expect(service.connectLlmRuntime()).rejects.toThrow(CLOSED_MESSAGE)
      expect(operation).not.toHaveBeenCalled()
      expect(acquireLlmRuntime).toHaveBeenCalledOnce()
    })

    it("shares one runtime release across concurrent and repeated calls", async () => {
      const { service, runtime } = await createConnectedService()

      await Promise.all([
        service[Symbol.asyncDispose](),
        service[Symbol.asyncDispose]()
      ])
      await service[Symbol.asyncDispose]()

      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
    })

    it("stays closed and repeats the release failure without retrying release", async () => {
      const { service, runtime } = await createConnectedService()
      runtime[Symbol.asyncDispose].mockRejectedValue(
        new Error("The LLM runtime could not release its resources.")
      )

      const releaseFailure = await service[Symbol.asyncDispose]().then(
        () => "released",
        (error: unknown) => error
      )

      expect(releaseFailure).toBeInstanceOf(Error)
      expect(releaseFailure).toHaveProperty(
        "message",
        "The LLM runtime could not release its resources."
      )
      await expect(service[Symbol.asyncDispose]()).rejects.toBe(releaseFailure)
      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
      expect(service.llmRuntimeConnectionStatus).toBe("unreachable")
      await expect(
        service.handleLlmEngineOperationRequest(async () => undefined)
      ).rejects.toThrow(CLOSED_MESSAGE)
    })
  })
})
