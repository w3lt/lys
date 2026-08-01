import { chatApi, type ChatApiRequestBody } from "@lys/protocol"
import { EventSourceParserStream } from "eventsource-parser/stream"

export type ChatApiOptions = {
  signal?: AbortSignal
}

export const chat = async (
  payload: ChatApiRequestBody,
  { signal }: ChatApiOptions
) => {
  const response = await fetch(chatApi.path, {
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

  return response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new EventSourceParserStream({
      onError: "terminate"
    })
  )
}
