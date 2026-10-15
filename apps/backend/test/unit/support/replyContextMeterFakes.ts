import { vi, type Mock } from "vitest"
import type {
  ReplyContextMeasurementRequest,
  ReplyContextMeter
} from "../../../src/modules/agent/replyContextMeter"

/** Context length of the roomy meter's model, larger than any test context. */
export const ROOMY_CONTEXT_LENGTH = 1_000_000

/** Context meter whose query a case can observe and replace. */
export type FakeReplyContextMeter = ReplyContextMeter &
  Readonly<{
    /** Measurement query, recording every request. */
    findReplyContextMeasurement: Mock<
      ReplyContextMeter["findReplyContextMeasurement"]
    >
  }>

/**
 * Creates a meter under which every context fits.
 *
 * @returns A meter whose query reports {@link ROOMY_CONTEXT_LENGTH}, one
 * token per message, and no tool tokens.
 */
export function createRoomyReplyContextMeter(): FakeReplyContextMeter {
  return Object.freeze({
    findReplyContextMeasurement: vi.fn(
      (request: ReplyContextMeasurementRequest) =>
        Promise.resolve(
          Object.freeze({
            contextLength: ROOMY_CONTEXT_LENGTH,
            messageTokenCounts: Object.freeze(request.messages.map(() => 1)),
            toolTokenCount: 0
          })
        )
    )
  })
}

/**
 * Creates a meter for which the model is not loaded.
 *
 * @returns A meter whose query reports no measurement.
 */
export function createUnloadedReplyContextMeter(): FakeReplyContextMeter {
  return Object.freeze({
    findReplyContextMeasurement: vi.fn<
      ReplyContextMeter["findReplyContextMeasurement"]
    >(() => Promise.resolve(undefined))
  })
}
