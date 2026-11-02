import type { EmailServerCheckFailure } from "@lys/protocol"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import EmailAccountChecker, {
  type EmailAccountCheckEvent
} from "../../../../../../src/modules/mcp/builtIn/email/emailAccountCheck"
import type { EmailServerCommand } from "../../../../../../src/modules/mcp/builtIn/email/emailServer"
import {
  buildEmailAccount,
  buildFakeEmailServerCommand,
  readRecordedEmailProcessId,
  readRecordedEmailVariable,
  SYNTHETIC_EMAIL_PASSWORD,
  type FakeEmailServerOptions
} from "../../../../support/emailTestServer"
import { isProcessRunning } from "../../../../support/mcpTestServers"

/** Longest one check may run in a case that expects it to end. */
const CHECK_TIMEOUT_MILLISECONDS = 10_000

/** Longest one case may run; a case starts a check process. */
const CASE_TIMEOUT_MILLISECONDS = 30_000

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

describe("EmailAccountChecker", { timeout: CASE_TIMEOUT_MILLISECONDS }, () => {
  it("answers both sign-ins' outcomes, starting the server in the working folder with the account and the password in its variable", async () => {
    const folder = await createCaseFolder()
    const { checker, events } = createChecker({
      fake: { recordsVariable: true },
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
        smtp: { status: "accepted" }
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
    const { checker, events } = createChecker({
      serverCommand: { command: join(folder, "email"), arguments: [] }
    })

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
    const { checker, events } = createChecker({
      serverCommand: { command: path, arguments: [] }
    })

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
      const { checker, events } = createChecker(
        place === "command"
          ? { serverCommand: { command: join(file, "email"), arguments: [] } }
          : { workingDirectory: file }
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
    const { checker, events } = createChecker({
      fake: { recordsProcessId: true },
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

  it("runs one check at a time, in call order", async () => {
    const folder = await createCaseFolder()
    const { checker } = createChecker({
      fake: { holdMilliseconds: 300 },
      workingDirectory: folder
    })
    const account = buildEmailAccount("lock@example.com")

    const answers = await Promise.all([
      checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD),
      checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD)
    ])

    expect(answers).toEqual([
      {
        status: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" }
      },
      {
        status: "checked",
        imap: { status: "accepted" },
        smtp: { status: "accepted" }
      }
    ])
  })

  it("kills the running check as it closes, and runs no later check", async () => {
    const folder = await createCaseFolder()
    const { checker, events } = createChecker({
      fake: { recordsProcessId: true },
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
