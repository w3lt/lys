import * as z from "zod"
import { apiVoiceDictationRoute } from "./routes"

/**
 * Most characters the text of one dictation message may carry, inclusive.
 *
 * @remarks Five minutes of fast speech is under 10,000 characters, so the
 * bound only refuses a message that is not a dictation's text.
 */
export const MAXIMUM_DICTATION_TEXT_LENGTH = 100_000

/**
 * Validates the one text message a client sends on a dictation socket.
 *
 * @remarks `stop` says the person stopped: no more audio follows, and the
 * final text is expected. Audio travels as binary messages, which this
 * schema does not describe.
 */
export const dictationClientMessageSchema = z
  .strictObject({
    /** Says that the person stopped the dictation. */
    type: z.literal("stop")
  })
  .readonly()

/** The text message a client sends on a dictation socket. */
export type DictationClientMessage = z.infer<
  typeof dictationClientMessageSchema
>

/** Validates the recognized text of one dictation message. */
const dictationTextSchema = z.string().max(MAXIMUM_DICTATION_TEXT_LENGTH)

/**
 * Validates a message that carries a dictation's text to the client.
 *
 * @remarks `partial` carries the whole text recognized so far and replaces
 * the previous one; it may correct earlier words. `final` carries the
 * finished text, and the socket then closes with `1000`. An empty text is
 * valid: nothing was recognized.
 */
export const dictationServerMessageSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      /** The whole text so far; more may follow. */
      type: z.literal("partial"),
      /** Everything recognized since the dictation began. */
      text: dictationTextSchema
    })
    .readonly(),
  z
    .strictObject({
      /** The finished text; nothing follows but the close. */
      type: z.literal("final"),
      /** Everything recognized in the dictation. */
      text: dictationTextSchema
    })
    .readonly()
])

/** A message that carries a dictation's text to the client. */
export type DictationServerMessage = z.infer<
  typeof dictationServerMessageSchema
>

/**
 * Describes the WebSocket endpoint that turns one dictation into text.
 *
 * @remarks The client opens the socket, sends binary messages of raw 16 kHz
 * mono 16-bit little-endian PCM, whole samples each, and receives
 * {@link dictationServerMessageSchema} text messages. It ends the dictation
 * with the {@link dictationClientMessageSchema} message; the backend ends it
 * the same way after `DICTATION_MAX_DURATION_MS`. The backend relays to voice
 * and keeps nothing. The close code says why the socket closed: `1000` the
 * final text was sent, `1001` the backend is shutting down, `1002` the client
 * sent a text message that is not a dictation message or audio that is not
 * whole samples, `1009` a client message was longer than
 * `SOCKET_MAX_CLIENT_MESSAGE_BYTES`, `1011` voice
 * failed, fell behind, or sent no final text in time, `4409` a newer
 * dictation socket replaced this one, `4503` voice is not ready. Closing the
 * socket from the client at any time cancels the dictation. Changing the
 * method, path, or schemas requires coordinated consumers.
 */
export const voiceDictationApi = Object.freeze({
  method: "GET",
  path: apiVoiceDictationRoute
})
