import type {
  ConversationAssistantMessageFinishReason,
  ConversationAssistantMessageStatus
} from "@lys/share"
import { describe, expect, it } from "vitest"
import { buildEndReport } from "../../../../src/modules/delegation/endReports"
import type {
  EndedReplyRecord,
  EndReport
} from "../../../../src/modules/delegation/records"
import type { StopRequester } from "../../../../src/modules/delegation/replyStopRequests"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Text of the last round of the replies whose end the cases report. */
const LAST_ROUND_TEXT = "Most moths drink nectar."

/**
 * Builds a reply of a job as stored once its end is reported.
 *
 * @param status - Stored state of the reply.
 * @param finishReason - Why it finished; null unless it completed.
 * @param lastRoundText - Text of its last round; {@link LAST_ROUND_TEXT}
 * when omitted.
 * @returns The frozen record of the job's reply.
 */
function buildEndedJobReply(
  status: ConversationAssistantMessageStatus,
  finishReason: ConversationAssistantMessageFinishReason | null,
  lastRoundText: string = LAST_ROUND_TEXT
): EndedReplyRecord {
  return Object.freeze({
    conversationId: createFixtureUuidV7(2),
    parentConversationId: createFixtureUuidV7(1),
    status,
    finishReason,
    lastRoundText
  })
}

describe("buildEndReport", () => {
  /** Paragraph that tells a reply was cut off at the model's length limit. */
  const lengthLimitNote = "(The reply was cut off at the model's length limit.)"

  /** Text of a failed report whose reply sent no usable error sentence. */
  const unknownFailure = "The agent's reply failed."

  it.for<
    [
      string,
      EndedReplyRecord,
      StopRequester | undefined,
      string | undefined,
      EndReport | undefined
    ]
  >([
    [
      "completed",
      buildEndedJobReply("completed", "stop"),
      undefined,
      undefined,
      { kind: "result", content: LAST_ROUND_TEXT }
    ],
    [
      "completed with an empty last round",
      buildEndedJobReply("completed", "stop", ""),
      undefined,
      undefined,
      { kind: "result", content: "" }
    ],
    [
      "completed at the length limit",
      buildEndedJobReply("completed", "length"),
      undefined,
      undefined,
      { kind: "result", content: `${LAST_ROUND_TEXT}\n\n${lengthLimitNote}` }
    ],
    [
      "completed at the length limit with an empty last round",
      buildEndedJobReply("completed", "length", ""),
      undefined,
      undefined,
      { kind: "result", content: lengthLimitNote }
    ],
    [
      "completed before the stop its delegator asked for took effect",
      buildEndedJobReply("completed", "stop"),
      "delegator",
      undefined,
      { kind: "result", content: LAST_ROUND_TEXT }
    ],
    [
      "failed",
      buildEndedJobReply("failed", null),
      undefined,
      "The model stopped answering.",
      { kind: "failed", content: "The model stopped answering." }
    ],
    [
      "failed without an error event",
      buildEndedJobReply("failed", null),
      undefined,
      undefined,
      { kind: "failed", content: unknownFailure }
    ],
    [
      "failed with a blank error sentence",
      buildEndedJobReply("failed", null),
      undefined,
      " \n",
      { kind: "failed", content: unknownFailure }
    ],
    [
      "was interrupted by stop_job",
      buildEndedJobReply("interrupted", null),
      "delegator",
      undefined,
      undefined
    ],
    [
      "was interrupted by the person",
      buildEndedJobReply("interrupted", null),
      "person",
      undefined,
      { kind: "stopped", content: "" }
    ],
    [
      "was interrupted with no requester",
      buildEndedJobReply("interrupted", null),
      undefined,
      undefined,
      { kind: "interrupted", content: "" }
    ],
    [
      "is still stored as streaming",
      buildEndedJobReply("streaming", null),
      "person",
      undefined,
      undefined
    ]
  ])(
    "builds the report of a reply that %s",
    ([, reply, requester, errorMessage, expected]) => {
      expect(buildEndReport(reply, requester, errorMessage)).toEqual(expected)
    }
  )
})
