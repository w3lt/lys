import { describe, expect, it, vi } from "vitest"
import { createLlmModelHealthDiagnostic } from "../../../../src/modules/llm/llmModelHealthDiagnostic"

describe("createLlmModelHealthDiagnostic", () => {
  it("reports the original failure value to the reporter", () => {
    const failure = new Error("inventory query failed")
    const reporter = vi.fn()

    createLlmModelHealthDiagnostic(failure).handleLlmModelHealthFailureReport(
      reporter
    )

    expect(reporter).toHaveBeenCalledOnce()
    expect(reporter.mock.calls[0]?.[0]).toBe(failure)
  })

  it("reports a non-error failure value unchanged", () => {
    const failure = { code: "ECONNREFUSED" }
    const reporter = vi.fn()

    createLlmModelHealthDiagnostic(failure).handleLlmModelHealthFailureReport(
      reporter
    )

    expect(reporter.mock.calls[0]?.[0]).toBe(failure)
  })

  it("reports the same value on every request", () => {
    const failure = new Error("inventory query failed")
    const diagnostic = createLlmModelHealthDiagnostic(failure)
    const reported: unknown[] = []

    diagnostic.handleLlmModelHealthFailureReport((value) =>
      reported.push(value)
    )
    diagnostic.handleLlmModelHealthFailureReport((value) =>
      reported.push(value)
    )

    expect(reported).toEqual([failure, failure])
    expect(reported[1]).toBe(failure)
  })

  it("rejects with both failures when the reporter throws", () => {
    const failure = new Error("inventory query failed")
    const reporterFailure = new Error("logger unavailable")
    const diagnostic = createLlmModelHealthDiagnostic(failure)

    let caught: unknown
    try {
      diagnostic.handleLlmModelHealthFailureReport(() => {
        throw reporterFailure
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({
      message: "Reporting the LLM model health failure did not complete.",
      errors: [failure, reporterFailure],
      cause: reporterFailure
    })
  })

  it("exposes no failure evidence as passive data", () => {
    const diagnostic = createLlmModelHealthDiagnostic(new Error("secret path"))

    expect(Object.isFrozen(diagnostic)).toBe(true)
    expect(Reflect.ownKeys(diagnostic)).toEqual([])
    expect(JSON.stringify(diagnostic)).toBe("{}")
  })
})
