import type { McpServerName } from "@lys/share"
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client"
import type { McpToolListPage } from "./mcpServerConnection"
import McpToolCatalogBuilder, { type McpToolCatalog } from "./mcpToolCatalog"

/**
 * Most pages of a server's tool list the backend reads; a list that names
 * a later page fails the opening.
 */
export const MAXIMUM_TOOL_LIST_PAGES = 16

/**
 * Gets a server's tool catalog by asking for its tool list page by page.
 *
 * @param serverName - Name of the server.
 * @param getPage - Gets the page a cursor names, or the first page for
 * undefined; borrowed for the call.
 * @returns The catalog of the tools read. Reading stops at the end of the
 * list; at the first tool past the ones the catalog holds, which marks the
 * list as cut; or, as the SDK's own list read stops, at a page that names
 * the cursor it was asked with and holds the same tools as the page before,
 * whose tools are then left out as the server repeating itself.
 * @throws What `getPage` throws; the SDK's invalid-result error for a tool
 * the SDK's MCP tool schema refuses; or the SDK's pagination error when
 * page {@link MAXIMUM_TOOL_LIST_PAGES} names a next page, as the SDK's own
 * list read would, unless a tool past the ones the catalog holds came
 * first.
 * @remarks The memory the read holds is one page, at most the response
 * limit, the names of the page before, and the catalog: each page's tools
 * are turned into catalog entries before the next page is asked for, and
 * the server's objects are not kept. Two pages hold the same tools when
 * they hold as many tools with the same names in the same order; their
 * schemas are not compared, because comparing them would walk two untrusted
 * pages.
 */
export async function getMcpToolCatalog(
  serverName: McpServerName,
  getPage: (cursor: string | undefined) => Promise<McpToolListPage>
): Promise<McpToolCatalog> {
  const builder = new McpToolCatalogBuilder(serverName)
  let cursor: string | undefined = undefined
  let previousNames: readonly unknown[] = []
  for (let pageCount = 1; ; pageCount += 1) {
    const page = await getPage(cursor)
    const names = page.tools.map((rawTool) => findToolName(rawTool))
    if (isRepeatedPage(cursor, page, names, previousNames))
      return builder.build()
    for (const rawTool of page.tools) {
      builder.addTool(rawTool)
      if (builder.isToolListCut) return builder.build()
    }
    if (page.nextCursor === undefined) return builder.build()
    if (pageCount >= MAXIMUM_TOOL_LIST_PAGES)
      throw new SdkError(
        SdkErrorCode.ListPaginationExceeded,
        `tools/list: the list names a page after page ${MAXIMUM_TOOL_LIST_PAGES}, the last the backend reads.`
      )
    cursor = page.nextCursor
    previousNames = names
  }
}

/**
 * Answers whether a page repeats the page before it, as the SDK's own list
 * read tells.
 *
 * @param cursor - Cursor the page was asked for with; undefined for the
 * first page.
 * @param page - The page.
 * @param names - Name of each of the page's tools, as
 * {@link findToolName} finds it.
 * @param previousNames - The same for the page before.
 * @returns True when the page was asked for with a cursor, names that
 * cursor as its next one, and holds as many tools with the same names in
 * the same order as the page before.
 */
function isRepeatedPage(
  cursor: string | undefined,
  page: McpToolListPage,
  names: readonly unknown[],
  previousNames: readonly unknown[]
): boolean {
  return (
    cursor !== undefined &&
    page.nextCursor === cursor &&
    names.length === previousNames.length &&
    names.every((name, index) => name === previousNames[index])
  )
}

/**
 * Finds the name a listed tool gives itself.
 *
 * @param rawTool - Untrusted tool the server listed.
 * @returns Its `name` field, whatever its type, or undefined when the tool
 * is not an object or has none.
 */
function findToolName(rawTool: unknown): unknown {
  return typeof rawTool === "object" && rawTool !== null && "name" in rawTool
    ? rawTool.name
    : undefined
}
