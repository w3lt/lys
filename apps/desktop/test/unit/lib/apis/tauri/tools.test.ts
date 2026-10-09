import { describe, expect, it } from "vitest"
import { findFiles, listTools, readTextFile } from "@/lib/apis/tauri/tools"
import { startNativeHostFake } from "../../../support/nativeHostFake"
import { buildToolDefinition } from "../../../support/toolFixtures"

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

  it("rejects a list that names a tool twice", async () => {
    const tool = buildToolDefinition("read_text_file")
    startNativeHostFake({ list_tools: () => [tool, tool] })

    await expect(listTools()).rejects.toMatchObject({ name: "ZodError" })
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      list_tools: () => Promise.reject("command list_tools not found")
    })

    await expect(listTools()).rejects.toBe("command list_tools not found")
  })
})
