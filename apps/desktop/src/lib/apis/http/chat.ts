import {
  chatApi,
  type ChatApiStreamEvent,
  chatApiStreamEventSchema,
  type ChatApiRequestBody
} from "@lys/protocol"
import { EventSourceParserStream } from "eventsource-parser/stream"

/** Transport options for reading one backend chat event stream. */
export type ChatApiOptions = {
  /** Signal that requests cancellation of the HTTP stream. */
  readonly signal?: AbortSignal
}

/**
 * Opens and reads one validated backend chat event stream.
 *
 * @remarks Ending iteration before the backend closes the stream cancels the
 * underlying reader before releasing it.
 * @param payload - Valid chat prompt and optional conversation identifier.
 * @param options - Optional transport cancellation settings.
 * @returns An async generator yielding validated chat protocol events.
 * @throws If the request, stream read, JSON parse, or event validation fails.
 */
export async function* readChatEvents(
  payload: ChatApiRequestBody,
  options?: ChatApiOptions
): AsyncGenerator<ChatApiStreamEvent, void, unknown> {
  const { signal } = options ?? {}
  const response = await fetch(`http://127.0.0.1:12345${chatApi.path}`, {
    method: chatApi.method,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(payload),
    signal
  })

  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status}`)
  }

  const source = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
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

      yield chatApiStreamEventSchema.parse(JSON.parse(readResult.value.data))
    }
  } finally {
    try {
      if (!hasReachedStreamEnd) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
