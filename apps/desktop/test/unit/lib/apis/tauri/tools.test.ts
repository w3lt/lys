import { describe, expect, it } from "vitest"
import {
  findFiles,
  getCurrentTime,
  getLocation,
  listTools,
  readTextFile
} from "@/lib/apis/tauri/tools"
import { startNativeHostFake } from "../../../support/nativeHostFake"
import {
  buildBackendToolDefinition,
  buildToolDefinition
} from "../../../support/toolFixtures"

/** Search the desktop runs in the find-files cases. */
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
})

describe("readTextFile", () => {
  it("sends the path and returns the file's text", async () => {
    const host = startNativeHostFake({ read_text_file: () => "line one\n" })

    await expect(readTextFile({ path: "/tmp/notes.md" })).resolves.toEqual({
      status: "succeeded",
      content: "line one\n"
    })
    expect(host.commands).toEqual([
      { command: "read_text_file", args: { path: "/tmp/notes.md" } }
    ])
  })

  it.each([
    { code: "fileNotFound" },
    { code: "fileTooLarge", sizeBytes: 2_000_000, maxSizeBytes: 1_048_576 },
    { code: "readFailed", message: "I/O error" }
  ])("returns the declared $code failure", async (error) => {
    startNativeHostFake({ read_text_file: () => Promise.reject(error) })

    await expect(readTextFile({ path: "/tmp/notes.md" })).resolves.toEqual({
      status: "failed",
      error
    })
  })

  it("rejects an undeclared rejection and keeps it as the cause", async () => {
    const rejection = "command read_text_file not found"
    startNativeHostFake({ read_text_file: () => Promise.reject(rejection) })

    await expect(readTextFile({ path: "/tmp/notes.md" })).rejects.toMatchObject(
      {
        cause: rejection
      }
    )
  })

  it("rejects a result that is not text", async () => {
    startNativeHostFake({ read_text_file: () => ({ content: "x" }) })

    await expect(readTextFile({ path: "/tmp/notes.md" })).rejects.toMatchObject(
      {
        name: "ZodError"
      }
    )
  })

  it("rejects input with an unknown field without invoking the command", async () => {
    const host = startNativeHostFake({})
    const input = { path: "/tmp/notes.md", encoding: "latin1" }

    await expect(readTextFile(input)).rejects.toMatchObject({
      name: "ZodError"
    })
    expect(host.commands).toEqual([])
  })
})

describe("findFiles", () => {
  it("sends the filter as the command's filter argument and returns the report", async () => {
    const host = startNativeHostFake({ find_files: () => SEARCH_REPORT })

    await expect(findFiles(SEARCH_FILTER)).resolves.toEqual({
      status: "succeeded",
      report: SEARCH_REPORT
    })
    expect(host.commands).toEqual([
      { command: "find_files", args: { filter: SEARCH_FILTER } }
    ])
  })

  it.each([
    { code: "rootNotFound" },
    { code: "queryTooLong", maxChars: 200 },
    { code: "searchFailed", message: "walk failed" }
  ])("returns the declared $code failure", async (error) => {
    startNativeHostFake({ find_files: () => Promise.reject(error) })

    await expect(findFiles(SEARCH_FILTER)).resolves.toEqual({
      status: "failed",
      error
    })
  })

  it("rejects an undeclared rejection and keeps it as the cause", async () => {
    const rejection = { code: "somethingNew" }
    startNativeHostFake({ find_files: () => Promise.reject(rejection) })

    await expect(findFiles(SEARCH_FILTER)).rejects.toMatchObject({
      cause: rejection
    })
  })

  it("rejects a malformed report", async () => {
    startNativeHostFake({
      find_files: () => ({ ...SEARCH_REPORT, completion: "partial" })
    })

    await expect(findFiles(SEARCH_FILTER)).rejects.toMatchObject({
      name: "ZodError"
    })
  })

  it("rejects a negative result limit without invoking the command", async () => {
    const host = startNativeHostFake({})

    await expect(
      findFiles({ ...SEARCH_FILTER, maxResults: -1 })
    ).rejects.toMatchObject({ name: "ZodError" })
    expect(host.commands).toEqual([])
  })
})

/** Time the desktop reports in the get-current-time cases. */
const CURRENT_TIME = Object.freeze({
  dateTime: "2026-10-22T21:30:05+02:00",
  weekday: "Thursday",
  utcOffset: "+02:00",
  timeZone: "Europe/Paris"
})

