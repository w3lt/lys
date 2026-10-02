import type { LlmRuntimeConnectionStatus } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import LlmRuntimeService from "../../../../src/di/services/llmRuntimeService"
import type { LlmEngineOperation } from "../../../../src/di/services/llmService"
import type { LlmRuntime } from "../../../../src/modules/llm/llmRuntime"
import { isLlmRuntimeUnavailableError } from "../../../../src/modules/llm/llmRuntimeUnavailableError"
import type { LlmRuntimeAvailability } from "../../../../src/modules/llm/llmRuntimeTypes"
import { isLlmServiceBusyError } from "../../../../src/modules/llm/llmServiceBusyError"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import { waitForMicrotasks } from "../../support/microtasks"

/** Accepted operations the service admits at once: one active and eight waiting. */
const SERVICE_CAPACITY = 9

/** Message of the failure raised for work requested after cleanup begins. */
const CLOSED_MESSAGE = "The LLM runtime is closed."

/**
 * Creates a service over one acquisition capability with recording reporters.
 *
 * @param acquireLlmRuntime - Acquisition capability the service borrows.
 * @returns The ready service, which holds no runtime until it connects, and
 * both failure reporters.
 */
function createService(acquireLlmRuntime: () => Promise<LlmRuntime>) {
  const reportLlmRuntimeAcquisitionFailure = vi.fn<(failure: unknown) => void>()
  const reportLlmRuntimeAvailabilityCheckFailure =
    vi.fn<(failure: unknown) => void>()
  const service = new LlmRuntimeService({
    acquireLlmRuntime,
    reportLlmRuntimeAcquisitionFailure,
    reportLlmRuntimeAvailabilityCheckFailure
  })
  return {
    service,
    reportLlmRuntimeAcquisitionFailure,
    reportLlmRuntimeAvailabilityCheckFailure
  }
}

/**
 * Creates a service and connects it to a runtime double.
 *
 * @returns The connected service, its runtime, the acquisition spy, and both
 * failure reporters.
 * @remarks The first connection acquires the runtime without probing it, so
 * the double's unconfigured availability probe is never reached. Operations
 * in the queue and disposal cases never call the engine, so no availability
 * probe follows them.
 */
async function createConnectedService() {
  const runtime = createFakeLlmRuntime()
  const acquireLlmRuntime = vi.fn(async () => runtime)
  const created = createService(acquireLlmRuntime)
  expect(await created.service.connectLlmRuntime()).toBe("connected")
  return { ...created, runtime, acquireLlmRuntime }
}

/**
 * Creates an operation whose one runtime call rejects and whose own result
 * depends on whether it absorbs that rejection.
 *
 * @param runtime - Runtime double whose loaded-inventory query rejects.
 * @param failure - Rejection returned by that query.
 * @returns An operation that queries loaded inventory through the engine it
 * receives and propagates the rejection, and one that absorbs it and resolves
 * to `"kept result"`.
 * @remarks Both call the engine, so the service observes a failed runtime call
 * whichever outcome the operation itself produces.
 */
