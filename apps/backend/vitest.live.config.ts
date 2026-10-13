import { defineConfig } from "vitest/config"

/**
 * Vitest configuration for the backend live suite, run by the `test:live`
 * script.
 *
 * @remarks Discovers only `test/live/**\/*.test.ts`. Its cases send real
 * requests to the Tavily API over the network with the key in
 * `LYS_TEST_TAVILY_API_KEY`; each real search spends one Tavily credit. A
 * case that needs the key fails when the variable is unset. Vitest's default
 * failure on an empty selection is kept.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    // Above the 15-second limit of one Tavily request, so a slow answer ends
    // as that request's own time-out instead of the runner's.
    testTimeout: 20_000
  }
})
