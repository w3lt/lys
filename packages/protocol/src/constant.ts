// This file includes every global constant that @lys/protocol needs.

// ============== API ============== //
/**
 * Versioned prefix embedded in every backend API route path.
 *
 * @remarks This value is transmitted in HTTP request paths and is not a
 * persisted data value. It is release-stable across compatible clients;
 * changing it requires coordinated route updates because URL compatibility
 * would otherwise break.
 */
export const API_PREFIX_V1 = "/api/v1"
// ============== API ============== //

// ============== ENV CONFIG ============== //
/**
 * Loopback interface on which the local Lys backend listens.
 *
 * @remarks This host is embedded in local backend URLs and is not persisted.
 * It is release-stable for compatible desktop/backend pairs; changing it
 * requires coordinated endpoint configuration because connection compatibility
 * would otherwise break.
 */
export const BACKEND_HOST = "127.0.0.1"
/**
 * TCP port on which the local Lys backend listens.
 *
 * @remarks This port number is transmitted in local backend URLs and is not
 * persisted. It is release-stable for compatible desktop/backend pairs;
 * changing it requires coordinated endpoint updates because connections would
 * otherwise target different listeners.
 */
export const BACKEND_PORT = 12345
/**
 * Host of LM Studio's default address, used while the person has saved no
 * LM Studio address in Settings.
 *
 * @remarks The backend reaches LM Studio at the saved address, or at this
 * host and {@link LMSTUDIO_PORT}; the desktop shows the pair as the address
 * field's placeholder. It is not persisted: the settings file stores `null`
 * for the default. Changing it moves where Lys looks for LM Studio for every
 * person who saved no address.
 */
export const LMSTUDIO_HOST = "127.0.0.1"
/**
 * Port of LM Studio's default address, paired with {@link LMSTUDIO_HOST}.
 *
 * @remarks Same ownership and persistence as {@link LMSTUDIO_HOST}.
 */
export const LMSTUDIO_PORT = 1234
/**
 * Host of a local Ollama server's default address, used while the person has
 * saved no Ollama address in Settings.
 *
 * @remarks The backend reaches a local Ollama server at the saved address, or
 * at this host and {@link OLLAMA_PORT}; the desktop shows the pair as the
 * address field's placeholder. It is not persisted: the settings file stores
 * `null` for the default. Changing it moves where Lys looks for Ollama for
 * every person who saved no address.
 */
export const OLLAMA_HOST = "127.0.0.1"
/**
 * Port of a local Ollama server's default address, paired with
 * {@link OLLAMA_HOST}.
 *
 * @remarks Same ownership and persistence as {@link OLLAMA_HOST}.
 */
export const OLLAMA_PORT = 11434
/**
 * Loopback interface on which vmo, Lys's page reader, listens.
 *
 * @remarks The backend sends every page read and health check to this host,
 * and the desktop names it on vmo's card. It is not persisted. vmo's
 * `WebServer` in `apps/vmo` declares it again as its default host, and
 * `VMO_ADDRESS` in the desktop's Tauri host, which checks vmo's health, as
 * its host, under an approved CONST-005 exception: Swift and Rust cannot
 * import it. The desktop unit test `vmo-address.test.ts` fails when either
 * copy differs, so changing it requires changing all three together.
 */
export const VMO_HOST = "127.0.0.1"
/**
 * TCP port on which vmo, Lys's page reader, listens.
 *
 * @remarks The backend sends every page read and health check to this port,
 * and the desktop names it on vmo's card. It is not persisted. vmo's
 * `WebServer` in `apps/vmo` declares it again as its default port, and
 * `VMO_ADDRESS` in the desktop's Tauri host as its port, under the same
 * CONST-005 exception as {@link VMO_HOST}, checked by the same test, so
 * changing it requires changing all three together.
 */
export const VMO_PORT = 8080
/**
 * Loopback interface on which voice, Lys's speech service, listens.
 *
 * @remarks The backend sends speech synthesis requests to this host, and the
 * desktop names it on the voice card. It is not persisted. voice's
 * `WebServer` in `apps/voice` declares it again as its default host, and
 * `VOICE_ADDRESS` in the desktop's Tauri host, which checks voice's health,
 * as its host. Those copies are kept under the approved voice address copy
 * exception to CONST-005, like the one of {@link VMO_HOST}; the same kind of
 * test guards it, so changing the host requires changing all three together.
 */
