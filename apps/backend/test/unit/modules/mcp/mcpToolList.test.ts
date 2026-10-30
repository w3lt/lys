import { SdkErrorCode } from "@modelcontextprotocol/client"
import { describe, expect, it, vi } from "vitest"
import type { McpToolListPage } from "../../../../src/modules/mcp/mcpServerConnection"
import {
  MAXIMUM_TOOL_LIST_PAGES,
  getMcpToolCatalog
} from "../../../../src/modules/mcp/mcpToolList"

/** Server the catalogs are read for; its tools are named `mcp__notes__…`. */
const SERVER_NAME = "notes"

/**
 * Builds tools without arguments.
 *
 * @param first - Number in the first tool's name, `tool<first>`.
 * @param count - How many tools, numbered on from the first.
 * @returns The untrusted tools.
 */
function buildTools(first: number, count: number): unknown[] {
  return Array.from({ length: count }, (_tool, index) => ({
    name: `tool${String(first + index)}`,
    inputSchema: { type: "object" }
  }))
}

/**
 * Builds a page getter that answers from fixed pages, by cursor.
 *
 * @param pages - Each page by the cursor that names it; the empty key for
 * the first page.
 * @returns The getter, which records each cursor it was asked with.
 */
function createPageGetter(
  pages: Readonly<Record<string, McpToolListPage>>
): ReturnType<
  typeof vi.fn<(cursor: string | undefined) => Promise<McpToolListPage>>
> {
  return vi.fn((cursor: string | undefined) => {
    const page = pages[cursor ?? ""]
    return page === undefined
      ? Promise.reject(new Error(`No page ${String(cursor)}`))
      : Promise.resolve(page)
  })
}

/**
 * Builds pages that each hold one tool and name the next page, numbered
 * from 1, the first page under the empty key.
 *
 * @param pageCount - Pages to build.
 * @param lastNextCursor - Cursor the last page names, undefined for none.
 * @returns The pages.
 */
function buildOneToolPages(
  pageCount: number,
  lastNextCursor: string | undefined
): Record<string, McpToolListPage> {
  const pages: Record<string, McpToolListPage> = {}
  for (let page = 1; page <= pageCount; page += 1)
    pages[page === 1 ? "" : String(page)] = {
      tools: buildTools(page, 1),
      nextCursor: page < pageCount ? String(page + 1) : lastNextCursor
    }
  return pages
}

describe("getMcpToolCatalog", () => {
  it("reads every page in order, asking each with the cursor the page before named", async () => {
    const getPage = createPageGetter({
      "": { tools: buildTools(1, 2), nextCursor: "b" },
      b: { tools: [], nextCursor: "c" },
      c: { tools: buildTools(3, 1), nextCursor: undefined }
    })

    const catalog = await getMcpToolCatalog(SERVER_NAME, getPage)

    expect(getPage.mock.calls).toEqual([[undefined], ["b"], ["c"]])
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__tool1",
      "mcp__notes__tool2",
      "mcp__notes__tool3"
    ])
    expect(catalog.isToolListCut).toBe(false)
  })

  it(`reads a list of ${String(MAXIMUM_TOOL_LIST_PAGES)} pages`, async () => {
    const getPage = createPageGetter(
      buildOneToolPages(MAXIMUM_TOOL_LIST_PAGES, undefined)
    )

    const catalog = await getMcpToolCatalog(SERVER_NAME, getPage)

    expect(catalog.definitions).toHaveLength(MAXIMUM_TOOL_LIST_PAGES)
  })

  it(`fails a list whose page ${String(MAXIMUM_TOOL_LIST_PAGES)} names a next page, without asking for it`, async () => {
    const getPage = createPageGetter(
      buildOneToolPages(MAXIMUM_TOOL_LIST_PAGES, "more")
    )

    await expect(getMcpToolCatalog(SERVER_NAME, getPage)).rejects.toMatchObject(
      { code: SdkErrorCode.ListPaginationExceeded }
    )
    expect(getPage).toHaveBeenCalledTimes(MAXIMUM_TOOL_LIST_PAGES)
  })

  it("stops at the first tool past the 128 it keeps, without asking for the next page", async () => {
    const getPage = createPageGetter({
      "": { tools: buildTools(1, 100), nextCursor: "b" },
      b: { tools: [...buildTools(101, 28), "not a tool"], nextCursor: "c" }
    })

    const catalog = await getMcpToolCatalog(SERVER_NAME, getPage)

    expect(getPage).toHaveBeenCalledTimes(2)
    expect(catalog.definitions).toHaveLength(128)
    expect(catalog.isToolListCut).toBe(true)
  })

  it("ends the list at a page that names the cursor it was asked with and holds the tools of the page before, leaving out its tools", async () => {
    const getPage = createPageGetter({
      "": { tools: buildTools(1, 2), nextCursor: "same" },
      same: { tools: buildTools(1, 2), nextCursor: "same" }
    })

    const catalog = await getMcpToolCatalog(SERVER_NAME, getPage)

    expect(getPage.mock.calls).toEqual([[undefined], ["same"]])
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__tool1",
      "mcp__notes__tool2"
    ])
    expect(catalog.skippedTools).toEqual([])
  })

  it("keeps the tools of a page that names the cursor it was asked with but holds other tools, and asks for it again", async () => {
    const pages: McpToolListPage[] = [
      { tools: buildTools(1, 1), nextCursor: "same" },
      { tools: buildTools(2, 1), nextCursor: "same" },
      { tools: buildTools(3, 1), nextCursor: "same" },
      { tools: buildTools(3, 1), nextCursor: "same" }
    ]
    const remainingPages = [...pages]
    const getPage = vi.fn<
      (cursor: string | undefined) => Promise<McpToolListPage>
    >(() => {
      const page = remainingPages.shift()
      return page === undefined
        ? Promise.reject(new Error("No page left"))
        : Promise.resolve(page)
    })

    const catalog = await getMcpToolCatalog(SERVER_NAME, getPage)

    expect(getPage).toHaveBeenCalledTimes(4)
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__tool1",
      "mcp__notes__tool2",
      "mcp__notes__tool3"
    ])
  })

  it("does not take a page with as many tools under other names for a repeat", async () => {
    const getPage = createPageGetter({
      "": { tools: buildTools(1, 1), nextCursor: "same" },
      same: {
        tools: [{ name: "other", inputSchema: { type: "object" } }],
        nextCursor: "same"
      }
    })

    const catalog = await getMcpToolCatalog(SERVER_NAME, getPage)

    expect(getPage).toHaveBeenCalledTimes(3)
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__tool1",
      "mcp__notes__other"
    ])
  })

  it("fails a list holding a tool the MCP tool schema refuses", async () => {
    const getPage = createPageGetter({
      "": { tools: [{ name: "bare" }], nextCursor: undefined }
    })

    await expect(getMcpToolCatalog(SERVER_NAME, getPage)).rejects.toMatchObject(
      { code: SdkErrorCode.InvalidResult }
    )
  })

  it("fails as its page reader fails", async () => {
    const failure = new Error("gone")

    await expect(
      getMcpToolCatalog(SERVER_NAME, () => Promise.reject(failure))
    ).rejects.toBe(failure)
  })
})
