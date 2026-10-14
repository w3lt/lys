import type { ToolDefinition } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateToolCallGate,
  type ToolCallSettings
} from "@/lib/store/tool-calls/tool-call-gate"
import type { ToolListState } from "@/lib/store/tools"
import {
  buildBackendToolDefinition,
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

/** Validated input of {@link READ_CALL}. */
const READ_INPUT = {
  runner: "client",
  toolName: "read_text_file",
  input: { path: "/notes/todo.md" }
}

/** Validated input of {@link PAGE_CALL}. */
const PAGE_INPUT = {
  runner: "backend",
  toolName: "read_page",
  url: "https://example.com/docs",
  host: "example.com"
}

/** Tool list states in which no list is displayed. */
const UNREAD_TOOL_LISTS: readonly ToolListState[] = Object.freeze([
  Object.freeze({ status: "idle" }),
  Object.freeze({ status: "loading" }),
  Object.freeze({ status: "failed", error: "Lys couldn't read its tool list." })
])

/**
 * Builds the tool settings sampled when a call arrives: both fixture tools
 * listed and tool calls on.
 *
 * @param switches - Tools the person switched on or off, by name; none by
 * default, so each tool is on or off as it starts.
 * @param justRunToolNames - Tools saved as Just run; none by default, so
 * every tool asks.
 * @param areToolCallsOn - Whether agents may call tools at all.
 * @returns The settings.
 */
function buildToolCallSettings(
  switches: Readonly<Record<string, boolean>> = {},
  justRunToolNames: readonly string[] = [],
  areToolCallsOn = true
): ToolCallSettings {
  return {
    list: {
      status: "loaded",
      tools: [READ_TEXT_FILE, READ_PAGE],
      unavailableTools: new Map()
    },
    areToolCallsOn,
    toolChoices: {
      switches: new Map(Object.entries(switches)),
      justRunToolNames: new Set(justRunToolNames)
    }
  }
}

describe("calculateToolCallGate", () => {
  describe("a call that cannot be run", () => {
    it.each(UNREAD_TOOL_LISTS)(
      "is answered as not run while the tool list is $status",
      (list) => {
        const settings = { ...buildToolCallSettings(), list }

        expect(calculateToolCallGate(READ_CALL, settings)).toEqual({
          status: "answered",
          toolAnswer: {
            status: "failed",
            reason: "runFailed",
            content: "The desktop couldn't read its tool list."
          }
        })
      }
    )

    it("is answered as not run when the list has no tool of that name", () => {
      const call = buildToolCall(3, "delete_file")

      expect(calculateToolCallGate(call, buildToolCallSettings())).toEqual({
        status: "answered",
        toolAnswer: {
          status: "failed",
          reason: "runFailed",
          content: 'The desktop has no tool named "delete_file".'
        }
      })
    })

    it("is answered as not run when a listed desktop tool has no runner", () => {
      const deleteFile: ToolDefinition = buildToolDefinition("delete_file")
      const settings: ToolCallSettings = {
        ...buildToolCallSettings(),
        list: {
          status: "loaded",
          tools: [deleteFile],
          unavailableTools: new Map()
        }
      }

      expect(
        calculateToolCallGate(buildToolCall(3, "delete_file"), settings)
      ).toEqual({
        status: "answered",
        toolAnswer: {
          status: "failed",
          reason: "runFailed",
          content: 'The desktop has no tool named "delete_file".'
        }
      })
    })

    it("is answered as not run when a desktop tool's arguments do not match", () => {
      const call = buildToolCall(3, "read_text_file", { path: 7 })

      expect(calculateToolCallGate(call, buildToolCallSettings())).toEqual({
        status: "answered",
        toolAnswer: {
          status: "failed",
          reason: "runFailed",
          content: expect.stringMatching(
            /^The arguments do not match read_text_file: path: /
          )
        }
      })
    })

    it("is answered as not run when a backend tool's URL is not one the backend reads, even on Just run", () => {
      const call = buildToolCall(3, "read_page", { url: "file:///etc/passwd" })
      const settings = buildToolCallSettings({ read_page: true }, ["read_page"])

      expect(calculateToolCallGate(call, settings)).toEqual({
        status: "answered",
        toolAnswer: {
          status: "failed",
          reason: "runFailed",
          content:
            "The arguments do not match read_page: url: expected an absolute http or https URL."
        }
      })
    })
  })

  describe("a call the person switched off", () => {
    it("is declined when tool calls are off, whatever the tool's own choice", () => {
      const settings = buildToolCallSettings(
        { read_text_file: true },
        ["read_text_file"],
        false
      )

      expect(calculateToolCallGate(READ_CALL, settings)).toEqual({
        status: "answered",
        toolAnswer: {
          status: "failed",
          reason: "declined",
          content: "The person switched tool calls off."
        }
      })
    })

    it("is declined when its tool is off", () => {
      const settings = buildToolCallSettings({ read_text_file: false }, [
        "read_text_file"
      ])

      expect(calculateToolCallGate(READ_CALL, settings)).toEqual({
        status: "answered",
        toolAnswer: {
          status: "failed",
          reason: "declined",
          content: "The person switched this tool off."
        }
      })
    })

    it("is declined for a backend tool the person never switched on", () => {
      expect(calculateToolCallGate(PAGE_CALL, buildToolCallSettings())).toEqual(
        {
          status: "answered",
          toolAnswer: {
            status: "failed",
            reason: "declined",
            content: "The person switched this tool off."
          }
        }
      )
    })
  })

  describe("a call whose tool is on", () => {
    it("asks the person first for a desktop tool whose name is not saved as Just run", () => {
      expect(calculateToolCallGate(READ_CALL, buildToolCallSettings())).toEqual(
        { status: "ask", definition: READ_TEXT_FILE, input: READ_INPUT }
      )
    })

    it("runs a desktop tool at once when its name is saved as Just run", () => {
      const settings = buildToolCallSettings({}, ["read_text_file"])

      expect(calculateToolCallGate(READ_CALL, settings)).toEqual({
        status: "run",
        input: READ_INPUT
      })
    })

    it("asks the person first for a backend tool whose name is not saved as Just run, with the page it would request", () => {
      const settings = buildToolCallSettings({ read_page: true }, [
        "read_text_file"
      ])

      expect(calculateToolCallGate(PAGE_CALL, settings)).toEqual({
        status: "ask",
        definition: READ_PAGE,
        input: PAGE_INPUT
      })
    })

    it("allows a backend tool at once when its name is saved as Just run, since the backend runs it", () => {
      const settings = buildToolCallSettings({ read_page: true }, ["read_page"])

      expect(calculateToolCallGate(PAGE_CALL, settings)).toEqual({
        status: "answered",
        toolAnswer: { status: "allowed" }
      })
    })
  })
})