export const VOICE_HOST = "127.0.0.1"
/**
 * TCP port on which voice serves its HTTP health route.
 *
 * @remarks The backend checks this port before asking voice to speak, and
 * the desktop names it on the voice card. It is not persisted. voice's
 * `WebServer` in `apps/voice` declares it again as its default port, and
 * `VOICE_ADDRESS` in the desktop's Tauri host as its port, under the same
 * CONST-005 exception as {@link VOICE_HOST}, so changing it requires
 * changing all three together.
 */
export const VOICE_PORT = 9090
/**
 * TCP port on which voice accepts its job WebSockets.
 *
 * @remarks voice serves only WebSockets carrying one speech or one dictation
 * each on this port, on the same loopback host as {@link VOICE_HOST}. The
 * backend opens one socket per reply, notification, or dictation and is the
 * only client; the desktop never connects to it. voice's
 * `SpeechSocketServer` in `apps/voice` declares it again as its default
 * port, under the same CONST-005 exception as {@link VOICE_HOST}, so
 * changing it requires changing both.
 */
export const VOICE_SOCKET_PORT = 9091
// ============== ENV CONFIG ============== //

// ============== AUDIO ============== //
/**
 * Sample rate of every frame of spoken audio voice, the backend, and the
 * desktop exchange, in samples per second.
 *
 * @remarks voice synthesizes 24 kHz audio, the backend relays its frames
 * unchanged, and the desktop plays them at this rate. It is not persisted.
 * A dictation's audio travels the other way at
 * {@link DICTATION_AUDIO_SAMPLE_RATE_HZ}.
 */
export const VOICE_AUDIO_SAMPLE_RATE_HZ = 24_000
/**
 * Number of audio channels of every audio frame; voice speaks and listens
 * in mono.
 */
export const VOICE_AUDIO_CHANNELS = 1
/**
 * Bytes per audio sample on the wire; samples are signed 16-bit little
 * endian, so an audio frame carries two bytes per sample.
 */
export const VOICE_AUDIO_BYTES_PER_SAMPLE = 2
// ============== AUDIO ============== //

// ============== BACKEND SOCKETS ============== //
/**
 * Most bytes one message a client sends on a backend WebSocket may carry,
 * inclusive: 8 KiB.
 *
 * @remarks A dictation's audio message carries 3,200 bytes, and a speech
 * socket's client sends nothing, so nothing legitimate comes near it. The
 * backend closes a socket that sends a longer message with `1009`. voice
 * accepts messages of up to 16 KiB, so every message the backend relays
 * fits there.
 */
export const SOCKET_MAX_CLIENT_MESSAGE_BYTES = 8_192
// ============== BACKEND SOCKETS ============== //

// ============== SPEECH STREAM ============== //
/**
 * Close code of a speech or notification socket whose audio was fully sent:
 * voice finished speaking everything it was given.
 */
export const SPEECH_CLOSE_COMPLETE = 1000
/**
 * Close code of a speech or notification socket whose backend is shutting
 * down; nothing more is sent.
 *
 * @remarks The backend closes every open WebSocket with this code when it
 * shuts down, so a dictation socket closes with it too, and no final text
 * follows.
 */
export const SPEECH_CLOSE_SHUTDOWN = 1001
/**
 * Close code of a speech or notification socket whose client did not read
 * its audio fast enough, so the audio waiting to be sent outgrew its bound.
 */
export const SPEECH_CLOSE_TOO_SLOW = 1008
/**
 * Close code of a speech or notification socket whose speech failed: voice
 * failed, or the backend could not read the reply. The desktop stops
 * playback and the reply text continues.
 */
export const SPEECH_CLOSE_FAILED = 1011
/**
 * Close code of a speech socket whose conversation or reply does not exist.
 */
export const SPEECH_CLOSE_NO_SUCH_REPLY = 4404
/**
 * Close code of a speech or notification socket superseded by a newer one,
 * for this reply or another, because Lys speaks one speech at a time.
 */
export const SPEECH_CLOSE_SUPERSEDED = 4409
/**
 * Close code of a speech socket whose reply stopped or failed while the
 * socket followed it, or, for a `current` speech, is no longer being
 * written. A stored reply that already stopped or failed is spoken as
 * stored and ends with {@link SPEECH_CLOSE_COMPLETE}.
 */
export const SPEECH_CLOSE_REPLY_ENDED = 4410
/**
 * Close code of a speech or notification socket opened while voice cannot
 * speak, because it is stopped, starting, or broken.
 */
export const SPEECH_CLOSE_VOICE_UNAVAILABLE = 4503
// ============== SPEECH STREAM ============== //

