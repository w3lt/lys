#!/usr/bin/env node
/**
 * A stand-in for a local Ollama server, used as the model provider of a
 * verification run.
 *
 * @remarks The user's machine cannot run a local model, and the backend's
 * provider boundary is HTTP, so this server answers the four Ollama routes
 * the backend's Ollama runtime calls and the OpenAI-compatible chat
 * completion route its reply model streams from. The reply is sent one
 * word at a time with a pause between words, so a streamed reply is
 * observably different from one that arrived whole. Every request is
 * appended to an NDJSON log a journey can read. Mocking happens only here,
 * at the production boundary; the backend code path is unchanged.
 *
 * Usage: `node fake-ollama.mjs --port-file <path> --request-log <path>`.
 * The server listens on a free loopback port and writes it to the port
 * file once it is ready.
 */

import { appendFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import {
  VERIFICATION_CONTEXT_LENGTH,
  VERIFICATION_MODEL_NAME,
  VERIFICATION_REPLY_TEXT,
  VERIFICATION_TITLE,
  VERIFICATION_TOKEN_INTERVAL_MS,
  listReplyFragments
} from "./lib/verificationProvider.mjs"

/**
 * Parses the command line.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {{portFile: string, requestLog: string}} The two file paths.
 * @throws If either path is missing.
 */
function parseFakeOllamaArguments(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "port-file": { type: "string" },
      "request-log": { type: "string" }
    }
  })
  if (!values["port-file"] || !values["request-log"])
    throw new Error(
      "Usage: fake-ollama.mjs --port-file <path> --request-log <path>"
    )
  return { portFile: values["port-file"], requestLog: values["request-log"] }
}

/**
 * Reads a request's whole body as parsed JSON.
 *
 * @param {import("node:http").IncomingMessage} request - The request.
 * @returns {Promise<unknown>} The parsed body, or `undefined` when empty.
 */
async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  return text === "" ? undefined : JSON.parse(text)
}

/**
 * Sends one JSON answer.
 *
 * @param {import("node:http").ServerResponse} response - The response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 */
function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/**
 * Builds Ollama's `/api/tags` answer: one chat model.
 *
 * @returns {object} The model list.
 */
function buildTagsAnswer() {
  return {
    models: [
      {
        name: VERIFICATION_MODEL_NAME,
        model: VERIFICATION_MODEL_NAME,
        size: 1_000_000,
        details: { format: "gguf", family: "llama", parameter_size: "1B" }
      }
    ]
  }
}

/**
 * Builds Ollama's `/api/show` answer for the one model.
 *
 * @returns {object} Capabilities and the context length the backend reads.
 */
function buildShowAnswer() {
  return {
    capabilities: ["completion", "tools"],
    model_info: {
      "general.architecture": "llama",
      "llama.context_length": VERIFICATION_CONTEXT_LENGTH
    }
  }
}

/**
 * Builds Ollama's `/api/ps` answer: the one model is running, so the
 * backend lists it as loaded.
 *
 * @returns {object} The running model list.
 */
function buildRunningAnswer() {
  return {
    models: [
      {
        name: VERIFICATION_MODEL_NAME,
        model: VERIFICATION_MODEL_NAME,
        context_length: VERIFICATION_CONTEXT_LENGTH
      }
    ]
  }
}

/**
 * Builds one streamed chat completion chunk.
 *
 * @param {{model: string, content?: string, finishReason?: string, isFirst?: boolean}} chunk -
 * The fragment, or the finish reason of the last chunk.
 * @returns {string} The `data:` line with its blank-line terminator.
 */
function formatChunk({ model, content, finishReason, isFirst }) {
  const delta = {
    ...(isFirst ? { role: "assistant" } : {}),
    ...(content === undefined ? {} : { content })
  }
  const body = {
    id: "chatcmpl-lys-verify",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(finishReason === undefined
      ? {}
      : {
          usage: { prompt_tokens: 16, completion_tokens: 40, total_tokens: 56 }
        })
  }
  return `data: ${JSON.stringify(body)}\n\n`
}

