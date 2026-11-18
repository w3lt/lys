import * as z from "zod"
import { chatReplyPathParamsSchema } from "./_share"
import { apiChatNotificationRoute, apiChatSpeechRoute } from "./routes"

/**
 * Validates the query of the speech endpoint: which point of the reply to
 * read.
 */
export const chatSpeechQuerySchema = z
  .strictObject({
    /**
     * `start` reads the reply from its first word, even when the reply is
     * finished; `current` starts at the sentence being written and is refused
     * once the reply is no longer being written. Defaults to `start`.
     */
    from: z.enum(["start", "current"]).default("start")
  })
  .readonly()

/** What part of the reply to read, as validated from the query. */
export type ChatSpeechQuery = z.infer<typeof chatSpeechQuerySchema>

/**
 * Describes the WebSocket endpoint that streams one reply as speech audio.
 *
 * @remarks A speech-protocol socket. The client opens it, the backend speaks
 * the reply's text through the voice service, and binary messages carry raw
 * 24 kHz mono 16-bit little-endian PCM until the socket closes. The close
 * code says why the socket closed: `1000` everything was sent, `1001` the
 * backend is shutting down, `1008` the client fell behind, `1011` voice
 * failed or the backend could not read the reply, `4404` no such
 * conversation or reply, `4409` a newer socket replaced this one, `4410` the
 * reply stopped or failed (or, for `current`, is no longer being written),
 * `4503` voice is not ready. Opening a socket closes every older one, for
 * any reply and on either endpoint, because Lys speaks one speech at a time.
 * Changing the method, path, or schemas requires coordinated consumers.
 */
export const chatSpeechApi = Object.freeze({
  method: "GET",
  path: apiChatSpeechRoute,
  params: chatReplyPathParamsSchema,
  querystring: chatSpeechQuerySchema
})

/** Fastify route type for the speech endpoint. */
export type ChatSpeechApiRoute = {
  /** Validated identifiers of the spoken reply. */
  readonly Params: z.infer<typeof chatReplyPathParamsSchema>
  /** Validated point from which to read the reply. */
  readonly Querystring: ChatSpeechQuery
}

/**
 * Describes the WebSocket endpoint that speaks one spoken notification line.
 *
 * @remarks A speech-protocol socket like {@link chatSpeechApi}, but one that
 * speaks a single line announcing that a reply finished, for a reply that
 * ended in the background before Lys said anything. The line is chosen by
 * the backend at random and is never stored. The close codes match
 * {@link chatSpeechApi}; there is no `from` query because the whole line is
 * always spoken.
 */
export const chatNotificationApi = Object.freeze({
  method: "GET",
  path: apiChatNotificationRoute,
  params: chatReplyPathParamsSchema
})

/** Fastify route type for the notification endpoint. */
export type ChatNotificationApiRoute = {
  /** Validated identifiers of the finished reply. */
  readonly Params: z.infer<typeof chatReplyPathParamsSchema>
}
