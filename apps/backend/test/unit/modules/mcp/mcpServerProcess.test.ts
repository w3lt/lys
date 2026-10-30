import { SdkErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/client"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import McpServerProcess from "../../../../src/modules/mcp/mcpServerProcess"
import McpServerProcessGroups from "../../../../src/modules/mcp/mcpServerProcessGroups"
import { findReportedProcessId } from "../../support/mcpTestServers"

/** Longest a test waits for the process to report or to end. */
const PROCESS_WAIT = Object.freeze({ timeout: 5000 })

/** A notification longer than a pipe holds, so writing it fills the pipe. */
const LONG_NOTIFICATION: JSONRPCMessage = Object.freeze({
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { text: "x".repeat(1024 * 1024) }
})

/**
 * Starts a process that reports its pid on standard error and never reads
 * its standard input, and stops it when the current test finishes.
 *
 * @returns The process, its pid, and the failures it reported.
 */
async function startProcessThatDoesNotRead(): Promise<{
  serverProcess: McpServerProcess
  processId: number
  errors: Error[]
}> {
  const logLines: string[] = []
  const errors: Error[] = []
  const serverProcess = await McpServerProcess.start(
    {
      command: process.execPath,
      arguments: [
        "-e",
        "process.stderr.write(`pid ${process.pid}\\n`); setInterval(() => undefined, 60000)"
      ],
      environment: {},
      workingDirectory: process.cwd()
    },
    {
      processGroups: new McpServerProcessGroups(),
      reportServerLogLine: (line) => logLines.push(line),
      reportLimitPassed: () => undefined,
      handleMessage: () => undefined,
      handleError: (error) => errors.push(error),
      handleClose: () => undefined
    }
  )
  onTestFinished(() => serverProcess.stop())
  await vi.waitFor(() => {
    expect(logLines).toContainEqual(expect.stringMatching(/^pid /u))
  }, PROCESS_WAIT)
  return {
    serverProcess,
    processId: findReportedProcessId(logLines, "pid"),
    errors
  }
}

describe("McpServerProcess", () => {
  it("refuses a message once its stop started", async () => {
    const { serverProcess } = await startProcessThatDoesNotRead()

    void serverProcess.stop()

    await expect(
      serverProcess.send({ jsonrpc: "2.0", method: "notifications/ping" })
    ).rejects.toMatchObject({ code: SdkErrorCode.NotConnected })
  })

  it("fails a message waiting for a full pipe once the pipe closes", async () => {
    const { serverProcess, processId } = await startProcessThatDoesNotRead()
    const sending = serverProcess.send(LONG_NOTIFICATION)

    process.kill(processId, "SIGKILL")

    await expect(sending).rejects.toMatchObject({
      code: SdkErrorCode.NotConnected
    })
  })
})
