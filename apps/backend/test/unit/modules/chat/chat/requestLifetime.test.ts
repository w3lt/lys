import { describe, expect, it, vi } from "vitest"
import { ChatRequestLifetime } from "../../../../../src/modules/chat/chat/requestLifetime"
import { flushMicrotasks } from "../../../support/microtasks"

/**
 * Observes whether a promise has settled after queued continuations run.
 *
 * @param promise - Promise under observation.
 * @returns A live flag that becomes true once the promise settles.
 */
function observeSettlement(promise: Promise<unknown>): { settled: boolean } {
  const observation = { settled: false }
  promise.then(
    () => (observation.settled = true),
    () => (observation.settled = true)
  )
  return observation
}

describe("ChatRequestLifetime", () => {
  it("runs an admitted operation and resolves with its completion", async () => {
    const lifetime = new ChatRequestLifetime()
    const operation = vi.fn(async () => undefined)

    await expect(lifetime.createRequestTask(operation)).resolves.toBeUndefined()

    expect(operation).toHaveBeenCalledOnce()
  })

  it("rejects the request task with the operation's original failure", async () => {
    const lifetime = new ChatRequestLifetime()
    const failure = new Error("stream failed")

    await expect(
      lifetime.createRequestTask(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
  })

  it("resolves disposal at once when no request is active", async () => {
    const lifetime = new ChatRequestLifetime()

    await expect(lifetime[Symbol.asyncDispose]()).resolves.toBeUndefined()
  })

  it("resolves disposal only after every admitted request settles", async () => {
    const lifetime = new ChatRequestLifetime()
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const firstTask = lifetime.createRequestTask(() => first.promise)
    const secondTask = lifetime.createRequestTask(() => second.promise)

    const disposal = lifetime[Symbol.asyncDispose]()
    const disposalObservation = observeSettlement(disposal)
    first.resolve()
    await firstTask
    await flushMicrotasks()
    expect(disposalObservation.settled).toBe(false)

    second.resolve()
    await secondTask
    await expect(disposal).resolves.toBeUndefined()
  })

  it("does not reject disposal when an admitted request fails", async () => {
    const lifetime = new ChatRequestLifetime()
    const request = Promise.withResolvers<void>()
    const task = lifetime.createRequestTask(() => request.promise)
    const taskOutcome = task.catch((error: unknown) => error)

    const disposal = lifetime[Symbol.asyncDispose]()
    request.reject(new Error("stream failed"))

    await expect(disposal).resolves.toBeUndefined()
    await expect(taskOutcome).resolves.toMatchObject({
      message: "stream failed"
    })
  })

  it("refuses new requests once disposal has begun", async () => {
    const lifetime = new ChatRequestLifetime()
    const operation = vi.fn(async () => undefined)

    const disposal = lifetime[Symbol.asyncDispose]()

    await expect(lifetime.createRequestTask(operation)).rejects.toThrow(
      "Chat request lifetime is closed"
    )
    expect(operation).not.toHaveBeenCalled()
    await disposal
  })

  it("shares one disposal completion across repeated and concurrent calls", async () => {
    const lifetime = new ChatRequestLifetime()
    const request = Promise.withResolvers<void>()
    const task = lifetime.createRequestTask(() => request.promise)

    const firstDisposal = lifetime[Symbol.asyncDispose]()
    const secondDisposal = lifetime[Symbol.asyncDispose]()
    request.resolve()
    await task

    expect(secondDisposal).toBe(firstDisposal)
    await firstDisposal
    expect(lifetime[Symbol.asyncDispose]()).toBe(firstDisposal)
  })
})
