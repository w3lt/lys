import { SdkErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/client"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import McpServerProcess, {
  MCP_SERVER_STOP_STEP_MILLISECONDS
} from "../../../../src/modules/mcp/mcpServerProcess"
import McpServerProcessGroups from "../../../../src/modules/mcp/mcpServerProcessGroups"
import { findReportedProcessId } from "../../support/mcpTestServers"

/** Longest a test waits for the process to report or to end. */
const PROCESS_WAIT = Object.freeze({ timeout: 5000 })

/** Time limit of a test whose stop runs every step and gives up. */
const FAILED_STOP_TEST = Object.freeze({
  timeout: 3 * MCP_SERVER_STOP_STEP_MILLISECONDS + 5000
})

/** Command of a process that reports its pid and never reads its input. */
const PROCESS_THAT_DOES_NOT_READ = Object.freeze({
  command: process.execPath,
  arguments: [
    "-e",
    "process.stderr.write(`pid ${process.pid}\\n`); setInterval(() => undefined, 60000)"
  ],
  environment: {},
  workingDirectory: process.cwd()
})

/** A notification longer than a pipe holds, so writing it fills the pipe. */
const LONG_NOTIFICATION: JSONRPCMessage = Object.freeze({
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { text: "x".repeat(1024 * 1024) }
})

/**
 * Starts a process that reports its pid on standard error and never reads
 * its standard input.
 *
 * @param processGroups - Holder of the process's group.
 * @returns The process, its pid, and the failures it reported.
 */
async function startProcessThatDoesNotRead(
  processGroups: McpServerProcessGroups = new McpServerProcessGroups()
): Promise<{
  serverProcess: McpServerProcess
  processId: number
  errors: Error[]
}> {
  const logLines: string[] = []
  const errors: Error[] = []
  const serverProcess = await McpServerProcess.start(
    PROCESS_THAT_DOES_NOT_READ,
    {
      processGroups,
      reportServerLogLine: (line) => logLines.push(line),
      reportLimitPassed: () => undefined,
      handleMessage: () => undefined,
      handleError: (error) => errors.push(error),
      handleClose: () => undefined
    }
  )
  await vi.waitFor(() => {
    expect(logLines).toContainEqual(expect.stringMatching(/^pid /u))
  }, PROCESS_WAIT)
  return {
    serverProcess,
    processId: findReportedProcessId(logLines, "pid"),
    errors
  }
}

/**
 * Starts a process as {@link startProcessThatDoesNotRead} does, and stops
 * it when the current test finishes.
 *
 * @returns The process, its pid, and the failures it reported.
 */
async function startStoppedProcessThatDoesNotRead(): ReturnType<
  typeof startProcessThatDoesNotRead
> {
  const started = await startProcessThatDoesNotRead()
  onTestFinished(() => started.serverProcess.stop())
  return started
}

describe("McpServerProcess", () => {
  it("refuses a message once its stop started", async () => {
    const { serverProcess } = await startStoppedProcessThatDoesNotRead()

    void serverProcess.stop()

    await expect(
      serverProcess.send({ jsonrpc: "2.0", method: "notifications/ping" })
    ).rejects.toMatchObject({ code: SdkErrorCode.NotConnected })
  })

  it("fails a message waiting for a full pipe once the pipe closes", async () => {
    const { serverProcess, processId } =
      await startStoppedProcessThatDoesNotRead()
    const sending = serverProcess.send(LONG_NOTIFICATION)

    process.kill(processId, "SIGKILL")

    await expect(sending).rejects.toMatchObject({
      code: SdkErrorCode.NotConnected
    })
  })

  it(
    "stops holding a group that outlived SIGKILL, so the backend's exit does not signal its identifier again",
    FAILED_STOP_TEST,
    async () => {
      const processGroups = new McpServerProcessGroups()
      const { serverProcess, processId } =
        await startProcessThatDoesNotRead(processGroups)
      const sendSignal = process.kill.bind(process)
      onTestFinished(() => {
        vi.restoreAllMocks()
        sendSignal(-processId, "SIGKILL")
      })
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((target, signal) =>
          target === -processId ? true : sendSignal(target, signal)
        )

      await expect(serverProcess.stop()).rejects.toThrow(
        "still running 2000 ms after SIGKILL"
      )
      killSpy.mockClear()
      processGroups.stopEveryGroup()

      expect(killSpy).not.toHaveBeenCalledWith(-processId, "SIGKILL")
    }
  )
})