// ============== DICTATION STREAM ============== //
/**
 * Sample rate of a dictation's audio, in samples per second.
 *
 * @remarks The desktop converts the microphone's audio to this rate, the
 * backend relays it unchanged, and voice's recognizer reads it. It is
 * transmitted, never persisted. Samples are mono and
 * {@link VOICE_AUDIO_BYTES_PER_SAMPLE} bytes each, signed little endian.
 * Changing it requires changing voice's recognizer input with it.
 */
export const DICTATION_AUDIO_SAMPLE_RATE_HZ = 16_000
/**
 * Number of samples the desktop sends in one message of a dictation's audio:
 * 100 ms at {@link DICTATION_AUDIO_SAMPLE_RATE_HZ}, which is 3,200 bytes.
 *
 * @remarks The backend and voice accept any whole number of samples, from
 * one up to their message limits, so this is the desktop's choice, not a
 * limit.
 */
export const DICTATION_AUDIO_FRAME_SAMPLES = 1_600
/**
 * Longest time one dictation may listen, in milliseconds: five minutes.
 *
 * @remarks Counted by the backend from the moment the dictation socket
 * opens. A dictation that reaches it ends as if the person had stopped it:
 * the final text is sent and the socket closes with
 * {@link DICTATION_CLOSE_COMPLETE}.
 */
export const DICTATION_MAX_DURATION_MS = 300_000
/**
 * Close code of a dictation socket whose final text was sent.
 */
export const DICTATION_CLOSE_COMPLETE = 1000
/**
 * Close code of a dictation socket whose client sent a text message that is
 * not a dictation message, or audio that is empty or not whole samples.
 */
export const DICTATION_CLOSE_PROTOCOL_ERROR = 1002
/**
 * Close code of a dictation socket whose dictation failed: the handshake
 * with voice failed for another reason than a refusal, voice failed, broke
 * the protocol, or sent no final text in time after the stop, or more audio
 * waited for voice, or more text for the client, than the backend holds.
 * The text sent so far stays valid.
 */
export const DICTATION_CLOSE_FAILED = 1011
/**
 * Close code of a dictation socket superseded by a newer one, because Lys
 * listens to one dictation at a time.
 */
export const DICTATION_CLOSE_SUPERSEDED = 4409
/**
 * Close code of a dictation socket opened while voice cannot listen,
 * because it is stopped, starting, or broken.
 */
export const DICTATION_CLOSE_VOICE_UNAVAILABLE = 4503
// ============== DICTATION STREAM ============== //

// ============== EXTERNAL SERVICES ============== //
/**
 * Host of the Tavily Search API, the only service the `web_search` tool sends
 * queries to.
 *
 * @remarks The backend sends every Tavily request to `https://` followed by
 * this host, and the desktop's approval card names it as where a query goes,
 * so both read this one value. It is not persisted. Changing it changes where
 * queries and the person's Tavily API key are sent and requires a coordinated
 * desktop and backend release.
 */
export const TAVILY_API_HOST = "api.tavily.com"
/**
 * Host of Ollama Cloud, the only place requests for Ollama Cloud's models
 * go.
 *
 * @remarks The backend sends model listings and chat requests, with the
 * person's Ollama API key, to `https://` followed by this host, and the
 * desktop's Providers pane names it as where requests go. It is not
 * persisted. Changing it changes where conversations and the key are sent
 * and requires a coordinated desktop and backend release.
 */
export const OLLAMA_CLOUD_API_HOST = "ollama.com"
/**
 * Host of Groq's API, the only place requests for Groq's models go.
 *
 * @remarks The backend sends model listings and chat requests, with the
 * person's Groq API key, to `https://` followed by this host, and the
 * desktop's Providers pane names it as where requests go. It is not
 * persisted. Changing it changes where conversations and the key are sent
 * and requires a coordinated desktop and backend release.
 */
export const GROQ_API_HOST = "api.groq.com"
// ============== EXTERNAL SERVICES ============== //

// ============== TOOL APPROVAL ============== //
/**
 * Whole minutes an approval prompt waits for the person's answer before it
 * expires.
 *
 * @remarks The limit is exclusive: an answer is taken only while fewer than
 * this many minutes have passed since the backend sent the prompt. At the
 * limit the backend ends the prompt, refuses its token, and stores the call
 * as failed with a sentence naming the limit, which the model reads; the
 * desktop names the same limit when it tells the person the prompt expired.
 * It is not persisted. Changing it changes how long a reply waits for the
 * person and requires a coordinated desktop and backend release.
 */
export const TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES = 5
// ============== TOOL APPROVAL ============== //
