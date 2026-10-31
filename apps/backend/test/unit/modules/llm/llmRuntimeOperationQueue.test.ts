import { describe, expect, it, vi } from "vitest"
import LlmRuntimeOperationQueue from "../../../../src/modules/llm/llmRuntimeOperationQueue"
import { isLlmServiceBusyError } from "../../../../src/modules/llm/llmServiceBusyError"
import { waitForMicrotasks } from "../../support/microtasks"

/** Operations the queue admits at once: one active and eight waiting. */
const QUEUE_CAPACITY = 9

/** Message of the failure raised for work requested after cleanup begins. */
const CLOSED_MESSAGE = "The LLM runtime is closed."

describe("LlmRuntimeOperationQueue", () => {
  it("runs accepted operations one at a time in admission order, past a failure", async () => {
    const queue = new LlmRuntimeOperationQueue()
    const first = Promise.withResolvers<string>()
    const second = vi.fn(async () => {
      throw new Error("operation failed")
    })
    const third = vi.fn(async () => "third")

    const firstResult = queue.handleLlmRuntimeOperationRequest(
      async () => await first.promise
    )
    const secondResult = queue.handleLlmRuntimeOperationRequest(second)
    const thirdResult = queue.handleLlmRuntimeOperationRequest(third)
    await waitForMicrotasks()
    expect(second).not.toHaveBeenCalled()

    first.resolve("first")
    await expect(firstResult).resolves.toBe("first")
    await expect(secondResult).rejects.toThrow("operation failed")
    await expect(thirdResult).resolves.toBe("third")
  })

  it("refuses an operation beyond one active and eight waiting without starting it, then admits again", async () => {
    const queue = new LlmRuntimeOperationQueue()
    const gate = Promise.withResolvers<void>()
    const accepted = Array.from({ length: QUEUE_CAPACITY }, () =>
      queue.handleLlmRuntimeOperationRequest(async () => await gate.promise)
    )
    const excess = vi.fn(async () => undefined)

    const refused = await queue.handleLlmRuntimeOperationRequest(excess).then(
      () => "accepted",
      (error: unknown) => error
    )
    gate.resolve()
    await Promise.all(accepted)

    expect(isLlmServiceBusyError(refused)).toBe(true)
    expect(excess).not.toHaveBeenCalled()
    await expect(
      queue.handleLlmRuntimeOperationRequest(async () => "admitted")
    ).resolves.toBe("admitted")
  })

  it("closes admission at once, releases after accepted work, and reports each status", async () => {
    const queue = new LlmRuntimeOperationQueue()
    const gate = Promise.withResolvers<void>()
    const releaseResources = vi.fn(async () => undefined)
    const late = vi.fn(async () => "late")
    const accepted = queue.handleLlmRuntimeOperationRequest(
      async () => await gate.promise
    )
    expect(queue.status).toBe("ready")

    const closing = queue.close(releaseResources)
    await waitForMicrotasks()
    expect(queue.status).toBe("closing")
    expect(releaseResources).not.toHaveBeenCalled()
    await expect(queue.handleLlmRuntimeOperationRequest(late)).rejects.toThrow(
      CLOSED_MESSAGE
    )

    gate.resolve()
    await accepted
    await closing
    expect(queue.status).toBe("closed")
    expect(releaseResources).toHaveBeenCalledOnce()
    await expect(queue.handleLlmRuntimeOperationRequest(late)).rejects.toThrow(
      CLOSED_MESSAGE
    )
    expect(late).not.toHaveBeenCalled()
  })

  it("refuses work after cleanup begins before checking capacity", async () => {
    const queue = new LlmRuntimeOperationQueue()
    const gate = Promise.withResolvers<void>()
    const accepted = Array.from({ length: QUEUE_CAPACITY }, () =>
      queue.handleLlmRuntimeOperationRequest(async () => await gate.promise)
    )

    const closing = queue.close(async () => undefined)
    const refused = queue.handleLlmRuntimeOperationRequest(async () => "late")

    await expect(refused).rejects.toThrow(CLOSED_MESSAGE)
    gate.resolve()
    await Promise.all(accepted)
    await closing
  })

  it("releases once for concurrent and repeated calls, which all observe a release failure", async () => {
    const queue = new LlmRuntimeOperationQueue()
    const releaseFailure = new Error("release failed")
    const firstRelease = vi.fn(async () => {
      throw releaseFailure
    })
    const laterRelease = vi.fn(async () => undefined)

    const outcomes = await Promise.allSettled([
      queue.close(firstRelease),
      queue.close(laterRelease)
    ])
    await expect(queue.close(laterRelease)).rejects.toBe(releaseFailure)

    expect(outcomes).toEqual([
      { status: "rejected", reason: releaseFailure },
      { status: "rejected", reason: releaseFailure }
    ])
    expect(firstRelease).toHaveBeenCalledOnce()
    expect(laterRelease).not.toHaveBeenCalled()
    expect(queue.status).toBe("closed")
  })
})
