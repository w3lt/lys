/**
 * Journey (opt-in): the real Tauri debug binary, started with a fresh
 * `LYS_HOME`, writes the default `settings.json` owner-only, starts its own
 * backend, and stops that backend when the app quits.
 *
 * @remarks This is the only journey that runs the Rust host. It opens a
 * visible window, needs the debug binary from `cargo build`, and cannot
 * drive the WKWebView, so it observes the host from outside: the settings
 * file, the port, and the processes. Nothing on screen is captured. The
 * harness backend is stopped first because both share port 12345, and is
 * started again at the end.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { isPortOpen, sendJsonRequest } from "../lib/httpProbe.mjs"
import { JourneyBlocked, rejectUnless } from "../lib/journey.mjs"
import {
  listListeningPids,
  readProcessIdentity,
  sendGroupSignal,
  startOwnedProcess,
  waitForProcessEnd
} from "../lib/processControl.mjs"
import {
  BACKEND_PORT,
  DESKTOP_ROOT,
  TAURI_BUNDLE_IDENTIFIER,
  TAURI_DEBUG_BINARY
} from "../lib/repository.mjs"
import {
  DEFAULT_SETTINGS_DOCUMENT,
  buildSettingsPath
} from "../lib/settingsDocument.mjs"
import { waitForBackendHealth } from "../lib/stack.mjs"
import { waitForCondition } from "../lib/waiting.mjs"

/**
 * Asks the harness host to start or stop its backend and waits for the port.
 *
 * @param {string} hostUrl - The harness host.
 * @param {"start_backend" | "stop_backend"} cmd - The command.
 * @returns {Promise<void>} Resolves once the port matches the command.
 */
async function invokeHarnessBackend(hostUrl, cmd) {
  await sendJsonRequest(`${hostUrl}/invoke`, {
    method: "POST",
    json: { cmd, args: {} },
    timeoutMs: 15_000
  })
  if (cmd === "start_backend") {
    await waitForBackendHealth(30_000)
    return
  }
  await waitForCondition({
    description: "port 12345 to close",
    timeoutMs: 10_000,
    check: async () => !(await isPortOpen(BACKEND_PORT))
  })
}

/**
 * Reads the kind of launchd session this process runs in.
 *
 * @returns {string} `Aqua` in a logged-in GUI session, `Background` over
 * SSH or from a daemon, where no window can open.
 */
