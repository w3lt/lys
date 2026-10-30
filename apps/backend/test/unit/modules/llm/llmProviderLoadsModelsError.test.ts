import { describe, expect, it, vi } from "vitest"
import {
  createLlmProviderLoadsModelsError,
  isLlmProviderLoadsModelsError
} from "../../../../src/modules/llm/llmProviderLoadsModelsError"

describe("createLlmProviderLoadsModelsError", () => {
  it("creates a native error recognized as the refusal", () => {
    const error = createLlmProviderLoadsModelsError()

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(
      "The connected model provider loads its own models."
    )
    expect(isLlmProviderLoadsModelsError(error)).toBe(true)
  })

  it("creates a new error for every refusal", () => {
    expect(createLlmProviderLoadsModelsError()).not.toBe(
      createLlmProviderLoadsModelsError()
    )
  })
})

describe("isLlmProviderLoadsModelsError", () => {
  it("does not recognize an ordinary error with the same message", () => {
    expect(
      isLlmProviderLoadsModelsError(
        new Error("The connected model provider loads its own models.")
      )
    ).toBe(false)
  })

  it.each([
    ["a string", "The connected model provider loads its own models."],
    ["undefined", undefined],
    [
      "a plain object with a symbol cause",
      { cause: Symbol("llm-provider-loads-models") }
    ]
  ])("does not recognize %s", (_label, failure) => {
    expect(isLlmProviderLoadsModelsError(failure)).toBe(false)
  })

  it("does not invoke a cause accessor", () => {
    const readCause = vi.fn(() => "cause")
    const error = new Error("accessor cause")
    Object.defineProperty(error, "cause", { get: readCause })

    expect(isLlmProviderLoadsModelsError(error)).toBe(false)
    expect(readCause).not.toHaveBeenCalled()
  })

  it("treats an uninspectable error as unrecognized", () => {
    const uninspectable = new Proxy(new Error("proxied"), {
      getOwnPropertyDescriptor: () => {
        throw new Error("inspection refused")
      }
    })

    expect(isLlmProviderLoadsModelsError(uninspectable)).toBe(false)
  })
})
