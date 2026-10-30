import { describe, expect, it } from "vitest"
import LlmRuntimeCallRecord from "../../../../src/modules/llm/llmRuntimeCallRecord"

describe("LlmRuntimeCallRecord", () => {
  it("starts with no recorded failure", () => {
    expect(new LlmRuntimeCallRecord().hasRecordedFailure).toBe(false)
  })

  it("returns a call's result unchanged without recording a failure", async () => {
    const record = new LlmRuntimeCallRecord()
    const result = Object.freeze({ answered: true })

    await expect(
      record.handleLlmRuntimeCall(() => Promise.resolve(result))
    ).resolves.toBe(result)
    expect(record.hasRecordedFailure).toBe(false)
  })

  it("forwards the original rejection and records it", async () => {
    const record = new LlmRuntimeCallRecord()
    const failure = new Error("runtime call failed")

    await expect(
      record.handleLlmRuntimeCall(() => Promise.reject(failure))
    ).rejects.toBe(failure)
    expect(record.hasRecordedFailure).toBe(true)
  })

  it("forwards a synchronous throw as a rejection and records it", async () => {
    const record = new LlmRuntimeCallRecord()
    const failure = new Error("runtime threw synchronously")

    const call = record.handleLlmRuntimeCall(() => {
      throw failure
    })

    expect(call).toBeInstanceOf(Promise)
    await expect(call).rejects.toBe(failure)
    expect(record.hasRecordedFailure).toBe(true)
  })

  it("keeps the failure recorded after later calls succeed", async () => {
    const record = new LlmRuntimeCallRecord()

    await expect(
      record.handleLlmRuntimeCall(() => Promise.reject(new Error("failed")))
    ).rejects.toThrow("failed")
    await record.handleLlmRuntimeCall(() => Promise.resolve("answered"))

    expect(record.hasRecordedFailure).toBe(true)
  })

  it("records failures only in the record whose call rejected", async () => {
    const failedOperation = new LlmRuntimeCallRecord()
    const laterOperation = new LlmRuntimeCallRecord()

    await expect(
      failedOperation.handleLlmRuntimeCall(() =>
        Promise.reject(new Error("inventory failed"))
      )
    ).rejects.toThrow("inventory failed")

    expect(failedOperation.hasRecordedFailure).toBe(true)
    expect(laterOperation.hasRecordedFailure).toBe(false)
  })
})
