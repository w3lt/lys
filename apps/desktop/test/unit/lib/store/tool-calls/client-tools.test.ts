import { chatToolResultSchema, savedLocationSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import type {
  GetCurrentTimeResult,
  GetLocationResult,
  ReadTextFileResult,
  SearchFilesResult
} from "@/lib/apis/tauri/tools"
import {
  buildRunFailedToolResult,
  formatRejectedToolCallContent,
  parseClientToolInput,
  runClientTool,
  type ClientToolCommands,
  type ClientToolInput
} from "@/lib/store/tool-calls/client-tools"
import { buildToolCall } from "../../../support/toolFixtures"

/** Search the model asked for in the search-files cases. */
const SEARCH_FILTER = Object.freeze({
  root: "/Users/fixture/project",
  query: "TODO",
  target: "content",
  maxResults: 20
} as const)

/** Report of a search that found one content match. */
const SEARCH_REPORT = Object.freeze({
  matches: [
    {
      kind: "content",
      path: "/Users/fixture/project/notes.md",
      snippets: [
        { lineNumber: 3, text: "TODO: write tests", isPartialLine: false }
      ]
    }
  ],
  completion: "complete",
  skippedPathCount: 0,
  oversizedFileCount: 1
} as const)

/** Validated input of a read of the fixture notes. */
const READ_INPUT: ClientToolInput = Object.freeze({
  runner: "client",
  toolName: "read_text_file",
  input: Object.freeze({ path: "/notes/todo.md" })
})

/** Validated input of {@link SEARCH_FILTER}. */
const SEARCH_INPUT: ClientToolInput = Object.freeze({
  runner: "client",
  toolName: "search_files",
  filter: SEARCH_FILTER
})

/** Validated input of a current-time read. */
const CURRENT_TIME_INPUT: ClientToolInput = Object.freeze({
  runner: "client",
  toolName: "get_current_time"
})

/** Validated input of a location read. */
const LOCATION_INPUT: ClientToolInput = Object.freeze({
  runner: "client",
  toolName: "get_location"
})

/**
 * Desktop commands that each reject, so a command a case did not expect
 * becomes a run-failed answer instead of passing.
 */
const UNEXPECTED_COMMANDS: ClientToolCommands = Object.freeze({
  readTextFile: () => Promise.reject(new Error("unexpected read")),
  findFiles: () => Promise.reject(new Error("unexpected search")),
  getCurrentTime: () => Promise.reject(new Error("unexpected time read")),
  getLocation: () => Promise.reject(new Error("unexpected location read"))
})

/**
 * Builds desktop commands in which only the read settles as the case says.
 *
 * @param readTextFile - Outcome of the read-text-file command.
 * @returns Commands whose others reject.
 */
function buildReadCommands(
  readTextFile: ClientToolCommands["readTextFile"]
): ClientToolCommands {
  return { ...UNEXPECTED_COMMANDS, readTextFile }
}

/**
 * Builds desktop commands in which only the search settles as the case says.
 *
 * @param findFiles - Outcome of the search-files command.
 * @returns Commands whose others reject.
 */
function buildSearchCommands(
  findFiles: ClientToolCommands["findFiles"]
): ClientToolCommands {
  return { ...UNEXPECTED_COMMANDS, findFiles }
}

describe("parseClientToolInput", () => {
  it("parses a read-text-file call into the file to read", () => {
    expect(parseClientToolInput(buildToolCall(1, "read_text_file"))).toEqual({
      status: "parsed",
      input: {
        runner: "client",
        toolName: "read_text_file",
        input: { path: "/notes/todo.md" }
      }
    })
  })

  it("parses a search-files call into its filter, with only the limits the model sent", () => {
    const call = buildToolCall(1, "search_files", SEARCH_FILTER)

    expect(parseClientToolInput(call)).toEqual({
      status: "parsed",
      input: {
        runner: "client",
        toolName: "search_files",
        filter: SEARCH_FILTER
      }
    })
  })

  it.each(["get_current_time", "get_location"] as const)(
    "parses a %s call that has no arguments",
    (toolName) => {
      expect(parseClientToolInput(buildToolCall(1, toolName, {}))).toEqual({
        status: "parsed",
        input: { runner: "client", toolName }
      })
    }
  )

  it("rejects a tool the desktop has no runner for", () => {
    expect(parseClientToolInput(buildToolCall(1, "delete_file"))).toEqual({
      status: "rejected",
      content: 'The desktop has no tool named "delete_file".'
    })
  })

  it.each([
    ["read_text_file", { path: 7 }, /: path: /],
    ["read_text_file", {}, /: path: /],
    [
      "search_files",
      { root: "/Users/fixture", query: "TODO", target: "everything" },
      /: target: /
    ],
    ["get_current_time", { timeZone: "UTC" }, /: arguments: /],
    ["get_location", { precision: "street" }, /: arguments: /]
  ])(
    "rejects a %s call whose arguments are %o, naming the argument",
    (toolName, callArguments, argumentPattern) => {
      const result = parseClientToolInput(
        buildToolCall(1, toolName, callArguments)
      )

      expect(result).toEqual({
        status: "rejected",
        content: expect.stringMatching(argumentPattern)
      })
      expect(result).toHaveProperty(
        "content",
        expect.stringMatching(
          new RegExp(`^The arguments do not match ${toolName}: .+\\.$`)
        )
      )
    }
  )

  it("names every mismatched argument of one call", () => {
    const call = buildToolCall(1, "search_files", {
      root: "/Users/fixture",
      query: 3,
      target: "everything"
    })

    expect(parseClientToolInput(call)).toEqual({
      status: "rejected",
      content: expect.stringMatching(/: query: .+; target: .+\.$/)
    })
  })

  it("names the arguments as a whole for a problem that belongs to no single one", () => {
    const call = buildToolCall(1, "read_text_file", {
      path: "/notes/todo.md",
      encoding: "utf-8"
    })

    expect(parseClientToolInput(call)).toEqual({
      status: "rejected",
      content: expect.stringMatching(
        /^The arguments do not match read_text_file: arguments: .+\.$/
      )
    })
  })
})

describe("buildRunFailedToolResult", () => {
  it("builds a failed answer the tool-result endpoint accepts, marked as not run", () => {
    const result = buildRunFailedToolResult("The desktop has no such tool.")

    expect(result).toEqual({
      status: "failed",
      reason: "runFailed",
      content: "The desktop has no such tool."
    })
    expect(chatToolResultSchema.safeParse(result).success).toBe(true)
  })
})

describe("formatRejectedToolCallContent", () => {
  it.each(["", "  \n\t "])(
    "says only that the person declined when the reason is %o",
    (note) => {
      expect(formatRejectedToolCallContent(note)).toBe(
        "The person declined this call."
      )
    }
  )

  it("adds the trimmed reason the person typed", () => {
    expect(formatRejectedToolCallContent("  not that folder \n")).toBe(
      "The person declined this call. They said: not that folder"
    )
  })
})

describe("runClientTool", () => {
  it.each(["Buy milk.\n", ""])(
    "reads the called file and answers with its text %o",
    async (content) => {
      const readPaths: string[] = []
      const commands = buildReadCommands((input) => {
        readPaths.push(input.path)
        return Promise.resolve({ status: "succeeded", content })
      })

      await expect(runClientTool(READ_INPUT, commands)).resolves.toEqual({
        status: "succeeded",
        content
      })
      expect(readPaths).toEqual(["/notes/todo.md"])
    }
  )

  it("answers a read the desktop declared failed with that failure as JSON", async () => {
    const failure: ReadTextFileResult = {
      status: "failed",
      error: { code: "fileTooLarge", sizeBytes: 2_000_000, maxSizeBytes: 1024 }
    }

    const result = await runClientTool(
      READ_INPUT,
      buildReadCommands(() => Promise.resolve(failure))
    )

    expect(result).toMatchObject({ status: "failed", reason: "toolFailed" })
    expect(JSON.parse(result.content)).toEqual(failure.error)
  })

  it("searches with the called filter and answers with the report as JSON", async () => {
    const filters: unknown[] = []
    const commands = buildSearchCommands((filter) => {
      filters.push(filter)
      return Promise.resolve({ status: "succeeded", report: SEARCH_REPORT })
    })

    const result = await runClientTool(SEARCH_INPUT, commands)

    expect(result.status).toBe("succeeded")
    expect(JSON.parse(result.content)).toEqual(SEARCH_REPORT)
    expect(filters).toEqual([SEARCH_FILTER])
  })

  it("answers a search the desktop declared failed with that failure as JSON", async () => {
    const failure: SearchFilesResult = {
      status: "failed",
      error: { code: "rootNotFound" }
    }

    const result = await runClientTool(
      SEARCH_INPUT,
      buildSearchCommands(() => Promise.resolve(failure))
    )

    expect(result).toMatchObject({ status: "failed", reason: "toolFailed" })
    expect(JSON.parse(result.content)).toEqual(failure.error)
  })

  it("reads the current time and answers with it as JSON", async () => {
    const currentTime = {
      dateTime: "2026-10-22T21:30:05+02:00",
      weekday: "Thursday",
      utcOffset: "+02:00",
      timeZone: "Europe/Paris"
    } as const
    const commands: ClientToolCommands = {
      ...UNEXPECTED_COMMANDS,
      getCurrentTime: () =>
        Promise.resolve({ status: "succeeded", currentTime })
    }

    const result = await runClientTool(CURRENT_TIME_INPUT, commands)

    expect(result.status).toBe("succeeded")
    expect(JSON.parse(result.content)).toEqual(currentTime)
  })

  it("reads the saved location and answers with it as JSON", async () => {
    const location = { city: "Lyon", region: null, country: "France" }
    const commands: ClientToolCommands = {
      ...UNEXPECTED_COMMANDS,
      getLocation: () =>
        Promise.resolve({
          status: "succeeded",
          location: savedLocationSchema.parse(location)
        })
    }

    const result = await runClientTool(LOCATION_INPUT, commands)

    expect(result.status).toBe("succeeded")
    expect(JSON.parse(result.content)).toEqual(location)
  })

  it.each([
    [
      "get_current_time",
      CURRENT_TIME_INPUT,
      {
        ...UNEXPECTED_COMMANDS,
        getCurrentTime: () =>
          Promise.resolve<GetCurrentTimeResult>({
            status: "failed",
            error: { code: "timeZoneUnknown" }
          })
      },
      { code: "timeZoneUnknown" }
    ],
    [
      "get_location",
      LOCATION_INPUT,
      {
        ...UNEXPECTED_COMMANDS,
        getLocation: () =>
          Promise.resolve<GetLocationResult>({
            status: "failed",
            error: { code: "locationNotSet" }
          })
      },
      { code: "locationNotSet" }
    ]
  ])(
    "answers a %s call the desktop declared failed with that failure as JSON",
    async (_toolName, input, commands, failure) => {
      const result = await runClientTool(input, commands)

      expect(result).toMatchObject({ status: "failed", reason: "toolFailed" })
      expect(JSON.parse(result.content)).toEqual(failure)
    }
  )

  it("answers that the tool could not run, with the reason, when its command throws", async () => {
    const commands = buildReadCommands(() =>
      Promise.reject(new Error("command read_text_file not found"))
    )

    await expect(runClientTool(READ_INPUT, commands)).resolves.toEqual({
      status: "failed",
      reason: "runFailed",
      content: "read_text_file could not run: command read_text_file not found"
    })
  })

  it.each([
    ["a value that is not an error", "command find_files not found"],
    ["an error without a message", new Error("")]
  ])(
    "answers that the tool could not run, without a reason, when its command throws %s",
    async (_label, thrown) => {
      const commands = buildSearchCommands(() => Promise.reject(thrown))

      await expect(runClientTool(SEARCH_INPUT, commands)).resolves.toEqual({
        status: "failed",
        reason: "runFailed",
        content: "search_files could not run: it failed"
      })
    }
  )
})
