import { useEffect } from "react"

import { useLysStore } from "../store"

/**
 * Interval between readings of Lys's personality period from the desktop
 * host, in milliseconds. It bounds how long the application keeps showing a
 * side after the host's clock has moved to the other one.
 */
const LYS_PERSONALITY_REFRESH_INTERVAL_MS = 60_000

/**
 * Keeps the application store's period of Lys's personality current while
 * the calling component is mounted.
 *
 * @remarks Asks the store to read the period from the desktop host every
 * {@link LYS_PERSONALITY_REFRESH_INTERVAL_MS} milliseconds. The store joins a
 * reading that is still pending, so readings never overlap, and a delayed or
 * missed tick is not repeated. A failed reading leaves the previous period in
 * place until the next tick and is written to the console. Unmounting clears
 * the interval; a reading already started still publishes to the store, which
 * owns it.
 */
export function useLysPersonalityRefresh(): void {
  const updateLysPersonalityPeriod = useLysStore(
    (state) => state.updateLysPersonalityPeriod
  )

  useEffect(() => {
    const intervalId = setInterval(() => {
      updateLysPersonalityPeriod().catch(handleLysPersonalityRefreshFailure)
    }, LYS_PERSONALITY_REFRESH_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [updateLysPersonalityPeriod])
}

/**
 * Writes a failed periodic reading of Lys's personality period to the
 * console.
 *
 * @param error - Host or validation failure of the reading.
 */
function handleLysPersonalityRefreshFailure(error: unknown): void {
  console.error(
    "Lys's side could not be refreshed; the previous side stays in place.",
    error
  )
}
