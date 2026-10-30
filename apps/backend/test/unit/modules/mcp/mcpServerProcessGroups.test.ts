import { spawn } from "node:child_process"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import McpServerProcess from "../../../../src/modules/mcp/mcpServerProcess"
import McpServerProcessGroups, {
  hasProcessGroup,
  sendProcessGroupSignal,
  waitForProcessGroupEnd
} from "../../../../src/modules/mcp/mcpServerProcessGroups"
import {
  buildFakeLauncherServerSettings,
  findReportedProcessId,
  isProcessRunning
} from "../../support/mcpTestServers"

/** Longest a test waits for a killed process to be gone. */
const PROCESS_END_WAIT = Object.freeze({ timeout: 5000 })

/**
 * Starts a process in a group of its own that runs until a signal ends it,
 * and kills its group when the current test finishes.
 *
 * @returns The group's identifier, its leader's pid.
 */
async function startProcessGroup(): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 60000)"],
    { detached: true, stdio: "ignore" }
  )
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  const groupId = child.pid ?? Number.NaN
  onTestFinished(() => sendProcessGroupSignal(groupId, "SIGKILL"))
  return groupId
}

describe("McpServerProcessGroups", () => {
  it("sends SIGKILL to every group it holds and forgets them", async () => {
    const groups = new McpServerProcessGroups()
    const first = await startProcessGroup()
    const second = await startProcessGroup()
    groups.add(first)
    groups.add(second)

    const failures = groups.stopEveryGroup()

    expect(failures).toEqual([])
    await vi.waitFor(() => {
      expect(hasProcessGroup(first)).toBe(false)
      expect(hasProcessGroup(second)).toBe(false)
    }, PROCESS_END_WAIT)
    expect(groups.stopEveryGroup()).toEqual([])
  })

  it("leaves a group it no longer holds running", async () => {
    const groups = new McpServerProcessGroups()
    const groupId = await startProcessGroup()
    groups.add(groupId)
    groups.remove(groupId)

    groups.stopEveryGroup()

    expect(await waitForProcessGroupEnd(groupId, 100)).toBe(false)
  })

  it("skips a group that already ended without a failure", async () => {
    const groups = new McpServerProcessGroups()
    const groupId = await startProcessGroup()
    sendProcessGroupSignal(groupId, "SIGKILL")
    expect(await waitForProcessGroupEnd(groupId, 5000)).toBe(true)
    groups.add(groupId)

    expect(groups.stopEveryGroup()).toEqual([])
  })

  it("ends a running server's whole group, the server its launcher runs included, as the backend's exit does", async () => {
    const groups = new McpServerProcessGroups()
    const logLines: string[] = []
    const settings = buildFakeLauncherServerSettings("fake", {
      ignoreClosedInput: true,
      ignoreSigterm: true,
      reportProcessId: true
    })
    if (settings.transport !== "stdio") throw new Error("Expected stdio")
    const serverProcess = await McpServerProcess.start(
      {
        command: settings.command,
        arguments: settings.arguments,
        environment: Object.fromEntries(
          settings.environment.map((variable) => [
            variable.name,
            variable.value
          ])
        ),
        workingDirectory: process.cwd()
      },
      {
        processGroups: groups,
        reportServerLogLine: (line) => logLines.push(line),
        reportLimitPassed: () => undefined,
        handleMessage: () => undefined,
        handleError: () => undefined,
        handleClose: () => undefined
      }
    )
    onTestFinished(() => serverProcess.stop())
    await vi.waitFor(() => {
      expect(logLines).toContainEqual(expect.stringMatching(/^pid /u))
    }, PROCESS_END_WAIT)
    const serverId = findReportedProcessId(logLines, "pid")

    groups.stopEveryGroup()

    await vi.waitFor(() => {
      expect(isProcessRunning(serverId)).toBe(false)
    }, PROCESS_END_WAIT)
  })
})

describe("waitForProcessGroupEnd", () => {
  it("answers false once its limit passes while the group runs", async () => {
    const groupId = await startProcessGroup()
    const startedAt = performance.now()

    expect(await waitForProcessGroupEnd(groupId, 200)).toBe(false)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150)
  })

  it("answers true soon after the group ends", async () => {
    const groupId = await startProcessGroup()
    const waiting = waitForProcessGroupEnd(groupId, 5000)

    sendProcessGroupSignal(groupId, "SIGKILL")

    expect(await waiting).toBe(true)
  })
})

describe("sendProcessGroupSignal", () => {
  it("does nothing for a group that ended", async () => {
    const groupId = await startProcessGroup()
    sendProcessGroupSignal(groupId, "SIGKILL")
    await waitForProcessGroupEnd(groupId, 5000)

    expect(() => sendProcessGroupSignal(groupId, "SIGTERM")).not.toThrow()
    expect(hasProcessGroup(groupId)).toBe(false)
  })
})
