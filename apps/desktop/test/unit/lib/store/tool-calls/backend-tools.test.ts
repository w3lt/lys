import { chatToolAnswerSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  ALLOWED_TOOL_ANSWER,
  parseBackendToolInput
} from "@/lib/store/tool-calls/backend-tools"
import { buildToolCall } from "../../../support/toolFixtures"

describe("ALLOWED_TOOL_ANSWER", () => {
  it("is the answer the tool-result endpoint takes as allowing a backend tool", () => {
    expect(chatToolAnswerSchema.parse(ALLOWED_TOOL_ANSWER)).toEqual({
      status: "allowed"
    })
  })
})

describe("parseBackendToolInput", () => {
  it("parses a read-page call into the page's URL and the host it is requested from", () => {
    const call = buildToolCall(1, "read_page", {
      url: "https://example.com/docs/intro?lang=en#setup"
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "read_page",
        url: "https://example.com/docs/intro?lang=en#setup",
        host: "example.com"
      }
    })
  })

  it("normalizes the URL as a URL parser does and keeps the port in the host", () => {
    const call = buildToolCall(1, "read_page", {
      url: "HTTP://Example.COM:8080/a b"
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "read_page",
        url: "http://example.com:8080/a%20b",
        host: "example.com:8080"
      }
    })
  })

  it.each([
    ["a relative URL", { url: "/docs/intro" }],
    ["text that is not a URL", { url: "the docs page" }],
    ["a file URL", { url: "file:///etc/passwd" }],
    ["a script URL", { url: "javascript:alert(1)" }],
    ["a URL of another network scheme", { url: "ftp://example.com/notes.txt" }],
    ["a URL that is not text", { url: 8080 }],
    ["no URL", {}]
  ])("rejects a read-page call with %s", (_label, callArguments) => {
    const call = buildToolCall(1, "read_page", callArguments)

    expect(parseBackendToolInput(call)).toEqual({
      status: "rejected",
      content:
        "The arguments do not match read_page: url: expected an absolute http or https URL."
    })
  })

  it("rejects a backend tool it has no description for, so the tool is not allowed", () => {
    const call = buildToolCall(1, "web_search", { query: "lys" })

    expect(parseBackendToolInput(call)).toEqual({
      status: "rejected",
      content:
        'The desktop cannot describe the backend tool "web_search", so it was not run.'
    })
  })
})
