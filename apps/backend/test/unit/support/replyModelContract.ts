import type { ConversationAssistantMessageFinishReason } from "@lys/share"
import { describe, expect, it } from "vitest"
import type {
  ReplyModel,
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../../../src/modules/agent/replyModel"
import { ChatCompletionCancelledError } from "../../../src/utils/errors"

/** What the model behind a reply model does with every request of a case. */
export type ReplyModelScript =
  | Readonly<{
      /** The model writes `texts` in order, then ends the reply. */
      kind: "finished-reply"
      /** Nonempty texts of the reply, in order. */
      texts: readonly string[]
      /** Supported reason the model ends the reply. */
      finishReason: ConversationAssistantMessageFinishReason
    }>
  | Readonly<{
      /**
       * The model writes `texts` in order, then ends the reply for a reason a
       * reply cannot be stored with, such as a tool call.
       */
      kind: "unsupported-finish"
      /** Nonempty texts of the reply, in order. */
      texts: readonly string[]
    }>
  | Readonly<{
      /**
       * The model writes `texts` in order, then its stream fails before the
       * reply ends, such as when the connection to the model drops.
       */
      kind: "failed-stream"
      /** Nonempty texts written before the failure, in order. */
      texts: readonly string[]
    }>
  | Readonly<{
      /**
       * The model writes `texts` in order and keeps writing the reply until
       * its request is released.
       */
      kind: "open-reply"
      /** Nonempty texts written before the reply stays open, in order. */
      texts: readonly string[]
    }>
  | Readonly<{
      /** The model receives the request but never accepts it. */
      kind: "unaccepted-request"
    }>
  | Readonly<{
      /** The model rejects the request. */
      kind: "rejected-request"
    }>

/** One ready reply model whose model follows a script, with its observations. */
export type ReplyModelHarness = Readonly<{
  /** Reply model under test. */
  replyModel: ReplyModel
  /** Settles once the model received a request. */
  waitForModelRequest: () => Promise<void>
  /**
   * Settles once the model's request for an open reply was released; it
   * stays pending for any other script.
   */
  waitForRequestRelease: () => Promise<void>
}>

/**
 * Creates one reply model whose model follows the script, owned by the
 * current test, which releases it when it finishes.
 */
export type ReplyModelHarnessFactory = (
  script: ReplyModelScript
) => ReplyModelHarness

/** Events read from one reply stream and the failure that ended it, if any. */
type ReplyStreamReading = Readonly<{
  /** Events in the order the stream yielded them. */
  events: readonly ReplyStreamEvent[]
  /** Rejection of the stream, or undefined when it ended normally. */
  failure: unknown
}>

/**
 * Creates the request every case sends.
 *
 * @param abortSignal - Cancellation owned by the case.
 * @returns A request with a system prompt and one user message.
 */
function createReplyStreamRequest(
  abortSignal: AbortSignal
): ReplyStreamRequest {
  return {
    messages: [
      { role: "system", content: "You are Lys." },
      { role: "user", content: "Hello" }
    ],
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.4, replyCeiling: 128 },
    abortSignal
  }
}

/**
 * Reads a reply stream to its end or failure.
 *
 * @param stream - Opened reply stream, consumed by the reading.
 * @returns The events read and the failure that ended the stream, if any.
 */
async function readReplyStream(
  stream: AsyncIterable<ReplyStreamEvent>
): Promise<ReplyStreamReading> {
  const events: ReplyStreamEvent[] = []
  try {
    for await (const event of stream) events.push(event)
    return { events, failure: undefined }
  } catch (error) {
    return { events, failure: error }
  }
}

/**
 * Reads a reply stream to its end or failure, cancelling its request once the
 * first event arrived.
 *
 * @param stream - Opened reply stream, consumed by the reading.
 * @param cancellation - Controller of the request's signal.
 * @returns The events read and the failure that ended the stream, if any.
 */
async function readReplyStreamCancellingAtFirstEvent(
  stream: AsyncIterable<ReplyStreamEvent>,
  cancellation: AbortController
): Promise<ReplyStreamReading> {
  const events: ReplyStreamEvent[] = []
  try {
    for await (const event of stream) {
      events.push(event)
      cancellation.abort()
    }
    return { events, failure: undefined }
  } catch (error) {
    return { events, failure: error }
  }
}

/**
 * Registers the provider-independent {@link ReplyModel} contract cases.
 *
 * @param createHarness - Creates one reply model per case whose model follows
 * the case's script.
 */
