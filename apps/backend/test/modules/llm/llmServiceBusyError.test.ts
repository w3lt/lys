import { describe, expect, it, vi } from "vitest"
import {
  createLlmServiceBusyError,
  isLlmServiceBusyError
} from "../../../src/modules/llm/llmServiceBusyError"

describe("createLlmServiceBusyError", () => {
  it("creates a native error with the queue-full message", () => {
    const error = createLlmServiceBusyError()

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("The LLM service queue is full.")
  })

  it("creates a new error for every refusal", () => {
    expect(createLlmServiceBusyError()).not.toBe(createLlmServiceBusyError())
  })
})

describe("isLlmServiceBusyError", () => {
  it("recognizes a created busy error", () => {
    expect(isLlmServiceBusyError(createLlmServiceBusyError())).toBe(true)
  })

  it("does not recognize an ordinary error with the same message", () => {
    expect(
      isLlmServiceBusyError(new Error("The LLM service queue is full."))
    ).toBe(false)
  })

  it("does not recognize an error whose cause is another value", () => {
    const error = new Error("The LLM service queue is full.", {
      cause: "llm-service-busy"
    })

    expect(isLlmServiceBusyError(error)).toBe(false)
  })

  it.each([
    ["a string", "The LLM service queue is full."],
    ["undefined", undefined],
    [
      "a plain object with a symbol cause",
      { cause: Symbol("llm-service-busy") }
    ]
  ])("does not recognize %s", (_label, failure) => {
    expect(isLlmServiceBusyError(failure)).toBe(false)
  })

  it("does not invoke a cause accessor", () => {
    const readCause = vi.fn(() => "cause")
    const error = new Error("accessor cause")
    Object.defineProperty(error, "cause", { get: readCause })

    expect(isLlmServiceBusyError(error)).toBe(false)
    expect(readCause).not.toHaveBeenCalled()
  })

  it("treats an uninspectable error as unrecognized", () => {
    const uninspectable = new Proxy(new Error("proxied"), {
      getOwnPropertyDescriptor: () => {
        throw new Error("inspection refused")
      }
    })

    expect(isLlmServiceBusyError(uninspectable)).toBe(false)
  })
})