function createFailingRuntimeCallOperations(
  runtime: ReturnType<typeof createFakeLlmRuntime>,
  failure: Error
) {
  runtime.listLoadedLlmModelInstances.mockRejectedValue(failure)
  return {
    propagating: vi.fn<LlmEngineOperation<unknown>>(
      async (llmEngine) => await llmEngine.listLoadedLlmModelInstances()
    ),
    absorbing: vi.fn<LlmEngineOperation<string>>(async (llmEngine) => {
      await llmEngine.listLoadedLlmModelInstances().catch(() => undefined)
      return "kept result"
    })
  }
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
      await waitForMicrotasks()
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
      await waitForMicrotasks()
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

  describe("connection status", () => {
    it("starts connecting before any attempt settles", () => {
      const acquireLlmRuntime = vi.fn<() => Promise<LlmRuntime>>()
      const { service } = createService(acquireLlmRuntime)

      expect(service.llmRuntimeConnectionStatus).toBe("connecting")
      expect(acquireLlmRuntime).not.toHaveBeenCalled()
    })

    it("stays readable and unchanged after cleanup of an unreachable service", async () => {
      const { service } = createService(async () => {
        throw new Error("connect ECONNREFUSED")
      })
      expect(await service.connectLlmRuntime()).toBe("unreachable")

      await service[Symbol.asyncDispose]()

      expect(service.llmRuntimeConnectionStatus).toBe("unreachable")
    })

    it("stays readable after cleanup releases the held runtime", async () => {
      const { service, runtime } = await createConnectedService()

      await service[Symbol.asyncDispose]()

      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
      expect(service.llmRuntimeConnectionStatus).not.toBe("connected")
    })
  })

  describe("connectLlmRuntime", () => {
    it("resolves unreachable and reports an acquisition failure after the status changes", async () => {
      const failure = new Error("connect ECONNREFUSED")
      const created = createService(async () => {
        throw failure
      })
      const statusesSeenByReporter: LlmRuntimeConnectionStatus[] = []
      created.reportLlmRuntimeAcquisitionFailure.mockImplementation(() => {
        statusesSeenByReporter.push(created.service.llmRuntimeConnectionStatus)
      })

      const status = await created.service.connectLlmRuntime()

      expect(status).toBe("unreachable")
      expect(created.service.llmRuntimeConnectionStatus).toBe("unreachable")
      expect(
        created.reportLlmRuntimeAcquisitionFailure
      ).toHaveBeenCalledExactlyOnceWith(failure)
      expect(statusesSeenByReporter).toEqual(["unreachable"])
    })

    it("keeps a held runtime that still answers", async () => {
      const { service, runtime, acquireLlmRuntime } =
        await createConnectedService()
      runtime.getRuntimeAvailability.mockResolvedValue("available")

      const status = await service.connectLlmRuntime()

      expect(status).toBe("connected")
      expect(service.llmRuntimeConnectionStatus).toBe("connected")
      expect(runtime.getRuntimeAvailability).toHaveBeenCalledOnce()
      expect(acquireLlmRuntime).toHaveBeenCalledOnce()
      expect(runtime[Symbol.asyncDispose]).not.toHaveBeenCalled()
    })

    it("releases a held runtime that no longer answers and acquires a new one", async () => {
      const heldRuntime = createFakeLlmRuntime()
      heldRuntime.getRuntimeAvailability.mockResolvedValue("unavailable")
      const newRuntime = createFakeLlmRuntime()
      newRuntime.listLoadedLlmModelInstances.mockResolvedValue([])
      const acquireLlmRuntime = vi
        .fn<() => Promise<LlmRuntime>>()
        .mockResolvedValueOnce(heldRuntime)
        .mockResolvedValueOnce(newRuntime)
      const { service } = createService(acquireLlmRuntime)
      await service.connectLlmRuntime()

      const status = await service.connectLlmRuntime()

      expect(status).toBe("connected")
      expect(heldRuntime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
      expect(acquireLlmRuntime).toHaveBeenCalledTimes(2)
      await expect(
        service.handleLlmEngineOperationRequest(
          async (llmEngine) => await llmEngine.listLoadedLlmModelInstances()
        )
      ).resolves.toEqual([])
      expect(newRuntime.listLoadedLlmModelInstances).toHaveBeenCalledOnce()
      expect(heldRuntime.listLoadedLlmModelInstances).not.toHaveBeenCalled()
    })

    it("rejects with a probe failure of the held runtime and leaves the status unchanged", async () => {
      const { service, runtime } = await createConnectedService()
      const probeFailure = new Error(
        "The LLM runtime already has an active operation."
      )
      runtime.getRuntimeAvailability.mockRejectedValue(probeFailure)

      await expect(service.connectLlmRuntime()).rejects.toBe(probeFailure)

      expect(service.llmRuntimeConnectionStatus).toBe("connected")
      expect(runtime[Symbol.asyncDispose]).not.toHaveBeenCalled()
    })

    it("rejects with a release failure of the held runtime and leaves the status unreachable", async () => {
      const { service, runtime } = await createConnectedService()
      const releaseFailure = new Error(
        "The LLM runtime could not release its resources."
      )
      runtime.getRuntimeAvailability.mockResolvedValue("unavailable")
      runtime[Symbol.asyncDispose].mockRejectedValue(releaseFailure)

      await expect(service.connectLlmRuntime()).rejects.toBe(releaseFailure)

      expect(service.llmRuntimeConnectionStatus).toBe("unreachable")
    })

    it("shares one pending attempt between concurrent calls", async () => {
      const runtime = createFakeLlmRuntime()
      const acquisition = Promise.withResolvers<LlmRuntime>()
      const acquireLlmRuntime = vi
        .fn<() => Promise<LlmRuntime>>()
        .mockReturnValue(acquisition.promise)
      const { service } = createService(acquireLlmRuntime)

      const first = service.connectLlmRuntime()
      const second = service.connectLlmRuntime()
      await waitForMicrotasks()
      expect(acquireLlmRuntime).toHaveBeenCalledOnce()
      expect(service.llmRuntimeConnectionStatus).toBe("connecting")

      acquisition.resolve(runtime)
      await expect(first).resolves.toBe("connected")
      await expect(second).resolves.toBe("connected")
      expect(acquireLlmRuntime).toHaveBeenCalledOnce()
    })

    it("is refused with the service-busy error without starting an attempt when the queue is full", async () => {
      const { service, runtime, acquireLlmRuntime } =
        await createConnectedService()
      const gate = Promise.withResolvers<void>()
      const accepted = Array.from({ length: SERVICE_CAPACITY }, () =>
        service.handleLlmEngineOperationRequest(
          createGatedOperation(gate.promise)
        )
      )

      const refused = await service.connectLlmRuntime().then(
        () => "accepted",
        (error: unknown) => error
      )
      gate.resolve()
      await Promise.all(accepted)

      expect(isLlmServiceBusyError(refused)).toBe(true)
      expect(runtime.getRuntimeAvailability).not.toHaveBeenCalled()
      expect(acquireLlmRuntime).toHaveBeenCalledOnce()
      expect(service.llmRuntimeConnectionStatus).toBe("connected")
    })
  })

  describe("model operations", () => {
    it.each([
      ["before any attempt settles", false],
      ["after a failed acquisition", true]
    ])(
      "rejects with the runtime-unavailable error without running the operation %s",
      async (_label, attemptFirst) => {
        const { service } = createService(async () => {
          throw new Error("connect ECONNREFUSED")
        })
        if (attemptFirst) {
          await service.connectLlmRuntime()
        }
        const operation = vi.fn<LlmEngineOperation<void>>(async () => undefined)

        const failure = await service
          .handleLlmEngineOperationRequest(operation)
          .then(
            () => "resolved",
            (error: unknown) => error
          )

        expect(isLlmRuntimeUnavailableError(failure)).toBe(true)
        expect(failure).toHaveProperty("errors", [])
        expect(operation).not.toHaveBeenCalled()
      }
    )

    it("probes availability after a failed runtime call before the next queued work", async () => {
      const { service, runtime } = await createConnectedService()
      const failure = new Error("socket closed")
      const { propagating } = createFailingRuntimeCallOperations(
        runtime,
        failure
      )
      const probe = Promise.withResolvers<LlmRuntimeAvailability>()
      runtime.getRuntimeAvailability.mockReturnValueOnce(probe.promise)
      const nextOperation = vi.fn<LlmEngineOperation<string>>(
        async () => "next"
      )

      const failed = service.handleLlmEngineOperationRequest(propagating)
      const next = service.handleLlmEngineOperationRequest(nextOperation)
      await waitForMicrotasks()
      expect(runtime.getRuntimeAvailability).toHaveBeenCalledOnce()
      expect(nextOperation).not.toHaveBeenCalled()

      probe.resolve("available")
      await expect(failed).rejects.toBe(failure)
      await expect(next).resolves.toBe("next")
    })

    it("keeps the original failure and the runtime when the runtime still answers", async () => {
      const { service, runtime } = await createConnectedService()
      const failure = new Error("The LLM runtime could not load the model.")
      const { propagating } = createFailingRuntimeCallOperations(
        runtime,
        failure
      )
      runtime.getRuntimeAvailability.mockResolvedValue("available")

      await expect(
        service.handleLlmEngineOperationRequest(propagating)
      ).rejects.toBe(failure)

      expect(service.llmRuntimeConnectionStatus).toBe("connected")
      expect(runtime[Symbol.asyncDispose]).not.toHaveBeenCalled()
    })

    it("releases a runtime that stopped answering and rejects with the runtime-unavailable error retaining the failure", async () => {
      const { service, runtime } = await createConnectedService()
      const failure = new Error("socket closed")
      const { propagating } = createFailingRuntimeCallOperations(
        runtime,
        failure
      )
      runtime.getRuntimeAvailability.mockResolvedValue("unavailable")

      const rejection = await service
        .handleLlmEngineOperationRequest(propagating)
        .then(
          () => "resolved",
          (error: unknown) => error
        )

      expect(isLlmRuntimeUnavailableError(rejection)).toBe(true)
      expect(rejection).toHaveProperty(
        "errors",
        expect.arrayContaining([failure])
      )
      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
      expect(service.llmRuntimeConnectionStatus).toBe("unreachable")
    })

    it.each([
      ["the availability probe", "probe"],
      ["the release", "release"]
    ] as const)(
      "retains both failures when %s also fails",
      async (_label, failingStep) => {
        const { service, runtime } = await createConnectedService()
        const failure = new Error("socket closed")
        const { propagating } = createFailingRuntimeCallOperations(
          runtime,
          failure
        )
        const checkFailure = new Error(`${failingStep} failed`)
        if (failingStep === "probe") {
          runtime.getRuntimeAvailability.mockRejectedValue(checkFailure)
        } else {
          runtime.getRuntimeAvailability.mockResolvedValue("unavailable")
          runtime[Symbol.asyncDispose].mockRejectedValue(checkFailure)
        }

        const rejection = await service
          .handleLlmEngineOperationRequest(propagating)
          .then(
            () => "resolved",
            (error: unknown) => error
          )

        expect(rejection).toBeInstanceOf(AggregateError)
        expect(rejection).toHaveProperty(
          "errors",
          expect.arrayContaining([failure, checkFailure])
        )
      }
    )

    it("returns a resolved result when the follow-up probe releases the runtime", async () => {
      const { service, runtime, reportLlmRuntimeAvailabilityCheckFailure } =
        await createConnectedService()
      const { absorbing } = createFailingRuntimeCallOperations(
        runtime,
        new Error("socket closed")
      )
      runtime.getRuntimeAvailability.mockResolvedValue("unavailable")

      await expect(
        service.handleLlmEngineOperationRequest(absorbing)
      ).resolves.toBe("kept result")

      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
      expect(service.llmRuntimeConnectionStatus).toBe("unreachable")
      expect(reportLlmRuntimeAvailabilityCheckFailure).not.toHaveBeenCalled()
    })

    it.each([
      ["probe", "connected"],
      ["release", "unreachable"]
    ] as const)(
      "returns a resolved result and reports a failed %s, leaving the status %s",
      async (failingStep, expectedStatus) => {
        const { service, runtime, reportLlmRuntimeAvailabilityCheckFailure } =
          await createConnectedService()
        const { absorbing } = createFailingRuntimeCallOperations(
          runtime,
          new Error("socket closed")
        )
        const checkFailure = new Error(`${failingStep} failed`)
        if (failingStep === "probe") {
          runtime.getRuntimeAvailability.mockRejectedValue(checkFailure)
        } else {
          runtime.getRuntimeAvailability.mockResolvedValue("unavailable")
          runtime[Symbol.asyncDispose].mockRejectedValue(checkFailure)
        }

        await expect(
          service.handleLlmEngineOperationRequest(absorbing)
        ).resolves.toBe("kept result")

        expect(
          reportLlmRuntimeAvailabilityCheckFailure
        ).toHaveBeenCalledExactlyOnceWith(checkFailure)
        expect(service.llmRuntimeConnectionStatus).toBe(expectedStatus)
      }
    )
  })
})
