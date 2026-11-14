#!/usr/bin/env node
/**
 * A stand-in for the desktop's Tauri host, used by the renderer in Chrome.
 *
 * @remarks The desktop's WKWebView cannot be driven on macOS, so the
 * renderer runs in Chrome with its `invoke` calls forwarded here over
 * HTTP. This host answers every command the renderer invokes the way the
 * Rust host in `apps/desktop/src-tauri` does: it loads and saves
 * `settings.json` in the run's scratch Lys home, writing the defaults when
 * the file is missing, reading a legacy `providers.active` as the one
 * provider on in `providers.enabled`, and saving atomically with owner-only
 * permissions;
 * it starts the real backend from source with `tsx src/index.ts` in its
 * own process group and stops it with `SIGTERM`, then `SIGKILL`; it reports
 * vmo as stopped and refuses to start it; and it lists no client tools.
 * Every invocation is appended to an NDJSON log. Mocking happens only
 * here, at the renderer's IPC boundary; the renderer and backend code paths
 * are unchanged. The Rust host's own behavior is covered by its cargo tests
 * and by the optional native host journey.
 *
 * Usage: `node fake-host.mjs --lys-home <dir> --port-file <path>
 * --backend-log <path> --backend-record <path> --invocation-log <path>
 * --renderer-origin <origin>`.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import {
  isOwnedProcessAlive,
  startOwnedProcess,
  stopOwnedProcess
} from "./lib/processControl.mjs"
import { BACKEND_ROOT, TSX_BINARY } from "./lib/repository.mjs"
import {
  DEFAULT_SETTINGS_DOCUMENT,
  SETTINGS_GROUPS,
  buildSettingsPath,
  isSettingsDocumentShape,
  parseProvidersSettingsGroup,
  readSettingsDocument,
  saveSettingsDocument
} from "./lib/settingsDocument.mjs"

/** Names of the command-line options, all required. */
const OPTION_NAMES = Object.freeze([
  "lys-home",
  "port-file",
  "backend-log",
  "backend-record",
  "invocation-log",
  "renderer-origin"
])

/**
 * Parses the command line.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {Record<string, string>} The options by camel-cased name.
 * @throws If an option is missing.
 */
function parseFakeHostArguments(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: Object.fromEntries(
      OPTION_NAMES.map((name) => [name, { type: "string" }])
    )
  })
  const missing = OPTION_NAMES.filter((name) => !values[name])
  if (missing.length > 0)
    throw new Error(`fake-host.mjs needs --${missing.join(", --")}`)
  return Object.fromEntries(
    OPTION_NAMES.map((name) => [
      name.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
      values[name]
    ])
  )
}

/**
 * The host's mutable state: the backend child it owns, if any.
 *
 * @typedef {object} HostState
 * @property {import("./lib/processControl.mjs").OwnedProcess | undefined} backend -
 * The last backend started.
 * @property {number} invocationCount - Invocations answered so far.
 */

/**
 * Reports the backend's status the way the Rust host does.
 *
 * @param {HostState} state - The host state.
 * @returns {{pid: number | null, running: boolean}} The status.
 */
function buildBackendStatus(state) {
  const running =
    state.backend !== undefined && isOwnedProcessAlive(state.backend)
  return { pid: running ? state.backend.pid : null, running }
}

/**
 * Starts the backend from source unless it is already running.
 *
 * @param {HostState} state - The host state; its backend is replaced.
 * @param {Record<string, string>} options - Lys home, log, and record paths.
 * @returns {Promise<{pid: number | null, running: boolean}>} The status.
 * @throws If the backend cannot be spawned.
 */
async function startBackend(state, options) {
  const current = buildBackendStatus(state)
  if (current.running) return current
  state.backend = await startOwnedProcess({
    role: "backend",
    command: TSX_BINARY,
    args: ["src/index.ts"],
    cwd: BACKEND_ROOT,
    env: { ...process.env, LYS_HOME: options.lysHome },
    logPath: options.backendLog
  })
  writeFileSync(
    options.backendRecord,
    `${JSON.stringify(state.backend, null, 2)}\n`
  )
  return buildBackendStatus(state)
}

/**
 * Stops the backend's process group and reports the stopped status.
 *
 * @param {HostState} state - The host state.
 * @returns {Promise<{pid: null, running: false}>} The stopped status.
 */
async function stopBackend(state) {
  if (state.backend !== undefined) await stopOwnedProcess(state.backend)
  return { pid: null, running: false }
}

/**
 * Reads a stored or sent settings document the way the Rust host reads it.
 *
 * @remarks Every group is present in the host's order; a missing group or
 * field takes its default, and a group the host does not know is dropped.
 * The `providers` group is read on its own, not merged with its default, so
 * a legacy `active` provider turns on that provider alone and is replaced by
 * the `enabled` list.
 * @param {Record<string, unknown>} stored - A document from `settings.json`
 * or from the renderer.
 * @returns {object} The document the host answers with and saves.
 * @throws If the `providers` group breaks the host's rules.
 */
function parseHostSettingsDocument(stored) {
  const document = Object.fromEntries(
    SETTINGS_GROUPS.map((group) => [
      group,
      { ...DEFAULT_SETTINGS_DOCUMENT[group], ...(stored[group] ?? {}) }
    ])
  )
  return {
    ...document,
    providers: parseProvidersSettingsGroup(stored.providers ?? {})
  }
}

/**
 * Loads `settings.json`, writing the defaults when it is missing.
 *
 * @remarks Like the Rust host, an existing file is read, not rewritten: a
 * legacy `active` provider is answered as the `enabled` list but stays in
 * the file until the next save.
 * @param {string} lysHome - The scratch Lys home.
 * @returns {object} The settings document as the host reads it.
 * @throws If the file exists but cannot be parsed, or its `providers` group
 * breaks the host's rules.
 */
