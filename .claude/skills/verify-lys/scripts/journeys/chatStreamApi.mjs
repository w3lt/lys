/**
 * Journey: a chat turn over the API streams the reply as timed events, the
 * backend stores it with its model's provider, and the provider saw one
 * streamed reply request and one title request.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readServerSentEvents, sendJsonRequest } from "../lib/httpProbe.mjs"
import { rejectUnless } from "../lib/journey.mjs"
import { readConversationRows } from "../lib/sqliteEvidence.mjs"
import {
  VERIFICATION_MODEL_NAME,
  VERIFICATION_MODEL_REFERENCE,
  VERIFICATION_PROVIDER,
  VERIFICATION_REPLY_TEXT,
  VERIFICATION_TITLE,
  formatComparableText
} from "../lib/verificationProvider.mjs"
import { waitForCondition } from "../lib/waiting.mjs"

/** The user message every chat journey sends. */
export const VERIFICATION_MESSAGE = "Please stream a short verification reply."

/** Fewest delta events a streamed reply must arrive in. */
const MINIMUM_DELTA_COUNT = 10

/** Shortest spread between first and last delta, in milliseconds. */
const MINIMUM_SPREAD_MS = 1000

/**
 * Builds the chat request body for a new conversation with the default
 * agent.
 *
 * @param {{provider: string, modelKey: string}} model - The model's
 * provider and the key that provider lists it under.
 * @returns {object} The request body.
 */
export function buildChatRequestBody(model) {
  return {
    conversation: { kind: "new", agentCode: "caliginia" },
    message: VERIFICATION_MESSAGE,
    model,
    generationOptions: { temperature: 0.7, replyCeiling: 2048 }
  }
}

/**
 * Reads every event of one chat turn.
 *
 * @param {string} backendUrl - The backend origin.
 * @param {{provider: string, modelKey: string}} model - The model's
 * provider and key.
 * @returns {Promise<import("../lib/httpProbe.mjs").TimedServerSentEvent[]>}
 * The events in arrival order, each with its arrival time.
 */
async function readChatTurnEvents(backendUrl, model) {
  const events = []
  for await (const event of readServerSentEvents(`${backendUrl}/api/v1/chat`, {
    method: "POST",
    json: buildChatRequestBody(model),
    timeoutMs: 60_000
  }))
    events.push(event)
  return events
}

/**
 * Checks the shape and timing of a turn's events.
 *
 * @param {import("../lib/httpProbe.mjs").TimedServerSentEvent[]} events - The
 * turn's events.
 * @returns {Record<string, unknown>} The facts the later steps use.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the turn did not
 * stream, complete, or get its title.
 */
function parseChatTurn(events) {
  const types = events.map((event) => event.data?.type)
  const start = events[0]
  rejectUnless(
    start?.data?.type === "start-new-conversation-turn",
    "The first event must be start-new-conversation-turn.",
    types
  )
  const textPart = events.find(
    (event) =>
      event.data?.type === "reply-part" && event.data.part?.kind === "text"
  )
  rejectUnless(
    textPart !== undefined,
    "A reply-part event must open the text part.",
    types
  )
  const deltas = events.filter(
    (event) =>
      event.data?.type === "reply-part-delta" &&
      event.data.partId === textPart.data.part.id
  )
  rejectUnless(
    deltas.length >= MINIMUM_DELTA_COUNT,
    `The reply must arrive in at least ${MINIMUM_DELTA_COUNT} reply-part-delta events.`,
    { deltaCount: deltas.length, types }
  )
  const spreadMs = deltas.at(-1).atMs - textPart.atMs
  rejectUnless(
    spreadMs >= MINIMUM_SPREAD_MS,
    `The fragments must be spread over at least ${MINIMUM_SPREAD_MS} ms, which proves the reply streamed.`,
    { spreadMs }
  )
  // The text part opens with its first fragment; every later fragment is a delta.
  const text =
    textPart.data.part.content +
    deltas.map((delta) => delta.data.content).join("")
  rejectUnless(
    formatComparableText(text) ===
      formatComparableText(VERIFICATION_REPLY_TEXT),
    "The text part's opening content plus its deltas must equal the provider's reply.",
    text
  )
  const done = events.find((event) => event.data?.type === "done")
  rejectUnless(
    done?.data.finishReason === "stop",
    "A done event with finishReason stop must end the reply.",
    done ?? types
  )
  const title = events.find((event) => event.data?.type === "title")
  rejectUnless(
    title?.data.title === VERIFICATION_TITLE,
    "A title event must carry the generated title.",
    title ?? types
  )
  return {
    conversationId: start.data.conversation.id,
    assistantMessageId: start.data.assistantMessage.id,
    textPartId: textPart.data.part.id,
    openingContent: textPart.data.part.content,
    deltaCount: deltas.length,
    textPartAtMs: textPart.atMs,
    firstDeltaAtMs: deltas[0].atMs,
    lastDeltaAtMs: deltas.at(-1).atMs,
    spreadMs,
    eventTypes: types
  }
}

