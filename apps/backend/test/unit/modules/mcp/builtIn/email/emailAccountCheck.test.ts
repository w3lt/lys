import type { EmailServerCheckFailure } from "@lys/protocol"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { createBackendLogger } from "../../../../../../src/log"
import EmailAccountChecker, {
  type EmailAccountCheckEvent
} from "../../../../../../src/modules/mcp/builtIn/email/emailAccountCheck"
import { handleEmailAccountCheckEvent } from "../../../../../../src/modules/mcp/builtIn/email/emailAccountCheckLog"
import type { EmailServerCommand } from "../../../../../../src/modules/mcp/builtIn/email/emailServer"
import {
  buildEmailAccount,
  buildFakeEmailServerCommand,
  readRecordedEmailProcessId,
  readRecordedEmailVariable,
  SYNTHETIC_EMAIL_PASSWORD,
  type FakeEmailServerOptions
} from "../../../../support/emailTestServer"
import {
  CapturedLogDestination,
  type CapturedLogRecord
} from "../../../../support/fastifyTestApp"
import { isProcessRunning } from "../../../../support/mcpTestServers"
import { createSettlementReader } from "../../../../support/settlement"
import { createUnstartedChildProcess } from "../../../../support/unstartedChildProcess"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Readonly<{ spawn: typeof spawn }>>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

/** Longest one check may run in a case that expects it to end. */
const CHECK_TIMEOUT_MILLISECONDS = 10_000

/** Longest one case may run; a case starts a check process. */
const CASE_TIMEOUT_MILLISECONDS = 30_000

/**
 * Whether the tests run on macOS, where Node throws as it starts an
 * executable file that is not a program (`ENOEXEC`). On Linux, libuv
 * starts a command through glibc's `execvp`, which runs such a file with
 * `/bin/sh` instead.
 */
const IS_MACOS = process.platform === "darwin"

/** Every reason a sign-in can fail for. */
const FAILURE_REASONS: readonly EmailServerCheckFailure[] = [
  "wrong-password",
  "unreachable",
  "certificate-refused",
  "encryption-not-offered",
  "timed-out",
  "protocol-error"
]

/**
 * Creates an empty folder for one case, removed after it.
 *
 * @returns Absolute path of the folder.
 */
async function createCaseFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "lys-email-check-"))
  onTestFinished(async () => {
    await rm(folder, { recursive: true, force: true })
  })
  return folder
}

/** What a case's checker uses instead of the defaults. */
type CheckerSetup = Readonly<{
  /** What the fake email server does; it records nothing when omitted. */
  fake?: FakeEmailServerOptions
  /** The command; the fake's when omitted. */
  serverCommand?: EmailServerCommand
  /**
   * Folder each check starts in, where the fake records; the system's
   * temporary folder when omitted, for a case that records nothing.
   */
  workingDirectory?: string
  /** Longest one check may run; {@link CHECK_TIMEOUT_MILLISECONDS} when omitted. */
  timeoutMilliseconds?: number
}>

/**
 * Creates a checker over the fake email server, closed when the case
 * finishes.
 *
 * @param setup - What replaces the defaults.
 * @returns The checker and the events it reported.
 */
function createChecker(setup: CheckerSetup = {}) {
  const events: EmailAccountCheckEvent[] = []
  const checker = new EmailAccountChecker({
    serverCommand:
      setup.serverCommand ?? buildFakeEmailServerCommand(setup.fake),
    workingDirectory: setup.workingDirectory ?? tmpdir(),
    timeoutMilliseconds:
      setup.timeoutMilliseconds ?? CHECK_TIMEOUT_MILLISECONDS,
    reportEvent: (event) => events.push(event)
  })
  onTestFinished(async () => {
    await checker.close()
  })
  return { checker, events }
}

/**
 * Builds the records the backend's log holds for the events a checker
 * reported, written as the backend writes them.
 *
 * @param events - The events, in the order they were reported.
 * @returns One record per event, in that order.
 */
function buildCheckLogRecords(
  events: readonly EmailAccountCheckEvent[]
): readonly CapturedLogRecord[] {
  const destination = new CapturedLogDestination()
  const logger = createBackendLogger(destination)
  for (const event of events) handleEmailAccountCheckEvent(logger, event)
  return destination.records
}

