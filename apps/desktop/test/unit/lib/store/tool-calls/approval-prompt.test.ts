import type { ToolDefinition } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  ALLOWED_TOOL_APPROVAL,
  buildDeclinedToolApproval,
  calculateToolApprovalPrompt
} from "@/lib/store/tool-calls/approval-prompt"
import type { ToolListState } from "@/lib/store/tools"
import {
  buildBackendToolDefinition,
  buildMcpToolDefinition,
  buildToolCall,
  buildToolDefinition
} from "../../../support/toolFixtures"

/** Desktop tool that reads one file on this machine. */
const READ_TEXT_FILE = buildToolDefinition("read_text_file")

/** Backend tool that requests one page off this machine. */
const READ_PAGE = buildBackendToolDefinition("read_page")

/** Call of {@link READ_TEXT_FILE} with a valid path. */
const READ_CALL = buildToolCall(1, "read_text_file")

/** Call of {@link READ_PAGE} with a valid URL. */
const PAGE_CALL = buildToolCall(2, "read_page", {
  url: "https://example.com/docs"
})

/** Tool list in which both fixture tools are listed. */
const LOADED_TOOL_LIST: ToolListState = Object.freeze({
  status: "loaded",
  tools: [READ_TEXT_FILE, READ_PAGE],
  unavailableTools: new Map()
})

/** Tool list states in which no list is displayed. */
const UNREAD_TOOL_LISTS: readonly ToolListState[] = Object.freeze([
  Object.freeze({ status: "idle" }),
  Object.freeze({ status: "loading" }),
  Object.freeze({ status: "failed", error: "Lys couldn't read its tool list." })
])

/**
 * Builds the answer the desktop sends for a call it cannot show.
 *
 * @param content - Explanation the model reads.
 * @returns The rejected answer.
 */
function buildShowFailedAnswer(content: unknown) {
  return {
    status: "rejected",
    toolAnswer: { status: "rejected", reason: "showFailed", content }
  }
}

describe("calculateToolApprovalPrompt", () => {
  it("asks the person about a desktop tool's call, with the file it would read", () => {
    expect(calculateToolApprovalPrompt(READ_CALL, LOADED_TOOL_LIST)).toEqual({
      status: "ask",
      definition: READ_TEXT_FILE,
      input: {
        runner: "client",
        toolName: "read_text_file",
        input: { path: "/notes/todo.md" }
      }
    })
  })

  it("asks the person about a backend tool's call, with the page it would request", () => {
    expect(calculateToolApprovalPrompt(PAGE_CALL, LOADED_TOOL_LIST)).toEqual({
      status: "ask",
      definition: READ_PAGE,
      input: {
        runner: "backend",
        toolName: "read_page",
        url: "https://example.com/docs"
      }
    })
  })

  it.each(UNREAD_TOOL_LISTS)(
    "rejects a call it cannot show while the tool list is $status",
    (list) => {
      expect(calculateToolApprovalPrompt(READ_CALL, list)).toEqual(
        buildShowFailedAnswer("The desktop couldn't read its tool list.")
      )
    }
  )

  it("asks the person about an MCP tool's call, with its server and the name the server calls it by, whatever its arguments", () => {
    const notesSearch = buildMcpToolDefinition("notes", "search")
    const list: ToolListState = Object.freeze({
      status: "loaded",
      tools: [READ_TEXT_FILE, notesSearch],
      unavailableTools: new Map()
    })
    const call = buildToolCall(3, notesSearch.name, {
      query: { nested: [1, true, null] },
      extra: "not in the schema"
    })

    expect(calculateToolApprovalPrompt(call, list)).toEqual({
      status: "ask",
      definition: notesSearch,
      input: {
        runner: "mcp",
        toolName: notesSearch.name,
        server: "notes",
        serverToolName: "search"
      }
    })
  })

  it("rejects a call of a tool the list does not have", () => {
    expect(
      calculateToolApprovalPrompt(
        buildToolCall(3, "delete_file"),
        LOADED_TOOL_LIST
      )
    ).toEqual(
      buildShowFailedAnswer('The desktop has no tool named "delete_file".')
    )
  })

  it("rejects a call of a listed desktop tool the desktop cannot describe", () => {
    const deleteFile: ToolDefinition = buildToolDefinition("delete_file")
    const list: ToolListState = {
      status: "loaded",
      tools: [deleteFile],
      unavailableTools: new Map()
    }

    expect(
      calculateToolApprovalPrompt(buildToolCall(3, "delete_file"), list)
    ).toEqual(
      buildShowFailedAnswer('The desktop has no tool named "delete_file".')
    )
  })

  it("rejects a desktop tool's call whose arguments it cannot describe", () => {
    const call = buildToolCall(3, "read_text_file", { path: 7 })

    expect(calculateToolApprovalPrompt(call, LOADED_TOOL_LIST)).toEqual(
      buildShowFailedAnswer(
        expect.stringMatching(
          /^The arguments do not match read_text_file: path: /
        )
      )
    )
  })

  it("rejects a backend tool's call whose URL is not one the backend reads", () => {
    const call = buildToolCall(3, "read_page", { url: "file:///etc/passwd" })

    expect(calculateToolApprovalPrompt(call, LOADED_TOOL_LIST)).toEqual(
      buildShowFailedAnswer(
        "The arguments do not match read_page: url: expected an absolute http or https URL."
      )
    )
  })
})

describe("ALLOWED_TOOL_APPROVAL", () => {
  it("is the answer that allows a call", () => {
    expect(ALLOWED_TOOL_APPROVAL).toEqual({ status: "allowed" })
  })
})

describe("buildDeclinedToolApproval", () => {
  it("declines a call, with the person's note for the model when there is one", () => {
    expect(buildDeclinedToolApproval("  not that folder \n")).toEqual({
      status: "rejected",
      reason: "declined",
      content: "The person declined this call. They said: not that folder"
    })
  })

  it("declines a call without a note", () => {
    expect(buildDeclinedToolApproval("")).toEqual({
      status: "rejected",
      reason: "declined",
      content: "The person declined this call."
    })
  })
})
