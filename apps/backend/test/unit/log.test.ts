import { EventEmitter } from "node:events"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  BackendLogDestination,
  registerCrashLogging,
  registerOutputFailureListeners
} from "../../src/log"
import { createTestFastify } from "./support/fastifyTestApp"
import { createFailingOutput, createWorkingOutput } from "./support/testOutputs"

/** Failure a write reports on a full disk. */
const DISK_FULL = new Error("ENOSPC: no space left on device, write")

/** Failure a write reports once the reader of a pipe has exited. */
const PIPE_CLOSED = new Error("write EPIPE")

/** Report written when the standard output fails on a full disk. */
const STANDARD_OUTPUT_DISK_FULL_REPORT =
  "The Lys backend could not write to its standard output, so what it writes there is lost while writing fails: ENOSPC: no space left on device, write\n"

/**
 * Waits until Node has run every callback queued so far, so each failure the
 * writes so far report has been emitted and handled.
 *
 * @returns A promise settled on the next turn of the event loop.
 */
function waitForPendingCallbacks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * Creates a Lys home in a temporary directory owned by the current test.
 *
 * @returns The path of its `logs` directory, which does not exist yet. The
 * Lys home is removed when the test finishes.
 */
function createOwnedLogsDirectoryPath(): string {
  const lysHome = mkdtempSync(join(tmpdir(), "lys-log-test-"))
  onTestFinished(() => {
    rmSync(lysHome, { recursive: true, force: true })
  })
  return join(lysHome, "logs")
}

/**
 * Replaces the clock the code under test reads with one stopped at a time,
 * until the current test finishes.
 *
 * @param time - UTC ISO-8601 time the clock shows.
 */
