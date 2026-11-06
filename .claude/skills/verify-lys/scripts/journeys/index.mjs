/**
 * Every journey the harness can drive, in the order `run` drives them.
 *
 * @remarks API journeys come first because they need no browser; the
 * native host journey comes last because it stops the harness backend
 * while it runs.
 */

import backendHealth from "./backendHealth.mjs"
import backendLifecycleUi from "./backendLifecycleUi.mjs"
import chatStreamApi from "./chatStreamApi.mjs"
import chatStreamUi from "./chatStreamUi.mjs"
import hostLifecycleNative from "./hostLifecycleNative.mjs"
import settingsAutostartUi from "./settingsAutostartUi.mjs"
import settingsGenerationUi from "./settingsGenerationUi.mjs"

/** The journeys in drive order. */
export const JOURNEYS = Object.freeze([
  backendHealth,
  chatStreamApi,
  chatStreamUi,
  settingsGenerationUi,
  settingsAutostartUi,
  backendLifecycleUi,
  hostLifecycleNative
])

/**
 * Finds a journey by identifier.
 *
 * @param {string} id - Journey identifier.
 * @returns {import("../lib/journey.mjs").JourneyDefinition | undefined} The
 * journey, or `undefined`.
 */
export function findJourney(id) {
  return JOURNEYS.find((journey) => journey.id === id)
}