/**
 * Streams the reply one word at a time, then the stop chunk and `[DONE]`.
 *
 * @param {import("node:http").IncomingMessage} request - The request, whose
 * close stops the stream.
 * @param {import("node:http").ServerResponse} response - The response.
 * @param {string} model - Model name echoed in every chunk.
 */
function sendStreamedReply(request, response, model) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  })
  const fragments = listReplyFragments()
  let index = 0
  const timer = setInterval(() => {
    if (index < fragments.length) {
      response.write(
        formatChunk({ model, content: fragments[index], isFirst: index === 0 })
      )
      index += 1
      return
    }
    clearInterval(timer)
    response.write(formatChunk({ model, finishReason: "stop" }))
    response.end("data: [DONE]\n\n")
  }, VERIFICATION_TOKEN_INTERVAL_MS)
  request.on("close", () => clearInterval(timer))
}

/**
 * Builds a whole chat completion: the title JSON when a response format is
 * requested, else the reply text.
 *
 * @param {string} model - Model name echoed in the answer.
 * @param {boolean} wantsTitle - Whether the request carried a response
 * format, which the backend sends only for title generation.
 * @returns {object} The completion.
 */
function buildCompletion(model, wantsTitle) {
  const content = wantsTitle
    ? JSON.stringify({ title: VERIFICATION_TITLE })
    : VERIFICATION_REPLY_TEXT
  return {
    id: "chatcmpl-lys-verify-whole",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 }
  }
}

/**
 * Reads the last user message's text from a chat request.
 *
 * @param {unknown} body - The request body.
 * @returns {string | undefined} The text, when it is a plain string.
 */
function findLastUserContent(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = [...messages]
    .reverse()
    .find((message) => message?.role === "user")
  return typeof last?.content === "string" ? last.content : undefined
}

/**
 * Appends one request record to the NDJSON log.
 *
 * @param {string} logPath - Absolute path of the log.
 * @param {import("node:http").IncomingMessage} request - The request.
 * @param {unknown} body - Its parsed body.
 */
function appendRequestRecord(logPath, request, body) {
  const record = {
    at: new Date().toISOString(),
    method: request.method,
    path: request.url,
    model: body?.model,
    stream: body?.stream,
    hasResponseFormat: body?.response_format !== undefined,
    messageCount: Array.isArray(body?.messages)
      ? body.messages.length
      : undefined,
    lastUserContent: findLastUserContent(body)
  }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`)
}

/**
 * Answers one request by its method and path.
 *
 * @param {import("node:http").IncomingMessage} request - The request.
 * @param {import("node:http").ServerResponse} response - The response.
 * @param {unknown} body - The parsed body.
 */
function handleProviderRequest(request, response, body) {
  const route = `${request.method} ${request.url}`
  if (route === "GET /api/tags")
    return sendJson(response, 200, buildTagsAnswer())
  if (route === "POST /api/show")
    return sendJson(response, 200, buildShowAnswer())
  if (route === "GET /api/ps")
    return sendJson(response, 200, buildRunningAnswer())
  if (route === "GET /api/version")
    return sendJson(response, 200, { version: "0.0.0-lys-verify" })
  if (route === "POST /v1/chat/completions") {
    const model =
      typeof body?.model === "string" ? body.model : VERIFICATION_MODEL_NAME
    if (body?.stream === true)
      return sendStreamedReply(request, response, model)
    return sendJson(
      response,
      200,
      buildCompletion(model, body?.response_format !== undefined)
    )
  }
  return sendJson(response, 404, { error: `No route for ${route}` })
}

/**
 * Starts the server on a free loopback port and publishes the port.
 *
 * @param {{portFile: string, requestLog: string}} options - Where to write
 * the port and the request log.
 */
function startFakeOllama({ portFile, requestLog }) {
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request)
      appendRequestRecord(requestLog, request, body)
      handleProviderRequest(request, response, body)
    } catch (error) {
      sendJson(response, 500, { error: String(error) })
    }
  })
  server.listen(0, "127.0.0.1", () => {
    writeFileSync(portFile, `${server.address().port}\n`)
  })
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.close(() => process.exit(0)))
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  startFakeOllama(parseFakeOllamaArguments(process.argv.slice(2)))
