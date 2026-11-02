import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import McpServerProcess from "../../../../src/modules/mcp/mcpServerProcess"
import McpServerProcessGroups, {
  hasProcessGroup,
  sendProcessGroupSignal,
  waitForProcessGroupEnd
} from "../../../../src/modules/mcp/mcpServerProcessGroups"
import { createOwnedMcpServerProcessGroups } from "../../support/mcpServerProcessGroups"
import {
  buildFakeLauncherServerSettings,
  findReportedProcessId,
  isProcessRunning
} from "../../support/mcpTestServers"

/** Longest a test waits for a killed process to be gone. */
const PROCESS_END_WAIT = Object.freeze({ timeout: 5000 })

/**
 * Identifiers the file cases add and remove without signalling them, so no
 * process needs to have them.
 */
const UNSIGNALLED_GROUP_IDS = Object.freeze([101, 202] as const)

/**
 * Whether the tests run on macOS, whose `kill` answers `EPERM` for a group
 * of unreaped processes.
 */
const IS_MACOS = process.platform === "darwin"

/**
 * Shell command that leaves its process group holding only a process that
 * exited but was not reaped: a background Perl forks a child that exits at
 * once, moves itself to a group of its own, writes `<its pid> <child pid>`,
 * and sleeps without reaping the child, while the shell exits.
 */
const ZOMBIE_ONLY_GROUP_SCRIPT = `perl -e '$| = 1; my $child = fork; if (!$child) { exit 0 } setpgrp(0, 0); print "$$ $child\\n"; sleep 30' &`

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

/**
 * Starts a process group whose only process left exited but was not reaped,
 * as {@link ZOMBIE_ONLY_GROUP_SCRIPT} leaves it, and kills the process that
 * holds that child when the current test finishes, which lets the group end.
 *
 * @returns The group's identifier, once `kill` answers `EPERM` for it.
 */
async function startZombieOnlyGroup(): Promise<number> {
  const shell = spawn("sh", ["-c", ZOMBIE_ONLY_GROUP_SCRIPT], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  })
  const shellExit = once(shell, "exit")
  const [line] = (await once(
    createInterface({ input: shell.stdout }),
    "line"
  )) as [string]
  const [holderId = Number.NaN, childId = Number.NaN] = line
    .split(" ")
    .map(Number)
  onTestFinished(() => {
    if (isProcessRunning(holderId)) process.kill(holderId, "SIGKILL")
  })
  await shellExit
  const groupId = shell.pid ?? Number.NaN
  await vi.waitFor(() => {
    expect(
      execFileSync("ps", ["-o", "stat=", "-p", String(childId)], {
        encoding: "utf8"
      })
    ).toMatch(/^Z/u)
    expect(() => process.kill(-groupId, 0)).toThrow(
      expect.objectContaining({ code: "EPERM" })
    )
  }, PROCESS_END_WAIT)
  return groupId
}

/**
 * Creates a holder whose groups file would be in a folder that does not
 * exist, so every save fails, inside a folder the current test owns.
 *
 * @returns The holder, the file's path, and the failures it reported.
 */