describe("EmailAccountChecker", { timeout: CASE_TIMEOUT_MILLISECONDS }, () => {
  it("answers both sign-ins' outcomes, starting the server in the working folder with the account and the password in its variable", async () => {
    const folder = await createCaseFolder()
    const fake: FakeEmailServerOptions = { recordsVariable: true }
    const { checker, events } = createChecker({
      fake,
      workingDirectory: folder
    })
    const account = buildEmailAccount("accepted@example.com")

    const answer = await checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD)

    expect(answer).toEqual({
      status: "checked",
      imap: { status: "accepted" },
      smtp: { status: "accepted" }
    })
    expect(Object.isFrozen(answer)).toBe(true)
    expect(await readRecordedEmailVariable(folder)).toEqual({
      address: "accepted@example.com",
      displayName: "Test Person",
      userName: "accepted@example.com",
      password: SYNTHETIC_EMAIL_PASSWORD,
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 465, security: "tls" },
      serverKeepsSentCopy: false
    })
    expect(events).toEqual([
      {
        kind: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" },
        errorLines: []
      }
    ])
  })

  it("reports what the server wrote to standard error with the outcomes of a check that reported", async () => {
    const { checker, events } = createChecker()

    const answer = await checker.sendCheck(
      buildEmailAccount("quit-failed@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({
      status: "checked",
      imap: { status: "accepted" },
      smtp: { status: "accepted" }
    })
    expect(events).toEqual([
      {
        kind: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" },
        errorLines: ["smtp: quit did not finish within the check's limit"]
      }
    ])
  })

  it.each([32, 33])(
    "keeps the first 32 error lines with the outcomes of a check that reported, and the log writes those, when the server writes %i lines",
    async (lineCount) => {
      const { checker, events } = createChecker()
      const keptLines = Array.from(
        { length: 32 },
        (_, index) => `line ${index + 1}`
      )

      const answer = await checker.sendCheck(
        buildEmailAccount(`lines-${lineCount}@example.com`),
        SYNTHETIC_EMAIL_PASSWORD
      )

      expect(answer).toEqual({
        status: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" }
      })
      expect(events).toEqual([
        {
          kind: "checked",
          imap: { status: "accepted" },
          smtp: { status: "accepted" },
          errorLines: keptLines
        }
      ])
      expect(buildCheckLogRecords(events)).toEqual([
        expect.objectContaining({
          msg: "Email account check ran",
          errorLines: keptLines
        })
      ])
    }
  )

  it("answers a report the server printed in 65,536 characters, the most the checker reads", async () => {
    const { checker, events } = createChecker()

    const answer = await checker.sendCheck(
      buildEmailAccount("padded-65536@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({
      status: "checked",
      imap: { status: "accepted" },
      smtp: { status: "accepted" }
    })
    expect(events).toEqual([
      {
        kind: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" },
        errorLines: []
      }
    ])
  })

  it("answers server-failed when the server prints a report in 65,537 characters, one more than the checker reads", async () => {
    const { checker, events } = createChecker()

    const answer = await checker.sendCheck(
      buildEmailAccount("padded-65537@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(events).toEqual([
      {
        kind: "server-failed",
        failure: { kind: "unreadable-output", errorLines: [] }
      }
    ])
  })

  it.each(FAILURE_REASONS)(
    "passes on a sign-in that failed because %s",
    async (reason) => {
      const { checker } = createChecker()

      const imapFailed = await checker.sendCheck(
        buildEmailAccount(`imap-${reason}@example.com`),
        SYNTHETIC_EMAIL_PASSWORD
      )
      const smtpFailed = await checker.sendCheck(
        buildEmailAccount(`smtp-${reason}@example.com`),
        SYNTHETIC_EMAIL_PASSWORD
      )

      expect(imapFailed).toEqual({
        status: "checked",
        imap: { status: "failed", reason },
        smtp: { status: "accepted" }
      })
      expect(smtpFailed).toEqual({
        status: "checked",
        imap: { status: "accepted" },
        smtp: { status: "failed", reason }
      })
    }
  )

  it("answers server-missing when the email server's executable does not exist", async () => {
    const folder = await createCaseFolder()
    const serverCommand: EmailServerCommand = {
      command: join(folder, "email"),
      arguments: []
    }
    const { checker, events } = createChecker({ serverCommand })

    const answer = await checker.sendCheck(
      buildEmailAccount("accepted@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-missing" })
    expect(events).toEqual([{ kind: "server-missing" }])
  })

  it("answers server-failed with Node's error when the executable cannot be started", async () => {
    const folder = await createCaseFolder()
    const path = join(folder, "email")
    await writeFile(path, "not a program")
    await chmod(path, 0o644)
    const serverCommand: EmailServerCommand = { command: path, arguments: [] }
    const { checker, events } = createChecker({ serverCommand })

    const answer = await checker.sendCheck(
      buildEmailAccount("accepted@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(events).toEqual([
      {
        kind: "server-failed",
        failure: { kind: "start-failed", error: expect.any(Error) }
      }
    ])
    expect(JSON.stringify(events)).not.toContain("7f3a")
  })

  it.each([
    ["the command's path goes through a file", "command"],
    ["the working folder is a file", "working folder"]
  ] as const)(
    "answers server-failed with Node's error when Node throws as it starts the server, because %s",
    async (_label, place) => {
      const folder = await createCaseFolder()
      const file = join(folder, "file")
      await writeFile(file, "")
      const serverCommand: EmailServerCommand = {
        command: join(file, "email"),
        arguments: []
      }
      const { checker, events } = createChecker(
        place === "command" ? { serverCommand } : { workingDirectory: file }
      )

      const answer = await checker.sendCheck(
        buildEmailAccount("accepted@example.com"),
        SYNTHETIC_EMAIL_PASSWORD
      )

      expect(answer).toEqual({
        status: "unavailable",
        reason: "server-failed"
      })
      expect(events).toEqual([
        {
          kind: "server-failed",
          failure: { kind: "start-failed", error: expect.any(Error) }
        }
      ])
      expect(events[0]).toMatchObject({
        failure: { error: { code: "ENOTDIR" } }
      })
      expect(JSON.stringify(events)).not.toContain("7f3a")
    }
  )

  it.runIf(IS_MACOS)(
    "answers server-failed with Node's error when Node throws as it starts an executable file that is not a program",
    async () => {
      const folder = await createCaseFolder()
      const path = join(folder, "email")
      await writeFile(path, "not a program")
      await chmod(path, 0o755)
      const serverCommand: EmailServerCommand = { command: path, arguments: [] }
      const { checker, events } = createChecker({ serverCommand })

      const answer = await checker.sendCheck(
        buildEmailAccount("accepted@example.com"),
        SYNTHETIC_EMAIL_PASSWORD
      )

      expect(answer).toEqual({
        status: "unavailable",
        reason: "server-failed"
      })
      expect(events).toEqual([
        {
          kind: "server-failed",
          failure: { kind: "start-failed", error: expect.any(Error) }
        }
      ])
      expect(events[0]).toMatchObject({
        failure: { error: { code: "ENOEXEC" } }
      })
    }
  )

  it.each(["EMFILE", "ENFILE"] as const)(
    "answers server-failed with Node's error when Node finds no file descriptor for the server's pipes (%s)",
    async (shortage) => {
      const { checker, events } = createChecker()
      vi.mocked(spawn).mockImplementationOnce((command, args) =>
        createUnstartedChildProcess(command, args, shortage)
      )
      onTestFinished(() => {
        vi.mocked(spawn).mockReset()
      })

      const answer = await checker.sendCheck(
        buildEmailAccount("accepted@example.com"),
        SYNTHETIC_EMAIL_PASSWORD
      )

      expect(answer).toEqual({
        status: "unavailable",
        reason: "server-failed"
      })
      expect(events).toEqual([
        {
          kind: "server-failed",
          failure: { kind: "start-failed", error: expect.any(Error) }
        }
      ])
      expect(events[0]).toMatchObject({
        failure: { error: { code: shortage } }
      })
    }
  )

  it("answers server-failed with the exit code and the error lines when the server ends without a report", async () => {
    const { checker, events } = createChecker()

    const answer = await checker.sendCheck(
      buildEmailAccount("crash@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(events).toEqual([
      {
        kind: "server-failed",
        failure: {
          kind: "exited",
          exitCode: 1,
          signal: null,
          errorLines: [
            "connecting to the IMAP server",
            "unexpected failure: boom"
          ]
        }
      }
    ])
  })

  it.each([
    ["a line that is not a report", "garbage"],
    ["more than a report can be", "flood"]
  ])(
    "answers server-failed when the server ends normally printing %s",
    async (_label, localPart) => {
      const { checker, events } = createChecker()

      const answer = await checker.sendCheck(
        buildEmailAccount(`${localPart}@example.com`),
        SYNTHETIC_EMAIL_PASSWORD
      )

      expect(answer).toEqual({
        status: "unavailable",
        reason: "server-failed"
      })
      expect(events).toEqual([
        {
          kind: "server-failed",
          failure: { kind: "unreadable-output", errorLines: [] }
        }
      ])
    }
  )

  it("answers server-missing when the working folder does not exist, as Node reports it as a missing executable", async () => {
    const folder = await createCaseFolder()
    const { checker, events } = createChecker({
      workingDirectory: join(folder, "missing")
    })

    const answer = await checker.sendCheck(
      buildEmailAccount("accepted@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-missing" })
    expect(events).toEqual([{ kind: "server-missing" }])
  })

  it("kills a server that does not end within the time limit and answers server-failed, keeping the error lines it wrote", async () => {
    const folder = await createCaseFolder()
    const fake: FakeEmailServerOptions = { recordsProcessId: true }
    const { checker, events } = createChecker({
      fake,
      workingDirectory: folder,
      // Far past the fake's start, by which it wrote its pid and its line.
      timeoutMilliseconds: 1000
    })

    const answer = await checker.sendCheck(
      buildEmailAccount("hang@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(events).toEqual([
      {
        kind: "server-failed",
        failure: {
          kind: "timed-out",
          errorLines: ["connecting to the IMAP server"]
        }
      }
    ])
    const processId = await readRecordedEmailProcessId(folder)
    await vi.waitFor(() => {
      expect(isProcessRunning(processId)).toBe(false)
    })
  })

  it("answers busy at once to a check asked for while another runs, starting nothing for it, and runs a check asked for once the other ended", async () => {
    const folder = await createCaseFolder()
    const fake: FakeEmailServerOptions = {
      recordsVariable: true,
      holdMilliseconds: 300
    }
    const { checker, events } = createChecker({
      fake,
      workingDirectory: folder
    })
    const accepted = {
      status: "checked",
      imap: { status: "accepted" },
      smtp: { status: "accepted" }
    }
    const running = checker.sendCheck(
      buildEmailAccount("lock@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )
    const runningSettlement = createSettlementReader(running)

    const refused = await checker.sendCheck(
      buildEmailAccount("accepted@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(refused).toEqual({ status: "unavailable", reason: "busy" })
    expect(Object.isFrozen(refused)).toBe(true)
    expect(runningSettlement()).toBe("pending")
    expect(events).toEqual([{ kind: "busy" }])
    expect(await running).toEqual(accepted)
    expect(await readRecordedEmailVariable(folder)).toMatchObject({
      address: "lock@example.com"
    })
    expect(
      await checker.sendCheck(
        buildEmailAccount("accepted@example.com"),
        SYNTHETIC_EMAIL_PASSWORD
      )
    ).toEqual(accepted)
  })

  it("answers a check asked for while the checker closes as closed, not busy", async () => {
    const folder = await createCaseFolder()
    const fake: FakeEmailServerOptions = { recordsProcessId: true }
    const { checker, events } = createChecker({
      fake,
      workingDirectory: folder
    })
    const running = checker.sendCheck(
      buildEmailAccount("hang@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )
    await vi.waitFor(async () => {
      await readRecordedEmailProcessId(folder)
    })

    const closing = checker.close()
    const later = await checker.sendCheck(
      buildEmailAccount("accepted@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )
    await closing

    expect(later).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(await running).toEqual({
      status: "unavailable",
      reason: "server-failed"
    })
    expect(events).toEqual([
      { kind: "server-failed", failure: { kind: "closed" } },
      { kind: "server-failed", failure: { kind: "closed" } }
    ])
  })

  it("kills the running check as it closes, and runs no later check", async () => {
    const folder = await createCaseFolder()
    const fake: FakeEmailServerOptions = { recordsProcessId: true }
    const { checker, events } = createChecker({
      fake,
      workingDirectory: folder
    })
    const account = buildEmailAccount("hang@example.com")
    const running = checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD)
    await vi.waitFor(async () => {
      await readRecordedEmailProcessId(folder)
    })

    await checker.close()
    const later = await checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD)

    expect(await running).toEqual({
      status: "unavailable",
      reason: "server-failed"
    })
    expect(later).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(events).toEqual([
      { kind: "server-failed", failure: { kind: "closed" } },
      { kind: "server-failed", failure: { kind: "closed" } }
    ])
    const processId = await readRecordedEmailProcessId(folder)
    expect(isProcessRunning(processId)).toBe(false)
  })
})
