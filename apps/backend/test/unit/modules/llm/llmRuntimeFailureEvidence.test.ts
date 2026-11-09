import { describe, expect, it, vi } from "vitest"
import { createLlmRuntimeFailureEvidence } from "../../../../src/modules/llm/llmRuntimeFailureEvidence"

describe("createLlmRuntimeFailureEvidence", () => {
  it("reports the original failure value to the reporter", () => {
    const failure = new Error("inventory query failed")
    const reporter = vi.fn()

    createLlmRuntimeFailureEvidence(failure).handleLlmRuntimeFailureReport(
      reporter
    )

    expect(reporter).toHaveBeenCalledOnce()
    expect(reporter.mock.calls[0]?.[0]).toBe(failure)
  })

  it("reports a non-error failure value unchanged", () => {
    const failure = { code: "ECONNREFUSED" }
    const reporter = vi.fn()

    createLlmRuntimeFailureEvidence(failure).handleLlmRuntimeFailureReport(
      reporter
    )

    expect(reporter.mock.calls[0]?.[0]).toBe(failure)
  })

  it("reports the same value on every request", () => {
    const failure = new Error("inventory query failed")
    const evidence = createLlmRuntimeFailureEvidence(failure)
    const reported: unknown[] = []

    evidence.handleLlmRuntimeFailureReport((value) => reported.push(value))
    evidence.handleLlmRuntimeFailureReport((value) => reported.push(value))

    expect(reported).toEqual([failure, failure])
    expect(reported[1]).toBe(failure)
  })

  it("rejects with both failures when the reporter throws", () => {
    const failure = new Error("inventory query failed")
    const reporterFailure = new Error("logger unavailable")
    const evidence = createLlmRuntimeFailureEvidence(failure)

    let caught: unknown
    try {
      evidence.handleLlmRuntimeFailureReport(() => {
        throw reporterFailure
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({ errors: [failure, reporterFailure] })
  })

  it("exposes no failure evidence as passive data", () => {
    const failure = new Error("secret path")
    const evidence = createLlmRuntimeFailureEvidence(failure)

    expect(Object.isFrozen(evidence)).toBe(true)
    expect(
      Reflect.ownKeys(evidence).map((key) => Reflect.get(evidence, key))
    ).not.toContain(failure)
    expect(JSON.stringify(evidence)).not.toContain("secret path")
  })
})