describe("getCurrentTime", () => {
  it("sends no arguments and returns the machine's time", async () => {
    const host = startNativeHostFake({ get_current_time: () => CURRENT_TIME })

    await expect(getCurrentTime()).resolves.toEqual({
      status: "succeeded",
      currentTime: CURRENT_TIME
    })
    expect(host.commands).toEqual([{ command: "get_current_time", args: {} }])
  })

  it("returns a time zone without an IANA name as null", async () => {
    const currentTime = { ...CURRENT_TIME, timeZone: null }
    startNativeHostFake({ get_current_time: () => currentTime })

    await expect(getCurrentTime()).resolves.toEqual({
      status: "succeeded",
      currentTime
    })
  })

  it("returns the declared timeZoneUnknown failure", async () => {
    startNativeHostFake({
      get_current_time: () => Promise.reject({ code: "timeZoneUnknown" })
    })

    await expect(getCurrentTime()).resolves.toEqual({
      status: "failed",
      error: { code: "timeZoneUnknown" }
    })
  })

  it("rejects an undeclared rejection and keeps it as the cause", async () => {
    const rejection = "command get_current_time not found"
    startNativeHostFake({ get_current_time: () => Promise.reject(rejection) })

    await expect(getCurrentTime()).rejects.toMatchObject({
      message:
        "The get_current_time command failed without a declared tool failure.",
      cause: rejection
    })
  })

  it.each([
    ["a date without its offset", { dateTime: "2026-10-22T21:30:05" }],
    ["an unknown weekday", { weekday: "Thor's day" }],
    ["an extra field", { latitude: 45.76 }]
  ])("rejects a time with %s", async (_label, change) => {
    startNativeHostFake({
      get_current_time: () => ({ ...CURRENT_TIME, ...change })
    })

    await expect(getCurrentTime()).rejects.toMatchObject({ name: "ZodError" })
  })
})

describe("getLocation", () => {
  it("sends no arguments and returns the saved location", async () => {
    const location = { city: "Lyon", region: null, country: "France" }
    const host = startNativeHostFake({ get_location: () => location })

    await expect(getLocation()).resolves.toEqual({
      status: "succeeded",
      location
    })
    expect(host.commands).toEqual([{ command: "get_location", args: {} }])
  })

  it.each([{ code: "locationNotSet" }, { code: "settingsUnreadable" }])(
    "returns the declared $code failure",
    async (error) => {
      startNativeHostFake({ get_location: () => Promise.reject(error) })

      await expect(getLocation()).resolves.toEqual({ status: "failed", error })
    }
  )

  it("rejects an undeclared rejection and keeps it as the cause", async () => {
    const rejection = { code: "settingsUnreadable", path: "/Users/fixture" }
    startNativeHostFake({ get_location: () => Promise.reject(rejection) })

    await expect(getLocation()).rejects.toMatchObject({
      message:
        "The get_location command failed without a declared tool failure.",
      cause: rejection
    })
  })

  it.each([
    ["no saved part", { city: null, region: null, country: null }],
    ["a padded name", { city: " Lyon", region: null, country: null }],
    [
      "a name ending in a no-break space",
      { city: null, region: null, country: "France\u00a0" }
    ],
    ["a tab in a name", { city: "Lyon\tCentre", region: null, country: null }],
    ["coordinates", { city: "Lyon", region: null, country: null, latitude: 1 }]
  ])("rejects a location with %s", async (_label, location) => {
    startNativeHostFake({ get_location: () => location })

    await expect(getLocation()).rejects.toMatchObject({ name: "ZodError" })
  })
})

describe("listTools", () => {
  it("returns the listed tool definitions in the desktop's order", async () => {
    const tools = [
      buildToolDefinition("search_files"),
      buildToolDefinition("read_text_file")
    ]
    const host = startNativeHostFake({ list_tools: () => tools })

    await expect(listTools()).resolves.toEqual(tools)
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "list_tools"
    ])
  })

  it.each([
    [
      "names a tool twice",
      [
        buildToolDefinition("read_text_file"),
        buildToolDefinition("read_text_file")
      ]
    ],
    [
      "holds a tool the backend runs",
      [
        buildToolDefinition("read_text_file"),
        buildBackendToolDefinition("read_page")
      ]
    ],
    ["holds a tool without a valid name", [{ name: "bad name!" }]]
  ])(
    "rejects a list that %s with a caller-safe error, keeping the decoding failure as its cause",
    async (_label, tools) => {
      startNativeHostFake({ list_tools: () => tools })

      await expect(listTools()).rejects.toMatchObject({
        message: "The app returned an invalid tool list.",
        cause: expect.objectContaining({ name: "ZodError" })
      })
    }
  )

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      list_tools: () => Promise.reject("command list_tools not found")
    })

    await expect(listTools()).rejects.toBe("command list_tools not found")
  })
})
