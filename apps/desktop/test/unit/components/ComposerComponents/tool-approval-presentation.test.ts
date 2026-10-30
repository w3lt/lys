import { describe, expect, it } from "vitest"
import {
  formatToolCallAnnouncement,
  formatToolCallSummary
} from "@/components/ComposerComponents/tool-approval-presentation"
import type { ShownToolCall, ToolCallInput } from "@/lib/store/tool-calls"
import {
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import { buildToolCall, buildToolDefinition } from "../../support/toolFixtures"

/** Validated input of a read of the fixture notes. */
const READ_INPUT: ToolCallInput = Object.freeze({
  runner: "client",
  toolName: "read_text_file",
  input: { path: "/notes/todo.md" }
})

/** Call of the read-text-file tool the store holds for its reply. */
const READ_CALL = buildToolCall(10, "read_text_file")

/** Address of {@link READ_CALL}'s answer. */
const READ_CALL_TARGET = Object.freeze({
  conversationId: FIXTURE_CONVERSATION_ID,
  assistantMessageId: createFixtureUuidV7(3),
  callId: READ_CALL.id
})

describe("formatToolCallSummary", () => {
  it("says which file a read opens and that nothing is changed", () => {
    expect(formatToolCallSummary(READ_INPUT)).toBe(
      "Read /notes/todo.md. Nothing is changed."
    )
  })

  it.each([
    ["name", "file names"],
    ["content", "file contents"],
    ["nameAndContent", "file names and contents"]
  ] as const)(
    "says what a search by %s compares, where, and for what",
    (target, phrase) => {
      expect(
        formatToolCallSummary({
          runner: "client",
          toolName: "search_files",
          filter: { root: "/Users/fixture/project", query: "TODO", target }
        })
      ).toBe(
        `Search ${phrase} under /Users/fixture/project for “TODO”. Nothing is changed.`
      )
    }
  )

  it.each([
    [
      "get_current_time",
      "Read the date, time, and time zone of this machine. Nothing is changed."
    ],
    [
      "get_location",
      "Read the location you saved in Settings → Tools. Nothing is changed."
    ]
  ] as const)(
    "says what a %s call reads and that nothing is changed",
    (toolName, summary) => {
      expect(formatToolCallSummary({ runner: "client", toolName })).toBe(
        summary
      )
    }
  )

  it("names the full URL a page read reads", () => {
    expect(
      formatToolCallSummary({
        runner: "backend",
        toolName: "read_page",
        url: "https://example.com:8443/docs?lang=en"
      })
    ).toBe("Read https://example.com:8443/docs?lang=en.")
  })

  it("quotes a web search's full query and names where it is sent", () => {
    expect(
      formatToolCallSummary({
        runner: "backend",
        toolName: "web_search",
        query: "thời tiết Hà Nội",
        host: "api.tavily.com"
      })
    ).toBe(
      "Search the web for “thời tiết Hà Nội”. Sends the query to Tavily (api.tavily.com)."
    )
  })

  it("asks whether to run an MCP tool, by its server's name for it, on its server", () => {
    expect(
      formatToolCallSummary({
        runner: "mcp",
        toolName: "mcp__notes__search_notes",
        server: "notes",
        serverToolName: "search-notes"
      })
    ).toBe("Run search-notes on the MCP server notes?")
  })
})

describe("formatToolCallAnnouncement", () => {
  it("names the agent, the tool, and what the waiting call will do", () => {
    const waitingCall: ShownToolCall = {
      target: READ_CALL_TARGET,
      call: READ_CALL,
      step: "approval",
      answer: {
        status: "awaiting-person",
        definition: buildToolDefinition("read_text_file"),
        input: READ_INPUT
      }
    }

    expect(formatToolCallAnnouncement(waitingCall, "Caliginia")).toBe(
      "Caliginia is waiting for you to allow or reject read_text_file: Read /notes/todo.md. Nothing is changed."
    )
  })

  it("announces nothing for an answer that failed to send, which its own card announces", () => {
    const unsentCall: ShownToolCall = {
      target: READ_CALL_TARGET,
      call: READ_CALL,
      step: "run",
      answer: {
        status: "send-failed",
        toolAnswer: { status: "succeeded", content: "Buy milk." },
        error: "Couldn't send the answer to Lys."
      }
    }

    expect(formatToolCallAnnouncement(unsentCall, "Caliginia")).toBe("")
  })

  it("announces nothing while no call is shown", () => {
    expect(formatToolCallAnnouncement(undefined, "Caliginia")).toBe("")
  })
})
