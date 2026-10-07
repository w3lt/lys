import type { ConversationAssistantMessageFinishReason } from "@lys/share"
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam
} from "openai/resources/index.mjs"
import type {
  ReplyModel,
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../agent/replyModel"
import type { CompleteChatOptions } from "./chatService"

/** Starts a streamed chat completion; the returned iterator owns upstream cleanup. */
type CompleteChatStream = (
  options: CompleteChatOptions
) => Promise<AsyncIterable<ChatCompletionChunk>>

/**
 * Translates a borrowed OpenAI-compatible streamed chat completion into agent
 * reply streams.
 *
 * @remarks Implements {@link ReplyModel}. Only the choice with index 0 is
 * used; a chunk without it is skipped, and empty or absent text produces no
 * event. Owns no resource: the chat completion's owner releases its client.
 * Concurrency model: reentrant; it keeps no state and the chat completion
 * permits overlapping requests.
 */
export default class OpenAiReplyModel implements ReplyModel {
  /** Borrowed streamed chat completion of the backend's chat service. */
  readonly #completeChatStream: CompleteChatStream

  /**
   * Creates the adapter without contacting the endpoint.
   * @param completeChatStream - Streamed chat completion lent for the
   * adapter's lifetime.
   */
  public constructor(completeChatStream: CompleteChatStream) {
    this.#completeChatStream = completeChatStream
  }

  /**
   * Implements {@link ReplyModel.openReplyStream}.
   * @param request - Interface-defined request; its signal cancels the
   * completion request and stream.
   * @returns The interface-defined stream; leaving it early releases the
   * completion stream.
   * @throws The chat completion's failures unchanged, including
   * `ChatCompletionCancelledError`; the stream rejects with
   * `Unsupported chat finish reason` for a finish reason other than `stop` or
   * `length`.
   */
  public async openReplyStream(
    request: ReplyStreamRequest
  ): Promise<AsyncIterable<ReplyStreamEvent>> {
    const chunks = await this.#completeChatStream({
      messages: request.messages.map(
        ({ role, content }): ChatCompletionMessageParam => ({ role, content })
      ),
      model: request.model,
      generationOptions: request.generationOptions,
      signal: request.abortSignal
    })
    return parseReplyStreamEvents(chunks)
  }
}

/**
 * Translates streamed chat completion chunks into reply events.
 *
 * @param chunks - Upstream chunks, owned by the returned stream.
 * @returns Text and finish events in chunk order; a chunk carrying both text
 * and a finish reason yields the text first. Leaving the iteration early
 * releases the chunks.
 * @throws If the upstream fails, or a chunk carries an unsupported finish
 * reason.
 */
async function* parseReplyStreamEvents(
  chunks: AsyncIterable<ChatCompletionChunk>
): AsyncGenerator<ReplyStreamEvent, void, undefined> {
  for await (const chunk of chunks) {
    const choice = chunk.choices.find(({ index }) => index === 0)
    if (choice === undefined) continue
    const content = choice.delta.content
    if (content) yield { type: "text", content }
    const finishReason = choice.finish_reason
    if (finishReason)
      yield { type: "finish", finishReason: parseFinishReason(finishReason) }
  }
}

/**
 * Accepts the finish reasons a reply can be stored with.
 *
 * @param finishReason - Upstream reason the choice ended.
 * @returns The same reason when it is `stop` or `length`.
 * @throws `Unsupported chat finish reason` for any other reason, such as
 * `tool_calls`.
 */
function parseFinishReason(
  finishReason: NonNullable<ChatCompletionChunk.Choice["finish_reason"]>
): ConversationAssistantMessageFinishReason {
  if (finishReason !== "stop" && finishReason !== "length")
    throw new Error("Unsupported chat finish reason")
  return finishReason
}
