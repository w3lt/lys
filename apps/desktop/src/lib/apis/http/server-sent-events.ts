import { EventSourceParserStream } from "eventsource-parser/stream"

/**
 * Reads validated events from one SSE response body.
 *
 * @typeParam TStreamEvent - Validated event union of the endpoint.
 * @param body - Response body; this reader owns it from now on.
 * @param parseEvent - Authoritative schema parser for one event payload.
 * @returns An async generator yielding events until the backend closes the
 * stream.
 * @throws If reading, JSON parsing, or event validation fails.
 * @remarks Ending iteration before the backend closes the stream cancels the
 * body before releasing it.
 */
export async function* readServerSentEvents<TStreamEvent>(
  body: NonNullable<Response["body"]>,
  parseEvent: (value: unknown) => TStreamEvent
): AsyncGenerator<TStreamEvent, void, unknown> {
  const source = body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new EventSourceParserStream({
      onError: "terminate"
    })
  )
  const reader = source.getReader()
  let hasReachedStreamEnd = false

  try {
    while (true) {
      const readResult = await reader.read()
      if (readResult.done) {
        hasReachedStreamEnd = true
        return
      }

      yield parseEvent(JSON.parse(readResult.value.data))
    }
  } finally {
    try {
      if (!hasReachedStreamEnd) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
