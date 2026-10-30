import { SdkErrorCode } from "@modelcontextprotocol/client"
import { describe, expect, it, vi } from "vitest"
import type { McpToolListPage } from "../../../../src/modules/mcp/mcpServerConnection"
import {
  MAXIMUM_TOOL_LIST_PAGES,
  readMcpToolCatalog
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
 * Builds a page reader that answers from fixed pages, by cursor.
 *
 * @param pages - Each page by the cursor that names it; the empty key for
 * the first page.
 * @returns The reader, which records each cursor it was asked with.
 */
function createPageReader(
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

describe("readMcpToolCatalog", () => {
  it("reads every page in order, asking each with the cursor the page before named", async () => {
    const readPage = createPageReader({
      "": { tools: buildTools(1, 2), nextCursor: "b" },
      b: { tools: [], nextCursor: "c" },
      c: { tools: buildTools(3, 1), nextCursor: undefined }
    })

    const catalog = await readMcpToolCatalog(SERVER_NAME, readPage)

    expect(readPage.mock.calls).toEqual([[undefined], ["b"], ["c"]])
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__tool1",
      "mcp__notes__tool2",
      "mcp__notes__tool3"
    ])
    expect(catalog.isToolListCut).toBe(false)
  })

  it(`reads a list of ${String(MAXIMUM_TOOL_LIST_PAGES)} pages`, async () => {
    const readPage = createPageReader(
      buildOneToolPages(MAXIMUM_TOOL_LIST_PAGES, undefined)
    )

    const catalog = await readMcpToolCatalog(SERVER_NAME, readPage)

    expect(catalog.definitions).toHaveLength(MAXIMUM_TOOL_LIST_PAGES)
  })

  it(`fails a list whose page ${String(MAXIMUM_TOOL_LIST_PAGES)} names a next page, without asking for it`, async () => {
    const readPage = createPageReader(
      buildOneToolPages(MAXIMUM_TOOL_LIST_PAGES, "more")
    )

    await expect(
      readMcpToolCatalog(SERVER_NAME, readPage)
    ).rejects.toMatchObject({ code: SdkErrorCode.ListPaginationExceeded })
    expect(readPage).toHaveBeenCalledTimes(MAXIMUM_TOOL_LIST_PAGES)
  })

  it("stops at the first tool past the 128 it keeps, without asking for the next page", async () => {
    const readPage = createPageReader({
      "": { tools: buildTools(1, 100), nextCursor: "b" },
      b: { tools: [...buildTools(101, 28), "not a tool"], nextCursor: "c" }
    })

    const catalog = await readMcpToolCatalog(SERVER_NAME, readPage)

    expect(readPage).toHaveBeenCalledTimes(2)
    expect(catalog.definitions).toHaveLength(128)
    expect(catalog.isToolListCut).toBe(true)
  })

  it("ends the list at a page that names the cursor it was asked with, leaving out that page's tools", async () => {
    const readPage = createPageReader({
      "": { tools: buildTools(1, 1), nextCursor: "same" },
      same: { tools: buildTools(2, 1), nextCursor: "same" }
    })

    const catalog = await readMcpToolCatalog(SERVER_NAME, readPage)

    expect(readPage).toHaveBeenCalledTimes(2)
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__tool1"
    ])
  })

  it("fails a list holding a tool the MCP tool schema refuses", async () => {
    const readPage = createPageReader({
      "": { tools: [{ name: "bare" }], nextCursor: undefined }
    })

    await expect(
      readMcpToolCatalog(SERVER_NAME, readPage)
    ).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult })
  })

  it("fails as its page reader fails", async () => {
    const failure = new Error("gone")

    await expect(
      readMcpToolCatalog(SERVER_NAME, () => Promise.reject(failure))
    ).rejects.toBe(failure)
  })
})
