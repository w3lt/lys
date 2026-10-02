import { describe, expect, it, vi } from "vitest"
import {
  createLlmRuntimeUnavailableError,
  isLlmRuntimeUnavailableError
} from "../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../src/modules/llm/llmServiceBusyError"

describe("createLlmRuntimeUnavailableError", () => {
  it("creates an aggregate without evidence when refused before runtime work", () => {
    const error = createLlmRuntimeUnavailableError([])

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([])
  })

  it("retains every original runtime failure in order", () => {
    const socketFailure = new Error("socket closed")
    const probeFailure = "probe refused"

    const error = createLlmRuntimeUnavailableError([
      socketFailure,
      probeFailure
    ])

    expect(error.errors).toHaveLength(2)
    expect(error.errors[0]).toBe(socketFailure)
    expect(error.errors[1]).toBe(probeFailure)
  })

  it("creates a new error for every failure", () => {
    expect(createLlmRuntimeUnavailableError([])).not.toBe(
      createLlmRuntimeUnavailableError([])
    )
  })
})

describe("isLlmRuntimeUnavailableError", () => {
  it.each([
    ["without runtime failures", []],
    ["with retained runtime failures", [new Error("socket closed")]]
  ])("recognizes a created error %s", (_label, runtimeFailures) => {
    expect(
      isLlmRuntimeUnavailableError(
        createLlmRuntimeUnavailableError(runtimeFailures)
      )
    ).toBe(true)
  })

  it("does not recognize an ordinary aggregate with the same failures", () => {
    const failure = new Error("socket closed")

    expect(
      isLlmRuntimeUnavailableError(
        new AggregateError([failure], "The LLM runtime is unavailable.")
      )
    ).toBe(false)
  })

  it("does not recognize an aggregate whose cause is another value", () => {
    const error = new AggregateError([], "runtime unavailable", {
      cause: Symbol("llm-runtime-unavailable")
    })

    expect(isLlmRuntimeUnavailableError(error)).toBe(false)
  })

  it("does not recognize a service-busy error", () => {
    expect(isLlmRuntimeUnavailableError(createLlmServiceBusyError())).toBe(
      false
    )
  })

  it.each([
    ["a string", "The LLM runtime is unavailable."],
    ["undefined", undefined],
    ["a plain error", new Error("The LLM runtime is unavailable.")],
    [
      "a plain object with aggregate fields",
      { errors: [], cause: Symbol("llm-runtime-unavailable") }
    ]
  ])("does not recognize %s", (_label, failure) => {
    expect(isLlmRuntimeUnavailableError(failure)).toBe(false)
  })

  it("does not invoke a cause accessor", () => {
    const readCause = vi.fn(() => "cause")
    const error = new AggregateError([], "accessor cause")
    Object.defineProperty(error, "cause", { get: readCause })

    expect(isLlmRuntimeUnavailableError(error)).toBe(false)
    expect(readCause).not.toHaveBeenCalled()
  })

  it("treats an uninspectable aggregate as unrecognized", () => {
    const uninspectable = new Proxy(
      createLlmRuntimeUnavailableError([new Error("socket closed")]),
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("inspection refused")
        }
      }
    )

    expect(isLlmRuntimeUnavailableError(uninspectable)).toBe(false)
  })
})
