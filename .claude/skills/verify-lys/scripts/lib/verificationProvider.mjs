/**
 * What the verification provider answers, shared by the fake and the
 * journeys that check what Lys made of it.
 *
 * @remarks The fake stands in for a local Ollama server at the backend's
 * provider boundary: the backend's HTTP client, its settings reader, and
 * its reply model are the real code. A text answer is sent one word at a
 * time with a pause between words, so a streamed reply is observably
 * different from one that arrived whole. The delegation script answers a
 * few messages with a tool call instead, the way a model that uses tools
 * would, so a journey can drive delegation from the person's message to the
 * lead's final answer; every other request gets the fixed reply.
 */

/**
 * Provider the fake answers as: a local Ollama server. The seeded settings
 * turn it on at the fake's address, and every model route and chat request
 * a journey sends names it.
 */
export const VERIFICATION_PROVIDER = "ollama"

/** Model name the fake lists, in Ollama's `name:tag` form. */
export const VERIFICATION_MODEL_NAME = "lys-verify:latest"

/**
 * The fake's model as a chat request names it: its provider and the key
 * that provider lists it under.
 */
export const VERIFICATION_MODEL_REFERENCE = Object.freeze({
  provider: VERIFICATION_PROVIDER,
  modelKey: VERIFICATION_MODEL_NAME
})

/** Context window the fake reports for its model, in tokens. */
export const VERIFICATION_CONTEXT_LENGTH = 8192

/** Text of every streamed reply. */
export const VERIFICATION_REPLY_TEXT =
  "Lys verification reply: the quick brown fox jumps over the lazy dog while every word of this sentence arrives on its own, so a streamed reply can be told apart from one that came all at once."

/** Pause between two streamed words, in milliseconds. */
export const VERIFICATION_TOKEN_INTERVAL_MS = 120

/** Title the fake generates for every conversation. */
export const VERIFICATION_TITLE = "Verification streaming chat"

/**
 * Splits a text answer into the fragments the fake streams, each word with
 * its following space.
 *
 * @param {string} text - The answer's whole text.
 * @returns {string[]} The fragments, which concatenate to the text without
 * its leading whitespace.
 */
export function listReplyFragments(text) {
  return text.match(/\S+\s*/g) ?? []
}

/**
 * Reduces whitespace runs to one space and trims, so rendered text can be
 * compared with the reply text.
 *
 * @param {string} text - Rendered or streamed text.
 * @returns {string} The normalised text.
 */
export function formatComparableText(text) {
  return text.replaceAll(/\s+/g, " ").trim()
}

/** Name of the tool a lead gives work to another agent with. */
export const DELEGATE_WORK_TOOL_NAME = "delegate_work"

/** Name of the tool a job's agent sends its delegator a note with. */
export const REPORT_PROGRESS_TOOL_NAME = "report_progress"

/** The member agent the delegation journey gives work to. */
export const DELEGATION_MEMBER = Object.freeze({
  code: "verify-member",
  name: "Verifier",
  bio: "Takes the verification job.",
  systemPrompt: "You do the job you are given."
})

/** The person's message the lead answers by giving work to the member. */
export const DELEGATION_MESSAGE = "Give the fox sentence to another agent."

/** Title of the job the lead gives the member. */
export const DELEGATION_JOB_TITLE = "Fox report"

/** Instructions of the job, which are all the member is given. */
export const DELEGATION_INSTRUCTIONS = "Write the fox sentence."

/** Progress note the member sends before it writes its result. */
export const DELEGATION_NOTE = "Halfway through the fox sentence."

/** The lead's reply once the job has started. */
export const DELEGATION_INTERIM_TEXT = "One agent is working on it."

/** The lead's reply once the job's reports have woken it. */
export const DELEGATION_FINAL_TEXT = "The fox report is in."

/**
 * First line of the reports block the backend writes before the text of a
 * message that delivers reports to the lead.
 */
export const REPORTS_BLOCK_OPENING = "Reports from the agents you gave work to."

/**
 * What the fake answers to one streamed chat request: a text it streams word
 * by word, or one tool call it streams in a single chunk.
 *
 * @typedef {{kind: "text", text: string} | {kind: "tool-call", name: string, arguments: Readonly<Record<string, unknown>>}} ScriptedAnswer
 */

/**
 * Builds a text answer.
 *
 * @param {string} text - The whole text.
 * @returns {ScriptedAnswer} The frozen answer.
 */
function buildTextAnswer(text) {
  return Object.freeze({ kind: "text", text })
}

