import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished } from "vitest"
import McpServerProcessGroups from "../../../src/modules/mcp/mcpServerProcessGroups"

/** A holder of MCP server process groups that the current test owns. */
export type OwnedMcpServerProcessGroups = Readonly<{
  /** The holder. */
  processGroups: McpServerProcessGroups
  /** Path of the file it saves the groups it holds to. */
  filePath: string
}>

/**
 * Creates a holder of MCP server process groups whose file is in a
 * temporary folder of its own, for the current test.
 *
 * @returns The holder and its file's path; no file is written until a group
 * is added. When the test finishes, after the cleanups registered later
 * have run, the folder is removed and the test fails if a save failed.
 */
export function createOwnedMcpServerProcessGroups(): OwnedMcpServerProcessGroups {
  const directory = mkdtempSync(join(tmpdir(), "lys-mcp-process-groups-"))
  const saveFailures: Error[] = []
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
    expect(saveFailures).toEqual([])
  })
  const filePath = join(directory, "mcp-process-groups")
  const processGroups = new McpServerProcessGroups(filePath, (failure) => {
    saveFailures.push(failure)
  })
  return { processGroups, filePath }
}
