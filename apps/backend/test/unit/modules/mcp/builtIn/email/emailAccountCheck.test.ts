import type { EmailServerCheckFailure } from "@lys/protocol"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

/**
 * Creates a checker over the fake email server, closed when the case
 * finishes.
 *
 * @param options - What the fake does.
 * @param timeoutMilliseconds - Longest one check may run.
 * @param serverCommand - The command, the fake's when omitted.
 * @returns The checker and the events it reported.
 */
function createChecker(
  options: FakeEmailServerOptions = {},
  timeoutMilliseconds = CHECK_TIMEOUT_MILLISECONDS,
  serverCommand: EmailServerCommand = buildFakeEmailServerCommand(options)
) {
  const events: EmailAccountCheckEvent[] = []
  const checker = new EmailAccountChecker({
    serverCommand,
    timeoutMilliseconds,
    reportEvent: (event) => events.push(event)
  })
  onTestFinished(async () => {
    await checker.close()
  })
  return { checker, events }
}

describe("EmailAccountChecker", { timeout: CASE_TIMEOUT_MILLISECONDS }, () => {
  it("answers both sign-ins' outcomes, giving the server the account and the password in its variable", async () => {
    const folder = await createCaseFolder()
    const recordFile = join(folder, "variable")
    const { checker, events } = createChecker({ recordFile })
    const account = buildEmailAccount("accepted@example.com")

    const answer = await checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD)

    expect(answer).toEqual({
      status: "checked",
      imap: { status: "accepted" },
      smtp: { status: "accepted" }
    })
    expect(Object.isFrozen(answer)).toBe(true)
    expect(JSON.parse(await readFile(recordFile, "utf8"))).toEqual({
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
    const { checker, events } = createChecker({}, CHECK_TIMEOUT_MILLISECONDS, {
      command: join(folder, "email"),
      arguments: []
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
    const { checker, events } = createChecker({}, CHECK_TIMEOUT_MILLISECONDS, {
      command: path,
      arguments: []
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

  it("kills a server that does not end within the time limit and answers server-failed", async () => {
    const folder = await createCaseFolder()
    const processIdFile = join(folder, "pid")
    const { checker, events } = createChecker({ processIdFile }, 500)

    const answer = await checker.sendCheck(
      buildEmailAccount("hang@example.com"),
      SYNTHETIC_EMAIL_PASSWORD
    )

    expect(answer).toEqual({ status: "unavailable", reason: "server-failed" })
    expect(events).toEqual([
      { kind: "server-failed", failure: { kind: "timed-out" } }
    ])
    const processId = Number(await readFile(processIdFile, "utf8"))
    await vi.waitFor(() => {
      expect(isProcessRunning(processId)).toBe(false)
    })
  })

  it("runs one check at a time, in call order", async () => {
    const folder = await createCaseFolder()
    const { checker } = createChecker({
      lockFile: join(folder, "lock"),
      holdMilliseconds: 300
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
    const processIdFile = join(folder, "pid")
    const { checker, events } = createChecker({ processIdFile })
    const account = buildEmailAccount("hang@example.com")
    const running = checker.sendCheck(account, SYNTHETIC_EMAIL_PASSWORD)
    await vi.waitFor(async () => {
      await readFile(processIdFile, "utf8")
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
    const processId = Number(await readFile(processIdFile, "utf8"))
    expect(isProcessRunning(processId)).toBe(false)
  })
})
