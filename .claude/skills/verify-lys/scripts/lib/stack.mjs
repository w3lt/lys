/**
 * Launching, checking, and stopping the verification stack of one run.
 *
 * @remarks The stack is, in start order: the fake Ollama provider, the
 * seeded scratch Lys home, the fake Tauri host, the real backend the host
 * starts from source, the real renderer served by Vite on port 1420, and
 * Chrome with a DevTools endpoint. Every process is recorded in `run.json`
 * as it starts, so a launch that fails half-way can still be cleaned up.
 * The backend's port is fixed, so a launch refuses to start while anything
 * listens on it or on the renderer's port.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync
} from "node:fs"
import { join } from "node:path"
import { CdpConnection, waitForDevToolsEndpoint } from "./cdp.mjs"
import { isPortOpen, sendJsonRequest } from "./httpProbe.mjs"
import {
  isOwnedProcessAlive,
  listListeningPids,
  startOwnedProcess,
  stopOwnedProcess
} from "./processControl.mjs"
import { RendererPage } from "./rendererPage.mjs"
import { waitForComposerReady } from "./rendererSteps.mjs"
import {
  BACKEND_PORT,
  BACKEND_URL,
  CHROME_BINARY,
  DESKTOP_ROOT,
  RENDERER_PORT,
  RENDERER_URL,
  SKILL_ROOT,
  VITE_BINARY,
  listMissingTools,
  readRepositoryState
} from "./repository.mjs"
import { readJsonDocument, saveJsonDocument } from "./runRecord.mjs"
import {
  buildSeededSettingsDocument,
  buildSettingsPath,
  saveSettingsDocument
} from "./settingsDocument.mjs"
import { waitForCondition } from "./waiting.mjs"

/** The fake provider script. */
const FAKE_OLLAMA_SCRIPT = join(SKILL_ROOT, "scripts/fake-ollama.mjs")

/** The fake host script. */
const FAKE_HOST_SCRIPT = join(SKILL_ROOT, "scripts/fake-host.mjs")

/** Deadline for the backend's first health answer, in milliseconds. */
const HEALTH_TIMEOUT_MS = 30_000

/** Deadline for Vite's first page, in milliseconds. */
const RENDERER_TIMEOUT_MS = 60_000

/** Deadline for the renderer's first usable composer, in milliseconds. */
const WARM_UP_TIMEOUT_MS = 90_000

/** Name of the file the host writes with the backend's identity. */
const BACKEND_RECORD_FILE = "backend-process.json"

/**
 * Refuses to launch while either fixed port is taken.
 *
 * @returns {Promise<void>} Resolves when both ports are free.
 * @throws If something listens on the backend's or the renderer's port.
 */
async function refuseBusyPorts() {
  for (const port of [BACKEND_PORT, RENDERER_PORT]) {
    if (await isPortOpen(port)) {
      throw new Error(
        `Port ${port} is in use (pids ${listListeningPids(port).join(", ") || "unknown"}). The stack refuses to double-drive it; stop that instance or run cleanup first.`
      )
    }
  }
}

/**
 * Waits for a server to write its port file.
 *
 * @param {string} path - The port file.
 * @param {string} role - Who writes it, for the time-out message.
 * @returns {Promise<number>} The port.
 * @throws If the file does not appear in 10 seconds.
 */
function waitForPortFile(path, role) {
  return waitForCondition({
    description: `the ${role} to publish its port`,
    timeoutMs: 10_000,
    intervalMs: 100,
    check: () => {
      if (!existsSync(path)) return false
      const port = Number(readFileSync(path, "utf8").trim())
      return Number.isInteger(port) && port > 0 ? port : false
    }
  })
}

/**
 * Starts the fake provider and records its address.
 *
 * @param {import("./runRecord.mjs").RunPaths} paths - The run's paths.
 * @param {Record<string, any>} record - The run record, updated in place.
 * @returns {Promise<void>} Resolves once the provider listens.
 */
