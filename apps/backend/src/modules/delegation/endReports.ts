import type { EndedReplyRecord, EndReport } from "./records"
import type { StopRequester } from "./replyStopRequests"

/**
 * Builds the report that tells a job's delegator how a reply of the job
 * ended.
 *
 * @param reply - The reply as stored once its end is reported.
 * @param requester - Who asked the reply to stop; undefined when nobody did.
 * @param errorMessage - Sentence of the reply's `error` event; undefined when
 * it sent none.
 * @returns A frozen report, or undefined when the reply's end gives none. A
 * `completed` reply gives a `result`, whoever asked it to stop, as
 * {@link buildResultReport} writes it. A `failed` reply gives a `failed`
 * report, as {@link buildFailedReport} writes it. An `interrupted` reply
 * gives what {@link buildInterruptedReport} gives for its requester. A reply
 * still stored as `streaming`, whose final state could not be stored, gives
 * none.
 * @throws {TypeError} If the reply's state is one this module does not know.
 */
export function buildEndReport(
  reply: EndedReplyRecord,
  requester: StopRequester | undefined,
  errorMessage: string | undefined
): EndReport | undefined {
  if (reply.status === "completed") return buildResultReport(reply)
  const { status } = reply
  switch (status) {
    case "failed":
      return buildFailedReport(errorMessage)
    case "interrupted":
      return buildInterruptedReport(requester)
    case "streaming":
      return undefined
    default: {
      const unhandledStatus: never = status
      throw new TypeError(
        `Unhandled reply state: ${JSON.stringify(unhandledStatus)}`
      )
    }
  }
}

/**
 * Builds the result report of a completed reply.
 *
 * @param reply - Why the reply finished, and the text of its last round.
 * @returns A frozen `result` with the last round's text. A reply that
 * finished at the model's length limit gets a paragraph that says it was cut
 * off, after a blank line, or as the whole text when its last round wrote
 * only whitespace.
 */
function buildResultReport(
  reply: Pick<
    Extract<EndedReplyRecord, { status: "completed" }>,
    "finishReason" | "lastRoundText"
  >
): Extract<EndReport, { kind: "result" }> {
  const { lastRoundText } = reply
  if (reply.finishReason !== "length")
    return Object.freeze({ kind: "result", content: lastRoundText })
  const lengthLimitNote = "(The reply was cut off at the model's length limit.)"
  const content =
    lastRoundText.trim() === ""
      ? lengthLimitNote
      : `${lastRoundText}\n\n${lengthLimitNote}`
  return Object.freeze({ kind: "result", content })
}

/**
 * Builds the failure report of a failed reply.
 *
 * @param errorMessage - Sentence of the reply's `error` event; undefined when
 * it sent none.
 * @returns A frozen `failed` report with the sentence as given, or with
 * `The agent's reply failed.` when the sentence is missing, empty, or only
 * whitespace.
 */
function buildFailedReport(
  errorMessage: string | undefined
): Extract<EndReport, { kind: "failed" }> {
  if (errorMessage === undefined || errorMessage.trim() === "")
    return Object.freeze({
      kind: "failed",
      content: "The agent's reply failed."
    })
  return Object.freeze({ kind: "failed", content: errorMessage })
}

/**
 * Builds the report of an interrupted reply, from who asked it to stop.
 *
 * @param requester - Who asked the reply to stop; undefined when nobody did.
 * @returns Undefined when the delegator asked, since it stopped the job
 * itself; a frozen, empty `stopped` report when the person asked; a frozen,
 * empty `interrupted` report when nobody asked, as when the backend stops.
 * @throws {TypeError} If the requester is one this module does not know.
 */
function buildInterruptedReport(
  requester: StopRequester | undefined
): Extract<EndReport, { kind: "stopped" | "interrupted" }> | undefined {
  switch (requester) {
    case "delegator":
      return undefined
    case "person":
      return Object.freeze({ kind: "stopped", content: "" })
    case undefined:
      return Object.freeze({ kind: "interrupted", content: "" })
    default: {
      const unhandledRequester: never = requester
      throw new TypeError(
        `Unhandled stop requester: ${JSON.stringify(unhandledRequester)}`
      )
    }
  }
}