function loadSettings(lysHome) {
  const path = buildSettingsPath(lysHome)
  if (!existsSync(path)) saveSettingsDocument(path, DEFAULT_SETTINGS_DOCUMENT)
  return parseHostSettingsDocument(readSettingsDocument(path))
}

/**
 * Saves the settings the renderer sent, filled to a whole document.
 *
 * @param {string} lysHome - The scratch Lys home.
 * @param {unknown} newSettings - The renderer's `newSettings` argument.
 * @returns {null} Nothing, like the Rust command.
 * @throws If the argument is not a settings document, or its `providers`
 * group breaks the host's rules; nothing is written then.
 */
function saveSettings(lysHome, newSettings) {
  if (!isSettingsDocumentShape(newSettings))
    throw new Error("save_settings needs a settings document in newSettings")
  saveSettingsDocument(
    buildSettingsPath(lysHome),
    parseHostSettingsDocument(newSettings)
  )
  return null
}

/**
 * Answers one invoked command.
 *
 * @param {{cmd: string, args: Record<string, unknown>}} invocation - The
 * command and its arguments.
 * @param {HostState} state - The host state.
 * @param {Record<string, string>} options - The parsed options.
 * @returns {Promise<unknown>} The command's value.
 * @throws With the message the renderer receives as the rejection.
 */
async function handleInvocation(invocation, state, options) {
  switch (invocation.cmd) {
    case "load_settings":
      return loadSettings(options.lysHome)
    case "save_settings":
      return saveSettings(options.lysHome, invocation.args?.newSettings)
    case "start_backend":
      return await startBackend(state, options)
    case "stop_backend":
      return await stopBackend(state)
    case "get_backend_status":
      return buildBackendStatus(state)
    case "start_vmo":
      throw new Error(
        "Failed to run vmo: the verification host does not run vmo"
      )
    case "stop_vmo":
    case "get_vmo_status":
      return { status: "stopped" }
    case "get_vmo_health":
      return "not-ready"
    case "list_tools":
      return []
    default:
      throw new Error(
        `The verification host has no command named ${invocation.cmd}`
      )
  }
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
 * Sends one JSON answer with the CORS headers the renderer's origin needs.
 *
 * @param {import("node:http").ServerResponse} response - The response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body, or `undefined` for no body.
 * @param {string} rendererOrigin - The only origin admitted.
 */
function sendJson(response, status, body, rendererOrigin) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": rendererOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin"
  })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

/**
 * Appends one invocation record to the NDJSON log.
 *
 * @param {string} logPath - Absolute path of the log.
 * @param {Record<string, unknown>} record - What was invoked and how it ended.
 */
function appendInvocationRecord(logPath, record) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`)
}

/**
 * Answers `POST /invoke`: runs the command and reports its outcome.
 *
 * @param {{request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, state: HostState, options: Record<string, string>}} exchange -
 * The request, its response, and the host.
 * @returns {Promise<void>} Resolves once answered.
 */
async function handleInvokeRoute({ request, response, state, options }) {
  const startedAt = Date.now()
  const invocation = await readJsonBody(request)
  const record = { at: new Date().toISOString(), cmd: invocation?.cmd }
  state.invocationCount += 1
  try {
    const value = await handleInvocation(invocation ?? {}, state, options)
    appendInvocationRecord(options.invocationLog, {
      ...record,
      ok: true,
      durationMs: Date.now() - startedAt
    })
    sendJson(response, 200, { ok: true, value }, options.rendererOrigin)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendInvocationRecord(options.invocationLog, {
      ...record,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt
    })
    sendJson(
      response,
      200,
      { ok: false, error: message },
      options.rendererOrigin
    )
  }
}

/**
 * Routes one request.
 *
 * @param {{request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, state: HostState, options: Record<string, string>, startedAt: string}} exchange -
 * The request, its response, and the host.
 * @returns {Promise<void>} Resolves once answered.
 */
async function handleHostRequest({
  request,
  response,
  state,
  options,
  startedAt
}) {
  if (request.method === "OPTIONS")
    return sendJson(response, 204, undefined, options.rendererOrigin)
  if (request.method === "POST" && request.url === "/invoke")
    return await handleInvokeRoute({ request, response, state, options })
  if (request.method === "GET" && request.url === "/status") {
    return sendJson(
      response,
      200,
      {
        lysHome: options.lysHome,
        startedAt,
        backend: buildBackendStatus(state),
        backendProcess: state.backend ?? null,
        invocationCount: state.invocationCount
      },
      options.rendererOrigin
    )
  }
  return sendJson(
    response,
    404,
    { error: "No such route" },
    options.rendererOrigin
  )
}

/**
 * Starts the host on a free loopback port and publishes the port.
 *
 * @param {Record<string, string>} options - The parsed options.
 */
function startFakeHost(options) {
  const state = { backend: undefined, invocationCount: 0 }
  const startedAt = new Date().toISOString()
  const server = createServer(async (request, response) => {
    try {
      await handleHostRequest({ request, response, state, options, startedAt })
    } catch (error) {
      sendJson(response, 500, { error: String(error) }, options.rendererOrigin)
    }
  })
  server.listen(0, "127.0.0.1", () => {
    writeFileSync(options.portFile, `${server.address().port}\n`)
  })
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      await stopBackend(state)
      server.close(() => process.exit(0))
    })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  startFakeHost(parseFakeHostArguments(process.argv.slice(2)))
