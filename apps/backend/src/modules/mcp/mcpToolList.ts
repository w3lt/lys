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
 * Reads a server's tool list page by page and builds its catalog.
 *
 * @param serverName - Name of the server.
 * @param readPage - Reads the page a cursor names, or the first page for
 * undefined; borrowed for the read.
 * @returns The catalog of the tools read. Reading stops at the end of the
 * list, at a page whose next cursor is the cursor it was asked with, whose
 * tools are left out as the server repeating itself, or at the first tool
 * past the ones the catalog holds, which marks the list as cut.
 * @throws What `readPage` throws; the SDK's invalid-result error for a tool
 * the MCP tool schema refuses; or the SDK's pagination error when page
 * {@link MAXIMUM_TOOL_LIST_PAGES} names a next page, as the SDK's own list
 * read would, unless a tool past the ones the catalog holds came first.
 * @remarks The memory the read holds is one page, at most the response
 * limit, and the catalog: each page's tools are turned into catalog entries
 * before the next page is asked for, and the server's objects are not kept.
 */
export async function readMcpToolCatalog(
  serverName: McpServerName,
  readPage: (cursor: string | undefined) => Promise<McpToolListPage>
): Promise<McpToolCatalog> {
  const builder = new McpToolCatalogBuilder(serverName)
  let cursor: string | undefined = undefined
  for (let pageCount = 1; ; pageCount += 1) {
    const page = await readPage(cursor)
    if (cursor !== undefined && page.nextCursor === cursor)
      return builder.build()
    for (const rawTool of page.tools) {
      await builder.addTool(rawTool)
      if (builder.isToolListCut) return builder.build()
    }
    if (page.nextCursor === undefined) return builder.build()
    if (pageCount >= MAXIMUM_TOOL_LIST_PAGES)
      throw new SdkError(
        SdkErrorCode.ListPaginationExceeded,
        `tools/list: the list names a page after page ${MAXIMUM_TOOL_LIST_PAGES}, the last the backend reads.`
      )
    cursor = page.nextCursor
  }
}
