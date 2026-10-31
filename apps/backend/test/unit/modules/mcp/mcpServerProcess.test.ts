import { SdkErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/client"
import { readFileSync } from "node:fs"
import { setTimeout as waitFor } from "node:timers/promises"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import McpServerProcess, {
  MCP_SERVER_STOP_STEP_MILLISECONDS,
  type McpServerCommand
} from "../../../../src/modules/mcp/mcpServerProcess"
import type McpServerProcessGroups from "../../../../src/modules/mcp/mcpServerProcessGroups"
import { createOwnedMcpServerProcessGroups } from "../../support/mcpServerProcessGroups"
import {
  findReportedProcessId,
  isProcessRunning
} from "../../support/mcpTestServers"

/** Longest a test waits for the process to report or to end. */
const PROCESS_WAIT = Object.freeze({ timeout: 5000 })

/** Time limit of a test whose stop runs every step and gives up. */
const FAILED_STOP_TEST = Object.freeze({
  timeout: 3 * MCP_SERVER_STOP_STEP_MILLISECONDS + 5000
})

/** How long a test watches for lines that must no longer arrive. */
const QUIET_MILLISECONDS = 300

/** Command of a process that reports its pid and never reads its input. */
const PROCESS_THAT_DOES_NOT_READ: McpServerCommand = Object.freeze({
  command: process.execPath,
  arguments: [
    "-e",
    "process.stderr.write(`pid ${process.pid}\\n`); setInterval(() => undefined, 60000)"
  ],
  environment: {},
  workingDirectory: process.cwd()
})

/**
 * Command of a process that reports its pid, reads and drops its input, and
 * exits once its input closes.
 */
const PROCESS_THAT_ENDS_WITH_ITS_INPUT: McpServerCommand = Object.freeze({
  command: process.execPath,
  arguments: [
    "-e",
    'process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); process.stderr.write(`pid ${process.pid}\\n`)'
  ],
  environment: {},
  workingDirectory: process.cwd()
})

/**
 * Code of a helper that writes `helper line` to standard error every 50 ms
 * until it is killed, whether or not anything still reads the pipe.
 */
const ESCAPED_HELPER_CODE =
  'process.stderr.on("error", () => undefined); setInterval(() => process.stderr.write("helper line\\n"), 50)'

/**
 * Command of a launcher that starts {@link ESCAPED_HELPER_CODE} in a session
 * of its own, so the helper leaves the launcher's group but keeps its
 * standard error, reports `pid <id>` and `helper pid <id>`, and exits once
 * its input closes.
 */
const LAUNCHER_WITH_ESCAPED_HELPER: McpServerCommand = Object.freeze({
  command: process.execPath,
  arguments: [
    "-e",
    [
      'const { spawn } = require("node:child_process")',
      `const helper = spawn(process.execPath, ["-e", ${JSON.stringify(ESCAPED_HELPER_CODE)}], { detached: true, stdio: ["ignore", "ignore", "inherit"] })`,
      "helper.unref()",
      "process.stderr.write(`pid ${process.pid}\\nhelper pid ${helper.pid}\\n`)",
      'process.stdin.on("end", () => process.exit(0))',
      "process.stdin.resume()"
    ].join("\n")
  ],
  environment: {},
  workingDirectory: process.cwd()
})

/**
 * Command of a process that writes, as one `env` line on standard error, the
 * variables `HOME`, `LYS_TEST_VALUE`, and `PATH` it was started with, then
 * reports its pid and exits once its input closes; its settings set `HOME`
 * and `LYS_TEST_VALUE`, and leave `PATH` to the SDK's default environment.
 */
const PROCESS_THAT_REPORTS_ITS_ENVIRONMENT: McpServerCommand = Object.freeze({
  command: process.execPath,
  arguments: [
    "-e",
    'const { HOME, LYS_TEST_VALUE, PATH } = process.env; process.stderr.write(`env ${HOME} ${LYS_TEST_VALUE} ${PATH}\\n`); process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); process.stderr.write(`pid ${process.pid}\\n`)'
  ],
  environment: Object.freeze({
    HOME: "/lys-test-home",
    LYS_TEST_VALUE: "configured"
  }),
  workingDirectory: process.cwd()
})

/** A notification longer than a pipe holds, so writing it fills the pipe. */
const LONG_NOTIFICATION: JSONRPCMessage = Object.freeze({
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { text: "x".repeat(1024 * 1024) }
})

/** A started process with what it reported. */
type StartedProcess = {
  /** The process. */
  serverProcess: McpServerProcess
  /** Its pid, which it reported as `pid <id>`. */
  processId: number
  /** Lines it wrote to standard error, in order. */
  logLines: string[]
  /** Failures it reported. */
  errors: Error[]
  /** How many times it reported its close. */
  closes: () => number
}

/**
 * Starts a process that reports its pid on standard error, and waits for
 * that line.
 *
 * @param command - The process's command.
 * @param processGroups - Holder of the process's group.
 * @returns The process and what it reported.
 */
async function startReportingProcess(
  command: McpServerCommand,
  processGroups: McpServerProcessGroups
): Promise<StartedProcess> {
  const logLines: string[] = []
  const errors: Error[] = []
  let closeCount = 0
  const serverProcess = await McpServerProcess.start(command, {
    processGroups,
    reportServerLogLine: (line) => logLines.push(line),
    reportLimitPassed: () => undefined,
    handleMessage: () => undefined,
    handleError: (error) => errors.push(error),
    handleClose: () => {
      closeCount += 1
    }
  })
  await vi.waitFor(() => {
    expect(logLines).toContainEqual(expect.stringMatching(/^pid /u))
  }, PROCESS_WAIT)
  const processId = findReportedProcessId(logLines, "pid")
  return {
    serverProcess,
    processId,
    logLines,
    errors,
    closes: () => closeCount
  }
}

/**
 * Starts a process as {@link startReportingProcess} does, with a holder of
 * its group the current test owns, and stops it when the test finishes.
 *
 * @param command - The process's command.
 * @returns The process and what it reported.
 */
async function startStoppedReportingProcess(
  command: McpServerCommand
): Promise<StartedProcess> {
  const { processGroups } = createOwnedMcpServerProcessGroups()
  const started = await startReportingProcess(command, processGroups)
  onTestFinished(() => started.serverProcess.stop())
  return started
}

describe("McpServerProcess", () => {
  it("starts its command with the SDK's default variables, each configured variable in place of a default one of the same name", async () => {
    const { logLines } = await startStoppedReportingProcess(
      PROCESS_THAT_REPORTS_ITS_ENVIRONMENT
    )

    expect(logLines).toContain(
      `env /lys-test-home configured ${process.env.PATH}`
    )
  })

  it("refuses a message once its stop started", async () => {
    const { serverProcess } = await startStoppedReportingProcess(
      PROCESS_THAT_DOES_NOT_READ
    )

    void serverProcess.stop()

    await expect(
      serverProcess.send({ jsonrpc: "2.0", method: "notifications/ping" })
    ).rejects.toMatchObject({ code: SdkErrorCode.NotConnected })
  })

  it("settles a message that filled the pipe once the server read it", async () => {
    const { serverProcess } = await startStoppedReportingProcess(
      PROCESS_THAT_ENDS_WITH_ITS_INPUT
    )

    await expect(serverProcess.send(LONG_NOTIFICATION)).resolves.toBeUndefined()
  })

  it("fails a message waiting for a full pipe once the pipe closes", async () => {
    const { serverProcess, processId } = await startStoppedReportingProcess(
      PROCESS_THAT_DOES_NOT_READ
    )
    const sending = serverProcess.send(LONG_NOTIFICATION)

    process.kill(processId, "SIGKILL")

    await expect(sending).rejects.toMatchObject({
      code: SdkErrorCode.NotConnected
    })
  })

  it("stops holding a group that ended, so the backend's exit does not signal its identifier", async () => {
    const { processGroups, filePath } = createOwnedMcpServerProcessGroups()
    const { serverProcess, processId } = await startReportingProcess(
      PROCESS_THAT_ENDS_WITH_ITS_INPUT,
      processGroups
    )
    expect(readFileSync(filePath, "utf8")).toBe(`${processId}\n`)

    await serverProcess.stop()
    const killSpy = vi.spyOn(process, "kill")
    processGroups.stopEveryGroup()

    expect(readFileSync(filePath, "utf8")).toBe("")
    expect(killSpy).not.toHaveBeenCalledWith(-processId, "SIGKILL")
  })

  it("closes its pipes once its group ended, so a process that left the group reports nothing more, and reports its close", async () => {
    const { serverProcess, logLines, closes } =
      await startStoppedReportingProcess(LAUNCHER_WITH_ESCAPED_HELPER)
    await vi.waitFor(() => {
      expect(logLines).toContain("helper line")
    }, PROCESS_WAIT)
    const helperId = findReportedProcessId(logLines, "helper pid")
    onTestFinished(() => {
      if (isProcessRunning(helperId)) process.kill(helperId, "SIGKILL")
    })

    await serverProcess.stop()
    const lineCount = logLines.length
    await waitFor(QUIET_MILLISECONDS)

    expect(logLines).toHaveLength(lineCount)
    expect(isProcessRunning(helperId)).toBe(true)
    expect(closes()).toBe(1)
  })

  it(
    "stops holding a group that outlived SIGKILL, so the backend's exit does not signal its identifier again",
    FAILED_STOP_TEST,
    async () => {
      const { processGroups } = createOwnedMcpServerProcessGroups()
      const { serverProcess, processId } = await startReportingProcess(
        PROCESS_THAT_DOES_NOT_READ,
        processGroups
      )
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
