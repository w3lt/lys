import { describe, expect, it } from "vitest"
import { createBackendLogger } from "../../../../../../src/log"
import type { EmailAccountCheckEvent } from "../../../../../../src/modules/mcp/builtIn/email/emailAccountCheck"
import { handleEmailAccountCheckEvent } from "../../../../../../src/modules/mcp/builtIn/email/emailAccountCheckLog"
import {
  CapturedLogDestination,
  type CapturedLogRecord
} from "../../../../support/fastifyTestApp"

/** Fields every backend log line has, whatever was logged. */
const COMMON_FIELDS = ["time", "pid", "hostname"] as const

/**
 * Gets the fields of the one line the backend's logger writes for an event.
 *
 * @param event - Event to log.
 * @returns The line's fields, without the time and process fields every
 * line has.
 * @throws When the logger wrote no line or more than one.
 */
function getLoggedFields(
  event: EmailAccountCheckEvent
): Record<string, unknown> {
  const destination = new CapturedLogDestination()
  handleEmailAccountCheckEvent(createBackendLogger(destination), event)
  const records = destination.records
  if (records.length !== 1)
    throw new Error(`Expected one log line, got ${records.length}`)
  const fields: Record<string, unknown> = {
    ...(records[0] as CapturedLogRecord)
  }
  for (const name of COMMON_FIELDS) delete fields[name]
  return fields
}

describe("handleEmailAccountCheckEvent", () => {
  it("logs a report with both sign-ins' outcomes and the server's error lines", () => {
    expect(
      getLoggedFields({
        kind: "checked",
        imap: { status: "failed", reason: "wrong-password" },
        smtp: { status: "accepted" },
        errorLines: ["smtp: quit failed"]
      })
    ).toEqual({
      level: "info",
      imap: { status: "failed", reason: "wrong-password" },
      smtp: { status: "accepted" },
      errorLines: ["smtp: quit failed"],
      msg: "Email account check ran"
    })
  })

  it("warns of a missing email server", () => {
    expect(getLoggedFields({ kind: "server-missing" })).toEqual({
      level: "warn",
      msg: "The email server is not installed, so the email account could not be checked; build.sh installs it"
    })
  })

  it("warns of a check refused while another ran", () => {
    expect(getLoggedFields({ kind: "busy" })).toEqual({
      level: "warn",
      msg: "An email account check was refused because another check is running"
    })
  })

  it("logs a server that could not be started as an error with Node's error", () => {
    const error = Object.assign(new Error("spawn /opt/lys/email EACCES"), {
      code: "EACCES"
    })

    const fields = getLoggedFields({
      kind: "server-failed",
      failure: { kind: "start-failed", error }
    })

    expect(fields).toMatchObject({
      level: "error",
      failure: { kind: "start-failed" },
      err: { message: "spawn /opt/lys/email EACCES", code: "EACCES" },
      msg: "The email server's account check failed"
    })
  })

  it.each([
    [{ kind: "timed-out", errorLines: ["connecting to the IMAP server"] }],
    [
      {
        kind: "exited",
        exitCode: 1,
        signal: null,
        errorLines: ["unexpected failure: boom"]
      }
    ],
    [{ kind: "unreadable-output", errorLines: [] }]
  ] as const)(
    "logs a server that did not report as an error: %o",
    (failure) => {
      expect(getLoggedFields({ kind: "server-failed", failure })).toEqual({
        level: "error",
        failure,
        msg: "The email server's account check failed"
      })
    }
  )

  it("warns of a check the closing backend ended", () => {
    expect(
      getLoggedFields({ kind: "server-failed", failure: { kind: "closed" } })
    ).toEqual({
      level: "warn",
      failure: { kind: "closed" },
      msg: "The email account check was ended because the backend is closing"
    })
  })
})