function createHolderThatCannotSave(): {
  groups: McpServerProcessGroups
  filePath: string
  saveFailures: Error[]
} {
  const directory = mkdtempSync(join(tmpdir(), "lys-mcp-process-groups-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, "missing", "mcp-process-groups")
  const saveFailures: Error[] = []
  const groups = new McpServerProcessGroups(filePath, (failure) => {
    saveFailures.push(failure)
  })
  return { groups, filePath, saveFailures }
}

describe("McpServerProcessGroups", () => {
  it("writes no file before it holds a group", () => {
    const { filePath } = createOwnedMcpServerProcessGroups()

    expect(() => statSync(filePath)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    )
  })

  it("saves the groups it holds to its file, one decimal identifier and a line feed each, as they are added and removed", () => {
    const { processGroups: groups, filePath } =
      createOwnedMcpServerProcessGroups()
    const [first, second] = UNSIGNALLED_GROUP_IDS

    groups.add(first)
    expect(readFileSync(filePath, "utf8")).toBe("101\n")
    groups.add(second)
    expect(readFileSync(filePath, "utf8")).toBe("101\n202\n")
    groups.remove(first)
    expect(readFileSync(filePath, "utf8")).toBe("202\n")
    groups.remove(second)
    expect(readFileSync(filePath, "utf8")).toBe("")
  })

  it("replaces its file with a new one at each save, leaving no other file beside it", () => {
    const { processGroups: groups, filePath } =
      createOwnedMcpServerProcessGroups()
    const [first, second] = UNSIGNALLED_GROUP_IDS
    groups.add(first)
    const firstFile = statSync(filePath).ino

    groups.add(second)

    expect(statSync(filePath).ino).not.toBe(firstFile)
    expect(readdirSync(dirname(filePath))).toEqual(["mcp-process-groups"])
  })

  it("saves its file empty once it stopped every group", async () => {
    const { processGroups: groups, filePath } =
      createOwnedMcpServerProcessGroups()
    groups.add(await startProcessGroup())

    groups.stopEveryGroup()

    expect(readFileSync(filePath, "utf8")).toBe("")
  })

  it("keeps holding a group whose save failed, and reports each failure with the file's path", async () => {
    const { groups, filePath, saveFailures } = createHolderThatCannotSave()
    const groupId = await startProcessGroup()

    expect(() => groups.add(groupId)).not.toThrow()
    groups.stopEveryGroup()

    await vi.waitFor(() => {
      expect(hasProcessGroup(groupId)).toBe(false)
    }, PROCESS_END_WAIT)
    expect(saveFailures).toEqual([
      expect.objectContaining({
        message: `The MCP servers' process groups could not be saved to ${filePath}.`,
        cause: expect.objectContaining({ code: "ENOENT" })
      }),
      expect.objectContaining({
        message: `The MCP servers' process groups could not be saved to ${filePath}.`
      })
    ])
  })

  it("forgets a group whose removal could not be saved", async () => {
    const { groups, saveFailures } = createHolderThatCannotSave()
    const groupId = await startProcessGroup()
    groups.add(groupId)

    expect(() => groups.remove(groupId)).not.toThrow()
    groups.stopEveryGroup()

    expect(await waitForProcessGroupEnd(groupId, 100)).toBe(false)
    expect(saveFailures).toHaveLength(3)
  })

  it("sends SIGKILL to every group it holds and forgets them", async () => {
    const { processGroups: groups } = createOwnedMcpServerProcessGroups()
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
    const { processGroups: groups } = createOwnedMcpServerProcessGroups()
    const groupId = await startProcessGroup()
    groups.add(groupId)
    groups.remove(groupId)

    groups.stopEveryGroup()

    expect(await waitForProcessGroupEnd(groupId, 100)).toBe(false)
  })

  it("skips a group that already ended without a failure", async () => {
    const { processGroups: groups } = createOwnedMcpServerProcessGroups()
    const groupId = await startProcessGroup()
    sendProcessGroupSignal(groupId, "SIGKILL")
    expect(await waitForProcessGroupEnd(groupId, 5000)).toBe(true)
    groups.add(groupId)

    expect(groups.stopEveryGroup()).toEqual([])
  })

  it("ends a running server's whole group, the server its launcher runs included, as the backend's exit does", async () => {
    const { processGroups: groups } = createOwnedMcpServerProcessGroups()
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

describe("hasProcessGroup", () => {
  it.runIf(IS_MACOS)(
    "answers true for a group whose only process exited but was not reaped",
    async () => {
      const groupId = await startZombieOnlyGroup()

      expect(hasProcessGroup(groupId)).toBe(true)
    }
  )
})

describe("sendProcessGroupSignal", () => {
  it.runIf(IS_MACOS)(
    "does nothing, without a failure, for a group whose only process exited but was not reaped",
    async () => {
      const groupId = await startZombieOnlyGroup()

      expect(() => sendProcessGroupSignal(groupId, "SIGTERM")).not.toThrow()
    }
  )

  it("does nothing for a group that ended", async () => {
    const groupId = await startProcessGroup()
    sendProcessGroupSignal(groupId, "SIGKILL")
    await waitForProcessGroupEnd(groupId, 5000)

    expect(() => sendProcessGroupSignal(groupId, "SIGTERM")).not.toThrow()
    expect(hasProcessGroup(groupId)).toBe(false)
  })
})
