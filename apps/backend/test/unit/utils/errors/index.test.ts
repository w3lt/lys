import { describe, expect, it } from "vitest"
import {
  ChatCompletionCancelledError,
  ConversationNotFoundError,
  TitleGenerationOutputError
} from "../../../../src/utils/errors"

describe("ConversationNotFoundError", () => {
  it("is a native error with a default message", () => {
    const error = new ConversationNotFoundError()

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/\S/)
    expect(error.cause).toBeUndefined()
  })

  it("keeps a supplied message and cause", () => {
    const cause = new Error("lookup failed")

    const error = new ConversationNotFoundError("Missing conversation", {
      cause
    })

    expect(error.message).toBe("Missing conversation")
    expect(error.cause).toBe(cause)
  })
})

describe("ChatCompletionCancelledError", () => {
  it("identifies a cancelled completion and keeps the SDK failure as its cause", () => {
    const sdkFailure = new Error("Request was aborted.")

    const error = new ChatCompletionCancelledError(sdkFailure)

    expect(error).toBeInstanceOf(Error)
    expect(error.cause).toBe(sdkFailure)
  })
})

describe("TitleGenerationOutputError", () => {
  it("keeps the unusable-output reason without a cause", () => {
    const error = new TitleGenerationOutputError("The title reply is blank")

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("The title reply is blank")
    expect(error.cause).toBeUndefined()
  })

  it("keeps the parse failure as its cause", () => {
    const parseFailure = new SyntaxError("Unexpected token")

    const error = new TitleGenerationOutputError(
      "The title reply is not JSON",
      {
        cause: parseFailure
      }
    )

    expect(error.cause).toBe(parseFailure)
  })

  it("is distinguishable from the other backend failures", () => {
    const error = new TitleGenerationOutputError("unusable")

    expect(error).not.toBeInstanceOf(ChatCompletionCancelledError)
    expect(error).not.toBeInstanceOf(ConversationNotFoundError)
  })
})