/**
 * Reports whether a stored reply names the model the journey sent its turn
 * to: the verification model's key on the verification provider.
 *
 * @param {{model?: unknown, provider?: unknown} | undefined} reply - The
 * conversation route's assistant message or its SQLite row.
 * @returns {boolean} `true` when both the model key and the provider match.
 */
function isVerificationModelReply(reply) {
  return (
    reply?.model === VERIFICATION_MODEL_NAME &&
    reply.provider === VERIFICATION_PROVIDER
  )
}

/**
 * Reads the provider's request log entries written after a time.
 *
 * @param {string} logPath - The NDJSON request log.
 * @param {string} sinceIso - ISO time; earlier entries are skipped.
 * @returns {object[]} The chat completion requests, oldest first.
 */
function listProviderChatRequests(logPath, sinceIso) {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .filter(
      (entry) => entry.at >= sinceIso && entry.path === "/v1/chat/completions"
    )
}

/**
 * Sends a new conversation's chat turn to the verification model and checks
 * how its reply streamed: the step "POST /api/v1/chat streams a new
 * conversation's reply".
 *
 * @param {string} backendUrl - The backend origin.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder; the turn's events are saved as `events.json` and the facts
 * {@link parseChatTurn} finds in them as `timeline.json`.
 * @returns {Promise<Record<string, unknown>>} The turn's facts, the step's
 * detail, which the later steps read.
 * @throws If the chat request fails or its stream cannot be read.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the turn did not
 * stream, complete, or get its title.
 */
async function sendVerificationChatTurn(backendUrl, evidence) {
  const events = await readChatTurnEvents(
    backendUrl,
    VERIFICATION_MODEL_REFERENCE
  )
  evidence.saveJson("events.json", events)
  const facts = parseChatTurn(events)
  evidence.saveJson("timeline.json", facts)
  return facts
}

/**
 * Waits until the conversation route returns a conversation with its reply
 * finished, then checks the stored title, reply text, and reply model: the
 * step "GET /api/v1/conversations/:id returns the stored reply, its
 * provider, and the title".
 *
 * @param {string} backendUrl - The backend origin.
 * @param {string} conversationId - The conversation the journey's turn
 * started.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder; the conversation is saved as `conversation.json`.
 * @returns {Promise<Record<string, unknown>>} The stored title, the reply's
 * provider, and the number of messages, the step's detail.
 * @throws {import("../lib/waiting.mjs").WaitTimeoutError} If the route
 * does not return the reply finished within 10 seconds.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If the stored title,
 * the reply text, or the reply's model and provider are not the turn's.
 */
async function getStoredConversationReply(
  backendUrl,
  conversationId,
  evidence
) {
  const url = `${backendUrl}/api/v1/conversations/${conversationId}`
  const conversation = await waitForCondition({
    description: "the stored assistant message to be finished",
    timeoutMs: 10_000,
    check: async () => {
      const exchange = await sendJsonRequest(url)
      const assistant = exchange.body?.messages?.find(
        (message) => message.role === "assistant"
      )
      return assistant?.finishReason === "stop" ? exchange.body : false
    }
  })
  evidence.saveJson("conversation.json", conversation)
  const assistant = conversation.messages.find(
    (message) => message.role === "assistant"
  )
  const textPart = assistant.parts.find((part) => part.kind === "text")
  rejectUnless(
    conversation.title === VERIFICATION_TITLE,
    "The stored title must be the generated one.",
    conversation.title
  )
  rejectUnless(
    textPart !== undefined &&
      formatComparableText(textPart.content) ===
        formatComparableText(VERIFICATION_REPLY_TEXT),
    "The stored text part must hold the whole reply.",
    assistant.parts
  )
  rejectUnless(
    isVerificationModelReply(assistant),
    `The stored reply must name ${VERIFICATION_MODEL_NAME} on ${VERIFICATION_PROVIDER} as its model.`,
    { model: assistant.model, provider: assistant.provider }
  )
  return {
    title: conversation.title,
    provider: assistant.provider,
    messageCount: conversation.messages.length
  }
}

