import type { FastifyBaseLogger } from "fastify"
import type {
  EmailAccountCheckEvent,
  EmailServerRunFailure
} from "./emailAccountCheck"

/**
 * Writes one email account check event to the backend log.
 *
 * @param logger - Backend logger, borrowed for the call.
 * @param event - Event the checker reported.
 * @remarks A report is information with both sign-ins' outcomes and the
 * server's own error lines, such as one about a closing step that failed; a
 * missing email server is a warning; a check refused while another ran is a
 * warning; a check the closing checker ended is a warning; every other
 * failure to report is an error with how the server ended and its own
 * error lines, or, when it could not be started, with Node's error, which
 * can name the command. No entry holds the account or the password.
 */
export function handleEmailAccountCheckEvent(
  logger: FastifyBaseLogger,
  event: EmailAccountCheckEvent
): void {
  switch (event.kind) {
    case "checked":
      logger.info(
        { imap: event.imap, smtp: event.smtp, errorLines: event.errorLines },
        "Email account check ran"
      )
      return
    case "server-missing":
      logger.warn(
        "The email server is not installed, so the email account could not be checked; build.sh installs it"
      )
      return
    case "busy":
      logger.warn(
        "An email account check was refused because another check is running"
      )
      return
    case "server-failed":
      handleRunFailure(logger, event.failure)
      return
    default: {
      const unhandledEvent: never = event
      throw new TypeError(
        `Unhandled email account check event: ${JSON.stringify(unhandledEvent)}`
      )
    }
  }
}

/**
 * Writes why a check did not report.
 *
 * @param logger - Backend logger.
 * @param failure - Why.
 */
function handleRunFailure(
  logger: FastifyBaseLogger,
  failure: EmailServerRunFailure
): void {
  /** Message of every entry about a check that did not report. */
  const checkFailedMessage = "The email server's account check failed"

  switch (failure.kind) {
    case "closed":
      logger.warn(
        { failure },
        "The email account check was ended because the backend is closing"
      )
      return
    case "start-failed": {
      const loggedFailure: Pick<EmailServerRunFailure, "kind"> = {
        kind: failure.kind
      }
      logger.error(
        { failure: loggedFailure, err: failure.error },
        checkFailedMessage
      )
      return
    }
    case "timed-out":
    case "exited":
    case "unreadable-output":
      logger.error({ failure }, checkFailedMessage)
      return
    default: {
      const unhandledFailure: never = failure
      throw new TypeError(
        `Unhandled email server run failure: ${JSON.stringify(unhandledFailure)}`
      )
    }
  }
}
