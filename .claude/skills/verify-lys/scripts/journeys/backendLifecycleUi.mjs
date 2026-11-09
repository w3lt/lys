/**
 * Journey: the Runtime pane's Stop and Start buttons stop and restart the
 * backend process.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isPortOpen, sendJsonRequest } from "../lib/httpProbe.mjs"
import { rejectUnless } from "../lib/journey.mjs"
import { BACKEND_PORT } from "../lib/repository.mjs"
import {
  RUNTIME_PANE,
  openSettingsPane,
  waitForBackendStatusLabel,
  waitForComposerReady
} from "../lib/rendererSteps.mjs"
import { waitForCondition } from "../lib/waiting.mjs"

/** The line the backend logs when a stop signal reaches it. */
const STOP_LOG_MESSAGE = "The Lys backend is stopping on a signal"

/**
 * Finds a line in the backend's own log files under the Lys home.
 *
 * @param {string} lysHome - The scratch Lys home.
 * @param {string} text - Text the line must contain.
 * @returns {string | false} The last matching line, or `false`.
 */
function findBackendLogLine(lysHome, text) {
  const logsDir = join(lysHome, "logs")
  if (!existsSync(logsDir)) return false
  const lines = readdirSync(logsDir)
    .filter((name) => name.startsWith("backend-") && name.endsWith(".log"))
    .flatMap((name) => readFileSync(join(logsDir, name), "utf8").split("\n"))
    .filter((line) => line.includes(text))
  return lines.at(-1) ?? false
}

export default Object.freeze({
  id: "backend-lifecycle-ui",
  feature: "backend-lifecycle",
  title:
    "In Settings → Runtime, Stop backend ends the backend process (status Backend stopped, port 12345 closed, stop signal logged) and Start backend starts a new process that answers health",
  needsRenderer: true,
  needsNative: false,
  async run(steps, context) {
    const page = await context.openPage()
    try {
      const before = await steps.step(
        "Settings → Runtime shows Backend running",
        async (evidence) => {
          await waitForComposerReady(page, 60_000)
          await openSettingsPane(page, RUNTIME_PANE)
          await waitForBackendStatusLabel(page, "Backend running", 10_000)
          const host = await sendJsonRequest(`${context.hostUrl}/status`)
          await page.captureScreenshot(evidence.buildPath("running.png"))
          evidence.saveJson("host-before.json", host.body)
          rejectUnless(
            host.body?.backend?.running === true,
            "The host must report the backend running.",
            host.body
          )
          return { pid: host.body.backend.pid }
        }
      )
      await steps.step(
        "Stop backend ends the process, frees port 12345, and the backend logs the signal",
        async (evidence) => {
          await page.click(
            `document.querySelector('button[aria-label="Stop backend"]')`
          )
          await waitForBackendStatusLabel(page, "Backend stopped", 20_000)
          const logLine = await waitForCondition({
            description: "the backend's log to record the stop signal",
            timeoutMs: 5000,
            check: () =>
              findBackendLogLine(context.paths.lysHome, STOP_LOG_MESSAGE)
          })
          const portOpen = await isPortOpen(BACKEND_PORT)
          const host = await sendJsonRequest(`${context.hostUrl}/status`)
          await page.captureScreenshot(evidence.buildPath("stopped.png"))
          evidence.saveJson("after-stop.json", {
            portOpen,
            hostStatus: host.body,
            logLine
          })
          rejectUnless(!portOpen, "Port 12345 must be closed after Stop.", {
            portOpen
          })
          rejectUnless(
            host.body?.backend?.running === false,
            "The host must report the backend stopped.",
            host.body
          )
          return { portOpen, logLine }
        }
      )
      await steps.step(
        "Start backend starts a new process that answers health",
        async (evidence) => {
          await page.click(
            `document.querySelector('button[aria-label="Start backend"]')`
          )
          await waitForBackendStatusLabel(page, "Backend running", 30_000)
          const health = await sendJsonRequest(
            `${context.backendUrl}/api/v1/heath`
          )
          const host = await sendJsonRequest(`${context.hostUrl}/status`)
          await page.captureScreenshot(evidence.buildPath("restarted.png"))
          evidence.saveJson("after-start.json", {
            health,
            hostStatus: host.body
          })
          rejectUnless(
            health.body?.ok === true,
            "The restarted backend must answer health.",
            health
          )
          rejectUnless(
            host.body?.backend?.running === true,
            "The host must report the backend running again.",
            host.body
          )
          rejectUnless(
            host.body.backend.pid !== before.pid,
            "The restarted backend must be a new process.",
            { before: before.pid, after: host.body.backend.pid }
          )
          return { previousPid: before.pid, pid: host.body.backend.pid }
        }
      )
    } finally {
      await page.close()
    }
  }
})