/**
 * Reads the SQLite rows of the journey's conversation and checks that they
 * hold its title, the reply text under the turn's assistant message, and the
 * reply's model and provider: the step "the SQLite rows hold the
 * conversation, its title, the reply text, and the reply's provider".
 *
 * @param {string} lysHome - The run's Lys home, which holds `lys_db.sqlite`.
 * @param {{conversationId: string, assistantMessageId: string}} turn - The
 * conversation and the assistant message the journey's turn created.
 * @param {import("../lib/journey.mjs").EvidenceRecorder} evidence - The
 * step's recorder; the rows are saved as `sqlite-rows.json`.
 * @returns {Promise<Record<string, unknown>>} The conversation row, the
 * reply text row's role, the reply's provider, and the number of message
 * rows, the step's detail.
 * @throws If the database cannot be opened or its tables are missing.
 * @throws {import("../lib/journey.mjs").JourneyFailure} If a row is missing,
 * or the rows do not hold the turn's title, reply text, model, or provider.
 */
async function getStoredReplyRows(lysHome, turn, evidence) {
  const rows = readConversationRows(
    join(lysHome, "lys_db.sqlite"),
    turn.conversationId
  )
  evidence.saveJson("sqlite-rows.json", rows)
  rejectUnless(
    rows.conversation !== undefined,
    "The conversations table must hold the conversation.",
    rows
  )
  rejectUnless(
    rows.conversation.title === VERIFICATION_TITLE,
    "The stored title row must be the generated title.",
    rows.conversation
  )
  const replyRow = rows.messages.find(
    (row) =>
      typeof row.content === "string" &&
      formatComparableText(row.content) ===
        formatComparableText(VERIFICATION_REPLY_TEXT)
  )
  rejectUnless(
    replyRow !== undefined,
    "A message row must hold the whole reply text.",
    rows.messages
  )
  rejectUnless(
    replyRow.reply_id === turn.assistantMessageId,
    "The reply text row must belong to the turn's assistant message.",
    { replyRow, assistantMessageId: turn.assistantMessageId }
  )
  const assistantRow = rows.messages.find(
    (row) => row.id === turn.assistantMessageId
  )
  rejectUnless(
    isVerificationModelReply(assistantRow),
    `The assistant message row must store ${VERIFICATION_MODEL_NAME} as its model and ${VERIFICATION_PROVIDER} as its provider.`,
    assistantRow ?? rows.messages
  )
  return {
    conversationRow: rows.conversation,
    replyRole: replyRow.role,
    replyProvider: assistantRow.provider,
    rowCount: rows.messages.length
  }
}

export default Object.freeze({
  id: "chat-stream-api",
  feature: "chat-streaming",
  title:
    "POST /api/v1/chat streams the reply as a reply-part event followed by timed reply-part-delta events, ending in done and a title; the conversation route and the SQLite rows hold the same reply with its model's provider; the provider saw one streamed reply request and one title request",
  needsRenderer: false,
  needsNative: false,
  async run(steps, context) {
    const startedAt = new Date().toISOString()
    const turn = await steps.step(
      "POST /api/v1/chat streams a new conversation's reply",
      (evidence) => sendVerificationChatTurn(context.backendUrl, evidence)
    )
    await steps.step(
      "GET /api/v1/conversations/:id returns the stored reply, its provider, and the title",
      (evidence) =>
        getStoredConversationReply(
          context.backendUrl,
          turn.conversationId,
          evidence
        )
    )
    await steps.step(
      "the SQLite rows hold the conversation, its title, the reply text, and the reply's provider",
      (evidence) => getStoredReplyRows(context.paths.lysHome, turn, evidence)
    )
    await steps.step(
      "the provider saw one streamed reply request and one title request",
      async (evidence) => {
        const requests = listProviderChatRequests(
          join(context.paths.logsDir, "provider-requests.ndjson"),
          startedAt
        )
        evidence.saveJson("provider-requests.json", requests)
        const replies = requests.filter((entry) => entry.stream === true)
        const titles = requests.filter(
          (entry) => entry.stream !== true && entry.hasResponseFormat
        )
        rejectUnless(
          replies.length === 1,
          "Exactly one streamed chat completion must have been requested.",
          requests
        )
        rejectUnless(
          titles.length === 1,
          "Exactly one title completion with a response format must have been requested.",
          requests
        )
        rejectUnless(
          replies[0].lastUserContent === VERIFICATION_MESSAGE,
          "The reply request must carry the user message.",
          replies[0]
        )
        return { replyRequests: replies.length, titleRequests: titles.length }
      }
    )
  }
})
