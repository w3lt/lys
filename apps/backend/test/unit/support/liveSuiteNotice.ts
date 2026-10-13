import { LIVE_TAVILY_API_KEY_VARIABLE } from "../../live/support/liveTavily"

/**
 * Warns, when a run of the unit suite ends, that the live suite did not run.
 *
 * @remarks Vitest calls this global teardown once, after the run's summary,
 * so the warning is the last line a `vitest run` prints; in watch mode it
 * prints when the watcher exits. The unit suite never contacts Tavily, so a
 * passing unit run says nothing about the cases under `test/live`.
 */
export function teardown(): void {
  console.warn(
    `Not run: the live tests in test/live, which call the real Tavily API. Run them with \`pnpm --filter @lys/backend test:live\`, with ${LIVE_TAVILY_API_KEY_VARIABLE} set to a real Tavily API key.`
  )
}