export function registerReplyModelContractSuite(
  createHarness: ReplyModelHarnessFactory
): void {
  describe("ReplyModel contract", () => {
    it.each(["stop", "length"] as const)(
      "yields each text in order, then the %s finish that ends the reply",
      async (finishReason) => {
        const { replyModel } = createHarness({
          kind: "finished-reply",
          texts: ["Hi", " there"],
          finishReason
        })

        const stream = await replyModel.openReplyStream(
          createReplyStreamRequest(new AbortController().signal)
        )

        expect(await readReplyStream(stream)).toEqual({
          events: [
            { type: "text", content: "Hi" },
            { type: "text", content: " there" },
            { type: "finish", finishReason }
          ],
          failure: undefined
        })
      }
    )

    it.each([
      ["the reply ends for an unsupported reason", "unsupported-finish"],
      ["the model's stream fails before the reply ends", "failed-stream"]
    ] as const)(
      "rejects the stream after the earlier text when %s",
      async (_label, kind) => {
        const { replyModel } = createHarness({ kind, texts: ["Hi"] })

        const stream = await replyModel.openReplyStream(
          createReplyStreamRequest(new AbortController().signal)
        )
        const reading = await readReplyStream(stream)

        expect(reading.events).toEqual([{ type: "text", content: "Hi" }])
        expect(reading.failure).toBeInstanceOf(Error)
        expect(reading.failure).not.toBeInstanceOf(ChatCompletionCancelledError)
      }
    )

    it("rejects opening, without reporting a cancellation, when the model rejects the request", async () => {
      const { replyModel } = createHarness({ kind: "rejected-request" })

      const failure = await replyModel
        .openReplyStream(createReplyStreamRequest(new AbortController().signal))
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(ChatCompletionCancelledError)
    })

    it("rejects an already cancelled request as cancelled", async () => {
      const { replyModel } = createHarness({
        kind: "finished-reply",
        texts: ["Hi"],
        finishReason: "stop"
      })

      await expect(
        replyModel.openReplyStream(
          createReplyStreamRequest(AbortSignal.abort())
        )
      ).rejects.toBeInstanceOf(ChatCompletionCancelledError)
    })

    it("rejects a request cancelled before the model accepts it as cancelled", async () => {
      const harness = createHarness({ kind: "unaccepted-request" })
      const cancellation = new AbortController()

      const opening = harness.replyModel
        .openReplyStream(createReplyStreamRequest(cancellation.signal))
        .catch((error: unknown) => error)
      await harness.waitForModelRequest()
      cancellation.abort()

      expect(await opening).toBeInstanceOf(ChatCompletionCancelledError)
    })

    it("releases the request when the reader leaves the stream early", async () => {
      const harness = createHarness({ kind: "open-reply", texts: ["Hi"] })

      const stream = await harness.replyModel.openReplyStream(
        createReplyStreamRequest(new AbortController().signal)
      )
      // Leaves after the first event the way `break` leaves a `for await` loop.
      const eventIterator = stream[Symbol.asyncIterator]()
      const firstIteration = await eventIterator.next()
      await eventIterator.return?.()

      expect(firstIteration).toEqual({
        done: false,
        value: { type: "text", content: "Hi" }
      })
      await harness.waitForRequestRelease()
    })

    it("ends the stream early and releases the request once the accepted request is cancelled", async () => {
      const harness = createHarness({ kind: "open-reply", texts: ["Hi"] })
      const cancellation = new AbortController()

      const stream = await harness.replyModel.openReplyStream(
        createReplyStreamRequest(cancellation.signal)
      )
      // The reply stays open, so the reading settles only if the
      // cancellation ends the stream; it may end normally or reject.
      const reading = await readReplyStreamCancellingAtFirstEvent(
        stream,
        cancellation
      )

      expect(reading.events).toEqual([{ type: "text", content: "Hi" }])
      await harness.waitForRequestRelease()
    })

    it("completes a request while an overlapping request is cancelled", async () => {
      const { replyModel } = createHarness({
        kind: "finished-reply",
        texts: ["Hi"],
        finishReason: "stop"
      })
      const cancelled = new AbortController()

      const cancelledStream = await replyModel.openReplyStream(
        createReplyStreamRequest(cancelled.signal)
      )
      const completedStream = await replyModel.openReplyStream(
        createReplyStreamRequest(new AbortController().signal)
      )
      cancelled.abort()
      await readReplyStream(cancelledStream)

      expect(await readReplyStream(completedStream)).toEqual({
        events: [
          { type: "text", content: "Hi" },
          { type: "finish", finishReason: "stop" }
        ],
        failure: undefined
      })
    })
  })
}