function readSessionManagerName() {
  try {
    return execFileSync("launchctl", ["managername"], {
      encoding: "utf8"
    }).trim()
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Sends the app a quit event through AppleScript.
 *
 * @returns {string | undefined} The error text when the event failed.
 */
function sendQuitEvent() {
  try {
    execFileSync(
      "osascript",
      ["-e", `tell application id "${TAURI_BUNDLE_IDENTIFIER}" to quit`],
      {
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Stops the backends a quit left behind, by identity, and names them.
 *
 * @param {string} startedAtIso - Only processes listening on the port are
 * considered; their identities are recorded.
 * @returns {object[]} The listeners that were signalled.
 */
function stopOrphanedBackends(startedAtIso) {
  const orphans = listListeningPids(BACKEND_PORT).map((pid) => ({
    pid,
    identity: readProcessIdentity(pid),
    since: startedAtIso
  }))
  for (const orphan of orphans) {
    if (orphan.identity?.command.includes("src/index.ts"))
      sendGroupSignal(orphan.pid, "SIGTERM")
  }
  return orphans
}

export default Object.freeze({
  id: "host-lifecycle-native",
  feature: "backend-lifecycle",
  title:
    "The real Tauri debug binary with a fresh LYS_HOME writes the default settings.json owner-only, starts a backend on port 12345, and stops it when the app quits (opt-in: --native; opens a visible window)",
  needsRenderer: false,
  needsNative: true,
  async run(steps, context) {
    if (!context.native)
      throw new JourneyBlocked(
        "Pass --native to run the real Tauri debug binary; it opens a visible window."
      )
    if (!existsSync(TAURI_DEBUG_BINARY))
      throw new JourneyBlocked(
        `No debug binary at ${TAURI_DEBUG_BINARY}; build it with cargo build in apps/desktop/src-tauri.`
      )
    const sessionManager = readSessionManagerName()
    if (sessionManager !== "Aqua")
      throw new JourneyBlocked(
        `The native probe needs a logged-in GUI session to open the app's window; this session's launchd manager is "${sessionManager}". Run it from a Terminal on the Mac, not over SSH.`
      )
    const nativeHome = join(context.paths.stateDir, "native-lys-home")
    mkdirSync(nativeHome, { recursive: true })
    const settingsPath = buildSettingsPath(nativeHome)
    let app
    await steps.step(
      "stop the harness backend to free port 12345",
      async () => {
        await invokeHarnessBackend(context.hostUrl, "stop_backend")
        return { portOpen: await isPortOpen(BACKEND_PORT) }
      }
    )
    try {
      await steps.step(
        "the debug binary starts, writes the default settings.json owner-only, and starts its backend",
        async (evidence) => {
          app = await startOwnedProcess({
            role: "tauri",
            command: TAURI_DEBUG_BINARY,
            args: [],
            cwd: join(DESKTOP_ROOT, "src-tauri"),
            env: { ...process.env, LYS_HOME: nativeHome },
            logPath: join(context.paths.logsDir, "tauri.log")
          })
          evidence.saveJson("native-launch.json", {
            app,
            sessionManager,
            lysHome: nativeHome
          })
          const fileText = await waitForCondition({
            description: "the host to create settings.json",
            timeoutMs: 30_000,
            check: () =>
              existsSync(settingsPath)
                ? readFileSync(settingsPath, "utf8")
                : false
          })
          const mode = statSync(settingsPath).mode & 0o777
          const health = await waitForBackendHealth(60_000)
          const listeners = listListeningPids(BACKEND_PORT).map((pid) => ({
            pid,
            identity: readProcessIdentity(pid)
          }))
          evidence.saveJson("native-start.json", {
            app,
            fileText,
            mode: mode.toString(8),
            health,
            listeners
          })
          const expectedText = `${JSON.stringify(DEFAULT_SETTINGS_DOCUMENT, null, 2)}\n`
          rejectUnless(
            fileText === expectedText,
            "The host must write the default settings document, byte for byte as the harness mirrors it.",
            fileText
          )
          rejectUnless(
            mode === 0o600,
            "settings.json must be owner-only (0600).",
            mode.toString(8)
          )
          rejectUnless(
            listeners.length > 0,
            "The host's backend must listen on 12345.",
            listeners
          )
          return {
            pid: app.pid,
            listeners: listeners.map((entry) => entry.pid)
          }
        }
      )
      await steps.step(
        "quitting the app stops its backend",
        async (evidence) => {
          const quitError = sendQuitEvent()
          const ended = await waitForProcessEnd(app, 30_000)
          if (!ended) {
            sendGroupSignal(app.pid, "SIGTERM")
            await waitForProcessEnd(app, 10_000)
          }
          let portClosed = true
          try {
            await waitForCondition({
              description: "port 12345 to close",
              timeoutMs: 15_000,
              check: async () => !(await isPortOpen(BACKEND_PORT))
            })
          } catch {
            portClosed = false
          }
          const orphans = portClosed
            ? []
            : stopOrphanedBackends(new Date().toISOString())
          evidence.saveJson("native-quit.json", {
            quitError,
            ended,
            portClosed,
            orphans
          })
          if (orphans.length > 0)
            throw new JourneyBlocked(
              `The app did not stop its backend after the quit attempt (${quitError ?? "quit event sent"}); the harness stopped pids ${orphans.map((orphan) => orphan.pid).join(", ")} itself, so the exit handler was not verified.`
            )
          rejectUnless(
            quitError === undefined && ended,
            "The app must quit on an AppleScript quit event and end its process.",
            { quitError, ended }
          )
          return { ended, portClosed }
        }
      )
    } finally {
      if (app !== undefined) {
        sendGroupSignal(app.pid, "SIGTERM")
        await waitForProcessEnd(app, 10_000)
      }
      await steps.step("start the harness backend again", async () => {
        await invokeHarnessBackend(context.hostUrl, "start_backend")
        return { portOpen: await isPortOpen(BACKEND_PORT) }
      })
    }
  }
})
