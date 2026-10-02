import { defineConfig } from "vitest/config"

/**
 * Vitest configuration for the docs unit suite.
 *
 * @remarks Discovers only `test/**\/*.test.ts` and runs the cases in Node. The
 * suite covers build-time handbook modules; rendered pages are verified by the
 * docs build. Spies are restored after each case. Vitest's default failure on
 * an empty selection is kept, so a run that discovers no cases fails instead of
 * passing.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true
  }
})
