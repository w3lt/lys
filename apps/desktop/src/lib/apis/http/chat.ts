import {
  chatApi,
  type ChatApiStreamEvent,
  chatApiStreamEventSchema,
  type ChatApiRequestBody
} from "@lys/protocol"
import { EventSourceParserStream } from "eventsource-parser/stream"

export type ChatApiOptions = {
  signal?: AbortSignal
}

export async function* chat(
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

  for await (const message of source) {
    yield chatApiStreamEventSchema.parse(JSON.parse(message.data))
  }
}