function stopClockAt(time: string): void {
  vi.useFakeTimers({ toFake: ["Date"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date(time))
}

/**
 * Reads the permission bits of a file.
 *
 * @param path - Path of the file.
 * @returns The file's mode without its type bits, such as `0o600`.
 */
function readPermissions(path: string): number {
  return statSync(path).mode & 0o777
}

describe("BackendLogDestination", () => {
  it("writes each line to standard output and appends it to the owner-only file of its UTC day, creating the logs directory", () => {
    // Kiritimati is 14 hours ahead of UTC, so its local date is already the
    // next day: only a file named by the UTC date passes.
    vi.stubEnv("TZ", "Pacific/Kiritimati")
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    stopClockAt("2026-10-21T12:00:00.000Z")
    const logsDirectoryPath = createOwnedLogsDirectoryPath()
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const destination = new BackendLogDestination(
      createWorkingOutput((text) => {
        outputWrites.push(text)
      }),
      createWorkingOutput((text) => {
        errorWrites.push(text)
      }),
      logsDirectoryPath
    )

    destination.write('{"msg":"incoming request"}\n')
    destination.write('{"msg":"request completed"}\n')

    const logFilePath = join(logsDirectoryPath, "backend-2026-10-21.log")
    expect(readdirSync(logsDirectoryPath)).toEqual(["backend-2026-10-21.log"])
    expect(readFileSync(logFilePath, "utf8")).toBe(
      '{"msg":"incoming request"}\n{"msg":"request completed"}\n'
    )
    expect(readPermissions(logFilePath)).toBe(0o600)
    expect(outputWrites).toEqual([
      '{"msg":"incoming request"}\n',
      '{"msg":"request completed"}\n'
    ])
    expect(errorWrites).toEqual([])
  })

  it("moves to the next day's file with the first line after midnight UTC and keeps the earlier day's file", () => {
    stopClockAt("2026-10-21T23:59:59.999Z")
    const logsDirectoryPath = createOwnedLogsDirectoryPath()
    const destination = new BackendLogDestination(
      createWorkingOutput(() => undefined),
      createWorkingOutput(() => undefined),
      logsDirectoryPath
    )

    destination.write('{"msg":"before midnight"}\n')
    vi.setSystemTime(new Date("2026-10-22T00:00:00.000Z"))
    destination.write('{"msg":"after midnight"}\n')

    expect(readdirSync(logsDirectoryPath).sort()).toEqual([
      "backend-2026-10-21.log",
      "backend-2026-10-22.log"
    ])
    expect(
      readFileSync(join(logsDirectoryPath, "backend-2026-10-21.log"), "utf8")
    ).toBe('{"msg":"before midnight"}\n')
    expect(
      readFileSync(join(logsDirectoryPath, "backend-2026-10-22.log"), "utf8")
    ).toBe('{"msg":"after midnight"}\n')
  })

  it("appends to the day's file of an earlier run and keeps its permissions", () => {
    stopClockAt("2026-10-21T08:15:02.123Z")
    const logsDirectoryPath = createOwnedLogsDirectoryPath()
    const logFilePath = join(logsDirectoryPath, "backend-2026-10-21.log")
    mkdirSync(logsDirectoryPath)
    writeFileSync(logFilePath, '{"msg":"earlier run"}\n', { mode: 0o644 })
    const destination = new BackendLogDestination(
      createWorkingOutput(() => undefined),
      createWorkingOutput(() => undefined),
      logsDirectoryPath
    )

    destination.write('{"msg":"this run"}\n')

    expect(readFileSync(logFilePath, "utf8")).toBe(
      '{"msg":"earlier run"}\n{"msg":"this run"}\n'
    )
    expect(readPermissions(logFilePath)).toBe(0o644)
  })

  it("keeps writing to standard output when lines cannot be appended, reports only the first failure, and appends again once writing works", () => {
    stopClockAt("2026-10-21T08:15:02.123Z")
    const logsDirectoryPath = createOwnedLogsDirectoryPath()
    // A file where the logs directory belongs makes every append fail.
    writeFileSync(logsDirectoryPath, "not a directory")
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const destination = new BackendLogDestination(
      createWorkingOutput((text) => {
        outputWrites.push(text)
      }),
      createWorkingOutput((text) => {
        errorWrites.push(text)
      }),
      logsDirectoryPath
    )

    destination.write('{"msg":"incoming request"}\n')
    destination.write('{"msg":"request completed"}\n')
    rmSync(logsDirectoryPath)
    destination.write('{"msg":"after the fix"}\n')

    expect(outputWrites).toEqual([
      '{"msg":"incoming request"}\n',
      '{"msg":"request completed"}\n',
      '{"msg":"after the fix"}\n'
    ])
    expect(errorWrites).toEqual([
      expect.stringMatching(
        /^The Lys backend could not write to its log file, so what it writes there is lost while writing fails: E[A-Z]+: .+\n$/
      )
    ])
    expect(
      readFileSync(join(logsDirectoryPath, "backend-2026-10-21.log"), "utf8")
    ).toBe('{"msg":"after the fix"}\n')
  })

  it("never creates a missing Lys home, and reports that its lines cannot be appended", () => {
    stopClockAt("2026-10-21T08:15:02.123Z")
    const lysHome = join(dirname(createOwnedLogsDirectoryPath()), "missing")
    const errorWrites: string[] = []
    const destination = new BackendLogDestination(
      createWorkingOutput(() => undefined),
      createWorkingOutput((text) => {
        errorWrites.push(text)
      }),
      join(lysHome, "logs")
    )

    destination.write('{"msg":"incoming request"}\n')

    expect(existsSync(lysHome)).toBe(false)
    expect(errorWrites).toEqual([
      expect.stringMatching(
        /^The Lys backend could not write to its log file, so what it writes there is lost while writing fails: ENOENT: .+\n$/
      )
    ])
  })
})

describe("registerCrashLogging", () => {
  it("logs a failure nothing caught at level fatal with the failure and its origin", () => {
    const backendProcess = new EventEmitter()
    const { app, log } = createTestFastify()
    registerCrashLogging(backendProcess, app.log)

    backendProcess.emit(
      "uncaughtExceptionMonitor",
      new Error("listen EADDRINUSE: address already in use 127.0.0.1:12345"),
      "unhandledRejection"
    )

    expect(log.records).toEqual([
      expect.objectContaining({
        level: "fatal",
        msg: "The Lys backend is stopping on a failure nothing caught",
        origin: "unhandledRejection",
        err: expect.objectContaining({
          type: "Error",
          message: "listen EADDRINUSE: address already in use 127.0.0.1:12345"
        })
      })
    ])
  })

  it("logs a thrown value that is not an Error as it is", () => {
    const backendProcess = new EventEmitter()
    const { app, log } = createTestFastify()
    registerCrashLogging(backendProcess, app.log)

    backendProcess.emit(
      "uncaughtExceptionMonitor",
      "a thrown string",
      "uncaughtException"
    )

    expect(log.records).toEqual([
      expect.objectContaining({
        level: "fatal",
        origin: "uncaughtException",
        err: "a thrown string"
      })
    ])
  })
})

describe("registerOutputFailureListeners", () => {
  it("reports the first failure of the standard output on standard error and keeps writing to it", async () => {
    // Without a listener, Node would end the process at the first failure.
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createFailingOutput(DISK_FULL, (text) => {
      outputWrites.push(text)
    })
    const standardError = createWorkingOutput((text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)

    standardOutput.write('{"msg":"incoming request"}\n')
    await waitForPendingCallbacks()
    standardOutput.write('{"msg":"request completed"}\n')
    await waitForPendingCallbacks()

    expect(outputWrites).toEqual([
      '{"msg":"incoming request"}\n',
      '{"msg":"request completed"}\n'
    ])
    expect(errorWrites).toEqual([STANDARD_OUTPUT_DISK_FULL_REPORT])
  })

  it("reports the first failure of standard error on the standard output", async () => {
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createWorkingOutput((text) => {
      outputWrites.push(text)
    })
    const standardError = createFailingOutput(PIPE_CLOSED, (text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)

    standardError.write("Warning: something Node reports\n")
    await waitForPendingCallbacks()
    standardError.write("Warning: something else\n")
    await waitForPendingCallbacks()

    expect(errorWrites).toEqual([
      "Warning: something Node reports\n",
      "Warning: something else\n"
    ])
    expect(outputWrites).toEqual([
      "The Lys backend could not write to its standard error, so what it writes there is lost while writing fails: write EPIPE\n"
    ])
  })

  it("reports each output's first failure once when both fail, instead of reporting back and forth", async () => {
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createFailingOutput(DISK_FULL, (text) => {
      outputWrites.push(text)
    })
    const standardError = createFailingOutput(DISK_FULL, (text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)

    standardOutput.write('{"msg":"incoming request"}\n')
    await waitForPendingCallbacks()
    standardOutput.write('{"msg":"request completed"}\n')
    await waitForPendingCallbacks()

    expect(outputWrites).toEqual([
      '{"msg":"incoming request"}\n',
      "The Lys backend could not write to its standard error, so what it writes there is lost while writing fails: ENOSPC: no space left on device, write\n",
      '{"msg":"request completed"}\n'
    ])
    expect(errorWrites).toEqual([STANDARD_OUTPUT_DISK_FULL_REPORT])
  })
})
