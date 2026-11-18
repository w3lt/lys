import type { ChatToolCall } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { parseBackendToolInput } from "@/lib/store/tool-calls/backend-tools"
import { buildToolCall } from "../../../support/toolFixtures"

/**
 * Arguments of a `delegate_work` call that starts a job, with the spaces
 * around the title and the instructions that a model may send.
 */
const NEW_JOB_ARGUMENTS: ChatToolCall["arguments"] = Object.freeze({
  agent: "nyx",
  title: " News ",
  instructions: " Find this week's hologram news. "
})

describe("parseBackendToolInput", () => {
  it("parses a read-page call into the page's URL", () => {
    const call = buildToolCall(1, "read_page", {
      url: "https://example.com/docs/intro?lang=en#setup"
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "read_page",
        url: "https://example.com/docs/intro?lang=en#setup"
      }
    })
  })

  it("normalizes the URL as a URL parser does", () => {
    const call = buildToolCall(1, "read_page", {
      url: "HTTP://Example.COM:8080/a b"
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "read_page",
        url: "http://example.com:8080/a%20b"
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

  it("parses a web search call into the trimmed query and the host it is sent to", () => {
    const call = buildToolCall(1, "web_search", {
      query: "  thời tiết Hà Nội \n"
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "web_search",
        query: "thời tiết Hà Nội",
        host: "api.tavily.com"
      }
    })
  })

  // Each would leave the card showing less than the query sent to Tavily,
  // or describe a query the backend never sends.
  it.each([
    ["a blank query", { query: " \n\t " }],
    ["a query that is not text", { query: 42 }],
    ["no query", {}],
    [
      "a query hiding text in tag characters",
      { query: "weather\u{e0073}\u{e0073}\u{e006e}" }
    ],
    [
      "a query hiding text in variation selectors",
      { query: "weather\u{e0163}\u{e0163}\u{e015e}" }
    ],
    ["a query with a zero-width space", { query: "weather\u200bhanoi" }],
    ["a query with a direction override", { query: "weather \u202eionah" }],
    ["a query with a line break inside", { query: "weather\nhanoi" }]
  ])("rejects a web search call with %s", (_label, callArguments) => {
    const call = buildToolCall(1, "web_search", callArguments)

    expect(parseBackendToolInput(call)).toEqual({
      status: "rejected",
      content:
        "The arguments do not match web_search: query: expected text that is not blank and holds no character hidden on screen."
    })
  })

  it("describes a call that starts a job", () => {
    const call = buildToolCall(65, "delegate_work", NEW_JOB_ARGUMENTS)

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "delegate_work",
        agentCode: "nyx",
        title: "News",
        instructions: "Find this week's hologram news.",
        jobNumber: undefined
      }
    })
  })

  it("describes a call that continues a job", () => {
    const call = buildToolCall(65, "delegate_work", {
      ...NEW_JOB_ARGUMENTS,
      job: 2
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "delegate_work",
        agentCode: "nyx",
        title: "News",
        instructions: "Find this week's hologram news.",
        jobNumber: 2
      }
    })
  })

  it("takes a title of 80 characters once it is trimmed", () => {
    const title = "n".repeat(80)
    const call = buildToolCall(65, "delegate_work", {
      ...NEW_JOB_ARGUMENTS,
      title: ` ${title} `
    })

    expect(parseBackendToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "backend",
        toolName: "delegate_work",
        agentCode: "nyx",
        title,
        instructions: "Find this week's hologram news.",
        jobNumber: undefined
      }
    })
  })

  // Each is a call the backend refuses before it asks the person, so the
  // card must never describe it.
  it.each([
    [
      "no agent",
      { title: "News", instructions: "Find this week's hologram news." },
      "agent: expected an agent code."
    ],
    [
      "an agent that is no agent code",
      { ...NEW_JOB_ARGUMENTS, agent: "Nyx Prime" },
      "agent: expected an agent code."
    ],
    [
      "a blank title",
      { ...NEW_JOB_ARGUMENTS, title: " \n " },
      "title: expected 1 to 80 characters on one line after trimming."
    ],
    [
      "a title of 81 characters",
      { ...NEW_JOB_ARGUMENTS, title: "n".repeat(81) },
      "title: expected 1 to 80 characters on one line after trimming."
    ],
    [
      "a title of two lines",
      { ...NEW_JOB_ARGUMENTS, title: "News\nToday" },
      "title: expected 1 to 80 characters on one line after trimming."
    ],
    [
      "a title split by a line separator",
      { ...NEW_JOB_ARGUMENTS, title: "News\u2028Today" },
      "title: expected 1 to 80 characters on one line after trimming."
    ],
    [
      "blank instructions",
      { ...NEW_JOB_ARGUMENTS, instructions: " \t " },
      "instructions: expected text that is not blank."
    ],
    [
      "job 0",
      { ...NEW_JOB_ARGUMENTS, job: 0 },
      "job: expected a whole number of 1 or more."
    ],
    [
      "job 1.5",
      { ...NEW_JOB_ARGUMENTS, job: 1.5 },
      "job: expected a whole number of 1 or more."
    ]
  ])(
    "rejects a delegate_work call with %s",
    (_label, callArguments, detail) => {
      const call = buildToolCall(65, "delegate_work", callArguments)

      expect(parseBackendToolInput(call)).toEqual({
        status: "rejected",
        content: `The arguments do not match delegate_work: ${detail}`
      })
    }
  )

  it("rejects a backend tool it has no description for, so the tool is not allowed", () => {
    const call = buildToolCall(1, "read_feed", { url: "https://example.com/" })

    expect(parseBackendToolInput(call)).toEqual({
      status: "rejected",
      content:
        'The desktop cannot describe the backend tool "read_feed", so it was not run.'
    })
  })
})