async function startProvider(paths, record) {
  const portFile = join(paths.stateDir, "provider.port")
  record.processes.provider = await startOwnedProcess({
    role: "provider",
    command: process.execPath,
    args: [
      FAKE_OLLAMA_SCRIPT,
      "--port-file",
      portFile,
      "--request-log",
      join(paths.logsDir, "provider-requests.ndjson")
    ],
    cwd: SKILL_ROOT,
    env: process.env,
    logPath: join(paths.logsDir, "provider.log")
  })
  const port = await waitForPortFile(portFile, "provider")
  record.providerAddress = `127.0.0.1:${port}`
  record.urls.provider = `http://${record.providerAddress}`
}

/**
 * Starts the fake host and records its URL.
 *
 * @param {import("./runRecord.mjs").RunPaths} paths - The run's paths.
 * @param {Record<string, any>} record - The run record, updated in place.
 * @returns {Promise<void>} Resolves once the host listens.
 */
async function startHost(paths, record) {
  const portFile = join(paths.stateDir, "host.port")
  record.processes.host = await startOwnedProcess({
    role: "host",
    command: process.execPath,
    args: [
      FAKE_HOST_SCRIPT,
      "--lys-home",
      paths.lysHome,
      "--port-file",
      portFile,
      "--backend-log",
      join(paths.logsDir, "backend-stdout.log"),
      "--backend-record",
      join(paths.stateDir, BACKEND_RECORD_FILE),
      "--invocation-log",
      join(paths.logsDir, "host-invocations.ndjson"),
      "--renderer-origin",
      RENDERER_URL
    ],
    cwd: SKILL_ROOT,
    env: process.env,
    logPath: join(paths.logsDir, "host.log")
  })
  const port = await waitForPortFile(portFile, "host")
  record.urls.host = `http://127.0.0.1:${port}`
}

/**
 * Waits for the backend's health route to answer.
 *
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<unknown>} The health body.
 * @throws If the route does not answer `{ok: true}` in time.
 */
export function waitForBackendHealth(timeoutMs) {
  return waitForCondition({
    description: "the backend's health route to answer {ok: true}",
    timeoutMs,
    check: async () => {
      const exchange = await sendJsonRequest(`${BACKEND_URL}/api/v1/heath`, {
        timeoutMs: 2000
      })
      return exchange.body?.ok === true ? exchange.body : false
    }
  })
}

/**
 * Asks the host to start the backend, as the renderer does, and waits for
 * its health route.
 *
 * @param {Record<string, any>} record - The run record with the host URL.
 * @returns {Promise<void>} Resolves once the backend answers.
 * @throws If the host refuses or the backend does not answer in time.
 */
async function startBackendThroughHost(record) {
  const exchange = await sendJsonRequest(`${record.urls.host}/invoke`, {
    method: "POST",
    json: { cmd: "start_backend", args: {} }
  })
  if (exchange.body?.ok !== true)
    throw new Error(
      `The host could not start the backend: ${JSON.stringify(exchange.body)}`
    )
  await waitForBackendHealth(HEALTH_TIMEOUT_MS)
}

/**
 * Starts Vite on the renderer's fixed port and waits for its first page.
 *
 * @param {import("./runRecord.mjs").RunPaths} paths - The run's paths.
 * @param {Record<string, any>} record - The run record, updated in place.
 * @returns {Promise<void>} Resolves once `GET /` answers 200.
 */
async function startRenderer(paths, record) {
  record.processes.renderer = await startOwnedProcess({
    role: "renderer",
    command: VITE_BINARY,
    args: ["--port", String(RENDERER_PORT), "--strictPort"],
    cwd: DESKTOP_ROOT,
    env: process.env,
    logPath: join(paths.logsDir, "renderer.log")
  })
  await waitForCondition({
    description: "Vite to serve the renderer",
    timeoutMs: RENDERER_TIMEOUT_MS,
    check: async () => {
      const response = await fetch(RENDERER_URL, {
        signal: AbortSignal.timeout(2000)
      })
      return response.status === 200
    }
  })
}

/**
 * Starts headless Chrome with a scratch profile and records its DevTools
 * endpoint.
 *
 * @param {import("./runRecord.mjs").RunPaths} paths - The run's paths.
 * @param {Record<string, any>} record - The run record, updated in place.
 * @returns {Promise<void>} Resolves once the endpoint is published.
 */
