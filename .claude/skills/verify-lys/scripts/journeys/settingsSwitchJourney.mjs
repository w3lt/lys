/**
 * Builds a journey that flips one settings switch in the renderer and
 * proves the change reached `settings.json`, survived a reload, and can be
 * restored.
 *
 * @remarks The Generation and Runtime panes persist through the same
 * `save_settings` path, so both journeys share this body; only the pane,
 * the switch, and the field differ.
 */

import { rejectUnless } from "../lib/journey.mjs"
import {
  buildSwitchExpression,
  openSettingsPane,
  readSwitchState,
  waitForAppShell,
  waitForComposerReady,
  waitForSwitchState
} from "../lib/rendererSteps.mjs"
import {
  buildSettingsPath,
  readSettingsDocument,
  saveSettingsDocument
} from "../lib/settingsDocument.mjs"
import { waitForCondition } from "../lib/waiting.mjs"

/**
 * Waits until the settings file holds a value at a path.
 *
 * @param {string} settingsPath - The file.
 * @param {readonly string[]} fieldPath - Keys from the document root.
 * @param {unknown} expected - The value the field must equal.
 * @returns {Promise<object>} The document once it holds the value.
 * @throws If the file does not hold it within 10 seconds.
 */
function waitForSettingsField(settingsPath, fieldPath, expected) {
  return waitForCondition({
    description: `settings.json to hold ${fieldPath.join(".")} = ${JSON.stringify(expected)}`,
    timeoutMs: 10_000,
    check: () => {
      const document = readSettingsDocument(settingsPath)
      const value = fieldPath.reduce((node, key) => node?.[key], document)
      if (value === expected) return document
      throw new Error(`${fieldPath.join(".")} is ${JSON.stringify(value)}`)
    }
  })
}

/**
 * Puts the field back to its on-value in the file when a failed journey
 * left it off, so later journeys start from the seeded settings.
 *
 * @param {string} settingsPath - The file.
 * @param {readonly string[]} fieldPath - Keys from the document root.
 * @param {unknown} onValue - The seeded value.
 * @returns {boolean} `true` when the file had to be rewritten.
 */
function restoreSettingsField(settingsPath, fieldPath, onValue) {
  const document = readSettingsDocument(settingsPath)
  const parent = fieldPath
    .slice(0, -1)
    .reduce((node, key) => node?.[key], document)
  const key = fieldPath.at(-1)
  if (parent === undefined || parent[key] === onValue) return false
  parent[key] = onValue
  saveSettingsDocument(settingsPath, document)
  return true
}

/**
 * Builds the journey.
 *
 * @param {{id: string, title: string, pane: import("../lib/rendererSteps.mjs").SettingsPane, switchLabel: string, fieldPath: readonly string[], onValue: unknown, offValue: unknown}} options -
 * The journey identity, the pane, the switch, and the field it persists.
 * @returns {import("../lib/journey.mjs").JourneyDefinition} The journey.
 */
export function buildSettingsSwitchJourney(options) {
  const { pane, switchLabel, fieldPath, onValue, offValue } = options
  return Object.freeze({
    id: options.id,
    feature: "settings-persistence",
    title: options.title,
    needsRenderer: true,
    needsNative: false,
    async run(steps, context) {
      const settingsPath = buildSettingsPath(context.paths.lysHome)
      const page = await context.openPage()
      try {
        await steps.step(
          `open Settings → ${pane.label}; the "${switchLabel}" switch starts on`,
          async (evidence) => {
            await waitForComposerReady(page, 60_000)
            await openSettingsPane(page, pane)
            const state = await readSwitchState(page, switchLabel)
            await page.captureScreenshot(evidence.buildPath("before.png"))
            rejectUnless(
              state === "true",
              `The "${switchLabel}" switch must start on.`,
              state
            )
            return { switchState: state }
          }
        )
        await steps.step(
          `switching it off writes ${fieldPath.join(".")} = ${JSON.stringify(offValue)}`,
          async (evidence) => {
            await page.click(buildSwitchExpression(switchLabel))
            const document = await waitForSettingsField(
              settingsPath,
              fieldPath,
              offValue
            )
            await waitForSwitchState(page, {
              label: switchLabel,
              expected: "false",
              timeoutMs: 5000
            })
            await page.captureScreenshot(evidence.buildPath("switched-off.png"))
            evidence.saveJson("settings-after-off.json", document)
            return { [fieldPath.join(".")]: offValue }
          }
        )
        await steps.step(
          "after a reload the switch is still off",
          async (evidence) => {
            await page.reload()
            // The shell, not a ready composer: persistence of the switch does not
            // depend on the backend or provider, and a switched-off autostart
            // changes how the reloaded renderer adopts the running backend.
            const composerPlaceholder = await waitForAppShell(page, 60_000)
            await openSettingsPane(page, pane)
            const state = await readSwitchState(page, switchLabel)
            await page.captureScreenshot(evidence.buildPath("after-reload.png"))
            rejectUnless(
              state === "false",
              `The "${switchLabel}" switch must be off after a reload.`,
              state
            )
            return { switchState: state, composerPlaceholder }
          }
        )
        await steps.step(
          `switching it back on restores ${fieldPath.join(".")} = ${JSON.stringify(onValue)}`,
          async (evidence) => {
            await page.click(buildSwitchExpression(switchLabel))
            const document = await waitForSettingsField(
              settingsPath,
              fieldPath,
              onValue
            )
            await waitForSwitchState(page, {
              label: switchLabel,
              expected: "true",
              timeoutMs: 5000
            })
            evidence.saveJson("settings-restored.json", document)
            return { [fieldPath.join(".")]: onValue }
          }
        )
      } finally {
        await page.close()
        if (restoreSettingsField(settingsPath, fieldPath, onValue))
          await steps.step(
            `the journey ended early; ${fieldPath.join(".")} was put back to ${JSON.stringify(onValue)} by the harness`,
            async () => ({ restoredByHarness: true })
          )
      }
    }
  })
}
