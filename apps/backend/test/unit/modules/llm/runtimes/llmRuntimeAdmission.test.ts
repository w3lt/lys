import { describe, expect, it, vi } from "vitest"
import LlmRuntimeAdmission from "../../../../../src/modules/llm/runtimes/llmRuntimeAdmission"
import { waitForMicrotasks } from "../../../support/microtasks"

describe("LlmRuntimeAdmission", () => {
  it("runs one operation and admits the next once it settles", async () => {
    const admission = new LlmRuntimeAdmission()

    await expect(admission.runOperation(async () => "first")).resolves.toBe(
      "first"
    )
    await expect(
      admission.runOperation(async () => {
        throw new Error("operation failed")
      })
    ).rejects.toThrow("operation failed")
    await expect(admission.runOperation(async () => "third")).resolves.toBe(
      "third"
    )
  })

  it("refuses an overlapping operation without starting it", async () => {
    const admission = new LlmRuntimeAdmission()
    const active = Promise.withResolvers<void>()
    const overlapping = vi.fn(async () => undefined)

    const first = admission.runOperation(async () => await active.promise)
    await expect(admission.runOperation(overlapping)).rejects.toThrow(
      "The LLM runtime already has an active operation."
    )
    active.resolve()
    await first

    expect(overlapping).not.toHaveBeenCalled()
  })

  it("waits for the active operation before releasing, then refuses work", async () => {
    const admission = new LlmRuntimeAdmission()
    const active = Promise.withResolvers<void>()
    const releaseResources = vi.fn(async () => undefined)
    const operation = admission.runOperation(async () => await active.promise)

    const closing = admission.close(releaseResources)
    await waitForMicrotasks()
    expect(releaseResources).not.toHaveBeenCalled()
    await expect(admission.runOperation(async () => "late")).rejects.toThrow(
      "The LLM runtime is closed."
    )

    active.resolve()
    await operation
    await closing
    expect(releaseResources).toHaveBeenCalledOnce()
  })

  it("releases once and gives every caller the same failure", async () => {
    const admission = new LlmRuntimeAdmission()
    const releaseFailure = new Error("release failed")
    const firstRelease = vi.fn(async () => {
      throw releaseFailure
    })
    const secondRelease = vi.fn(async () => undefined)

    const first = admission.close(firstRelease)
    const second = admission.close(secondRelease)

    await expect(first).rejects.toBe(releaseFailure)
    await expect(second).rejects.toBe(releaseFailure)
    await expect(admission.close(secondRelease)).rejects.toBe(releaseFailure)
    expect(firstRelease).toHaveBeenCalledOnce()
    expect(secondRelease).not.toHaveBeenCalled()
  })
})