async function startChrome(paths, record) {
  record.processes.chrome = await startOwnedProcess({
    role: "chrome",
    command: CHROME_BINARY,
    args: [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${paths.chromeProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--window-size=1180,820",
      "about:blank"
    ],
    cwd: paths.stateDir,
    env: process.env,
    logPath: join(paths.logsDir, "chrome.log")
  })
  record.urls.devTools = await waitForDevToolsEndpoint(
    paths.chromeProfile,
    20_000
  )
}

/**
 * Opens the renderer once so Vite finishes its dependency work before a
 * journey starts, and proves the stack is usable: the composer accepts a
 * message for the default agent.
 *
 * @param {Record<string, any>} record - The run record, updated in place.
 * @returns {Promise<void>} Resolves once the composer was ready.
 * @throws If the composer is not ready within the warm-up deadline.
 */
async function warmUpRenderer(record) {
  const connection = await CdpConnection.open(record.urls.devTools)
  try {
    const page = await RendererPage.open({
      connection,
      url: RENDERER_URL,
      hostUrl: record.urls.host
    })
    const placeholder = await waitForComposerReady(page, WARM_UP_TIMEOUT_MS)
    record.warmUp = { placeholder, at: new Date().toISOString() }
    await page.close()
  } finally {
    connection.close()
  }
}

/**
 * Launches the whole stack for a run.
 *
 * @param {import("./runRecord.mjs").RunPaths} paths - The run's paths; its
 * directories exist.
 * @returns {Promise<Record<string, any>>} The run record, also saved as
 * `run.json`, with status `running`.
 * @throws If a tool is missing, a port is busy, or a part does not become
 * ready; the record then has status `launch-failed` and lists the processes
 * that did start.
 */
export async function launchStack(paths) {
  const missing = listMissingTools()
  if (missing.length > 0)
    throw new Error(`Missing tools: ${missing.join(", ")}`)
  await refuseBusyPorts()
  const repository = readRepositoryState()
  const record = {
    id: paths.id,
    status: "launching",
    startedAt: new Date().toISOString(),
    head: repository.head,
    dirtyFiles: repository.dirtyFiles,
    paths,
    urls: { backend: BACKEND_URL, renderer: RENDERER_URL },
    processes: {}
  }
  const save = () => saveJsonDocument(paths.recordPath, record)
  save()
  try {
    await startProvider(paths, record)
    save()
    saveSettingsDocument(
      buildSettingsPath(paths.lysHome),
      buildSeededSettingsDocument(record.providerAddress)
    )
    await startHost(paths, record)
    save()
    await startBackendThroughHost(record)
    await startRenderer(paths, record)
    save()
    await startChrome(paths, record)
    save()
    await warmUpRenderer(record)
    record.status = "running"
    record.readyAt = new Date().toISOString()
  } catch (error) {
    record.status = "launch-failed"
    record.launchError = error instanceof Error ? error.message : String(error)
    save()
    throw error
  }
  save()
  return record
}

/**
 * Stops one recorded process, if the record has it.
 *
 * @param {Record<string, any>} record - The run record.
 * @param {string} role - Process role.
 * @returns {Promise<string>} How it ended, or `not-started`.
 */
async function stopRecordedProcess(record, role) {
  const owned = record.processes?.[role]
  if (owned === undefined) return "not-started"
  return await stopOwnedProcess(owned)
}

/**
 * Stops a backend the host started but could not stop, using the identity
 * the host recorded for it.
 *
 * @param {Record<string, any>} record - The run record.
 * @returns {Promise<string>} How it ended, or `not-recorded`.
 */
async function stopOrphanBackend(record) {
  const path = join(record.paths.stateDir, BACKEND_RECORD_FILE)
  if (!existsSync(path)) return "not-recorded"
  return await stopOwnedProcess(readJsonDocument(path))
}

/**
 * Stops every process the run started, newest first, and reports how each
 * ended.
 *
 * @param {Record<string, any>} record - The run record.
 * @returns {Promise<Record<string, unknown>>} One outcome per role, plus
 * whether both fixed ports are closed afterwards.
 */
export async function stopStack(record) {
  const outcomes = {}
  outcomes.chrome = await stopRecordedProcess(record, "chrome")
  outcomes.renderer = await stopRecordedProcess(record, "renderer")
  outcomes.backendThroughHost = await stopBackendThroughHost(record)
  outcomes.host = await stopRecordedProcess(record, "host")
  outcomes.backendOrphan = await stopOrphanBackend(record)
  outcomes.provider = await stopRecordedProcess(record, "provider")
  outcomes.portsClosed = {
    [BACKEND_PORT]: !(await isPortOpen(BACKEND_PORT)),
    [RENDERER_PORT]: !(await isPortOpen(RENDERER_PORT))
  }
  return outcomes
}

/**
 * Asks the host to stop the backend, as the renderer's Stop button does.
 *
 * @param {Record<string, any>} record - The run record.
 * @returns {Promise<string>} `stopped`, or why the host could not be asked.
 */
async function stopBackendThroughHost(record) {
  if (!record.urls?.host) return "no-host"
  try {
    const exchange = await sendJsonRequest(`${record.urls.host}/invoke`, {
      method: "POST",
      json: { cmd: "stop_backend", args: {} },
      timeoutMs: 15_000
    })
    return exchange.body?.ok === true
      ? "stopped"
      : `refused: ${JSON.stringify(exchange.body)}`
  } catch (error) {
    return `host unreachable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Copies the scratch Lys home's logs, settings, and database into the run's
 * logs directory so they outlive cleanup.
 *
 * @param {import("./runRecord.mjs").RunPaths} paths - The run's paths.
 * @returns {string[]} The copied file names.
 */
export function collectHomeArtifacts(paths) {
  const target = join(paths.logsDir, "lys-home")
  mkdirSync(target, { recursive: true })
  const copied = []
  const logsDir = join(paths.lysHome, "logs")
  const candidates = [
    ...(existsSync(logsDir)
      ? readdirSync(logsDir).map((name) => join(logsDir, name))
      : []),
    buildSettingsPath(paths.lysHome),
    join(paths.lysHome, "lys_db.sqlite")
  ]
  for (const source of candidates) {
    if (!existsSync(source)) continue
    const name = source.slice(paths.lysHome.length + 1).replaceAll("/", "__")
    copyFileSync(source, join(target, name))
    copied.push(name)
  }
  return copied
}

/**
 * Observes the stack without changing it.
 *
 * @param {Record<string, any>} record - The run record.
 * @returns {Promise<Record<string, unknown>>} Which processes are alive,
 * who listens on the fixed ports, and whether the backend, host, provider,
 * and DevTools endpoint answer.
 */
export async function getStackHealth(record) {
  const processes = Object.fromEntries(
    Object.entries(record.processes ?? {}).map(([role, owned]) => [
      role,
      { pid: owned.pid, alive: isOwnedProcessAlive(owned) }
    ])
  )
  return {
    status: record.status,
    processes,
    listeners: {
      [BACKEND_PORT]: listListeningPids(BACKEND_PORT),
      [RENDERER_PORT]: listListeningPids(RENDERER_PORT)
    },
    backendHealth: await observeJson(`${BACKEND_URL}/api/v1/heath`),
    hostStatus: record.urls?.host
      ? await observeJson(`${record.urls.host}/status`)
      : "no-host",
    providerTags: record.urls?.provider
      ? await observeJson(`${record.urls.provider}/api/tags`)
      : "no-provider",
    devTools: record.urls?.devTools
      ? await observeDevTools(record.urls.devTools)
      : "no-chrome"
  }
}

/**
 * Sends one GET and reports its body or its failure.
 *
 * @param {string} url - Absolute URL.
 * @returns {Promise<unknown>} The body, or `{error}`.
 */
async function observeJson(url) {
  try {
    return (await sendJsonRequest(url, { timeoutMs: 3000 })).body
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Connects to the DevTools endpoint and asks Chrome's version.
 *
 * @param {string} webSocketUrl - The endpoint.
 * @returns {Promise<unknown>} The `Browser.getVersion` product, or `{error}`.
 */
async function observeDevTools(webSocketUrl) {
  try {
    const connection = await CdpConnection.open(webSocketUrl)
    try {
      const version = await connection.send("Browser.getVersion")
      return { product: version.product }
    } finally {
      connection.close()
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