/**
 * Builds a tool-call answer.
 *
 * @param {string} name - Name of the called tool.
 * @param {Readonly<Record<string, unknown>>} callArguments - Its arguments,
 * which stay as they are; the answer holds a frozen copy.
 * @returns {ScriptedAnswer} The frozen answer.
 */
function buildToolCallAnswer(name, callArguments) {
  const frozenArguments = Object.freeze({ ...callArguments })
  return Object.freeze({
    kind: "tool-call",
    name,
    arguments: frozenArguments
  })
}

/**
 * Lists the names of the tools a chat request offers the model.
 *
 * @param {unknown} body - The request body.
 * @returns {string[]} The function names in offer order; empty when the
 * request offers no tools.
 */
export function listOfferedToolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string")
}

/**
 * Reads the text of one chat message, whose content is a string or a list
 * of parts.
 *
 * @param {unknown} message - One message of a chat request.
 * @returns {string} The text, with the text parts joined; empty when it has
 * none.
 */
function readMessageText(message) {
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

/**
 * Finds the name of the tool whose call a tool message answers.
 *
 * @param {readonly unknown[]} messages - The request's messages.
 * @param {unknown} toolCallId - The tool message's `tool_call_id`.
 * @returns {string | undefined} The called tool's name from the assistant
 * message that made the call, or `undefined` when no message made it.
 */
function findAnsweredToolName(messages, toolCallId) {
  const toolCall = messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.tool_calls) ? message.tool_calls : []
    )
    .find((call) => call?.id === toolCallId)
  return toolCall?.function?.name
}

/**
 * Picks the answer to a request whose last message is a tool result.
 *
 * @param {readonly unknown[]} messages - The request's messages.
 * @param {unknown} toolCallId - The last message's `tool_call_id`.
 * @returns {ScriptedAnswer | undefined} The lead's interim reply after its
 * `delegate_work` call, the member's result after its `report_progress`
 * call, or `undefined` for a result of any other tool.
 */
function findToolResultAnswer(messages, toolCallId) {
  switch (findAnsweredToolName(messages, toolCallId)) {
    case DELEGATE_WORK_TOOL_NAME:
      return buildTextAnswer(DELEGATION_INTERIM_TEXT)
    case REPORT_PROGRESS_TOOL_NAME:
      return buildTextAnswer(VERIFICATION_REPLY_TEXT)
    default:
      return undefined
  }
}

/**
 * Picks the answer to a request whose last message is a user message.
 *
 * @param {unknown} message - The request's last message.
 * @param {readonly string[]} offeredToolNames - Tools the request offers.
 * @returns {ScriptedAnswer | undefined} A `delegate_work` call for the
 * delegation message while that tool is offered, a `report_progress` call
 * for the job's instructions while that tool is offered, the lead's final
 * reply for a message that delivers reports, or `undefined` for any other
 * message and for a last message that is not a user message.
 */
function findUserMessageAnswer(message, offeredToolNames) {
  if (message?.role !== "user") return undefined
  const text = readMessageText(message)
  if (
    text.includes(DELEGATION_MESSAGE) &&
    offeredToolNames.includes(DELEGATE_WORK_TOOL_NAME)
  )
    return buildToolCallAnswer(DELEGATE_WORK_TOOL_NAME, {
      agent: DELEGATION_MEMBER.code,
      title: DELEGATION_JOB_TITLE,
      instructions: DELEGATION_INSTRUCTIONS
    })
  if (
    text.includes(DELEGATION_INSTRUCTIONS) &&
    offeredToolNames.includes(REPORT_PROGRESS_TOOL_NAME)
  )
    return buildToolCallAnswer(REPORT_PROGRESS_TOOL_NAME, {
      note: DELEGATION_NOTE
    })
  if (text.includes(REPORTS_BLOCK_OPENING))
    return buildTextAnswer(DELEGATION_FINAL_TEXT)
  return undefined
}

/**
 * Picks what the fake answers to one streamed chat request.
 *
 * @param {unknown} body - The request body.
 * @returns {ScriptedAnswer} By the last message and the offered tools only:
 * the delegation script's answer when one applies, otherwise the fixed
 * reply, so every request outside the script is answered as before.
 */
export function findScriptedAnswer(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastMessage = messages.at(-1)
  const scriptedAnswer =
    lastMessage?.role === "tool"
      ? findToolResultAnswer(messages, lastMessage.tool_call_id)
      : findUserMessageAnswer(lastMessage, listOfferedToolNames(body))
  return scriptedAnswer ?? buildTextAnswer(VERIFICATION_REPLY_TEXT)
}
