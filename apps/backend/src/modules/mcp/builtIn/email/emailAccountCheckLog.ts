import type { FastifyBaseLogger } from "fastify"
import type {
  EmailAccountCheckEvent,
  EmailServerRunFailure
} from "./emailAccountCheck"

/** Message of every entry about a check that did not report. */
const CHECK_FAILED_MESSAGE = "The email server's account check failed"

/**
 * Writes one email account check event to the backend log.
 *
 * @param logger - Backend logger, borrowed for the call.
 * @param event - Event the checker reported.
 * @remarks A report is information with both sign-ins' outcomes; a missing
 * email server is a warning; a check the closing checker ended is a
 * warning; every other failure to report is an error with how the server
 * ended and its own error lines, or, when it could not be started, with
 * Node's error, which names the command. No entry holds the account or the
 * password.
 */
export function handleEmailAccountCheckEvent(
  logger: FastifyBaseLogger,
  event: EmailAccountCheckEvent
): void {
  switch (event.kind) {
    case "checked":
      logger.info(
        { imap: event.imap, smtp: event.smtp },
        "Email account check ran"
      )
      return
    case "server-missing":
      logger.warn(
        "The email server is not installed, so the email account could not be checked; build.sh installs it"
      )
      return
    case "server-failed":
      handleRunFailure(logger, event.failure)
      return
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
  switch (failure.kind) {
    case "closed":
      logger.warn(
        { failure },
        "The email account check was ended because the backend is closing"
      )
      return
    case "start-failed":
      logger.error(
        { failure: { kind: failure.kind }, err: failure.error },
        CHECK_FAILED_MESSAGE
      )
      return
    case "timed-out":
    case "exited":
    case "unreadable-output":
      logger.error({ failure }, CHECK_FAILED_MESSAGE)
      return
  }
}
