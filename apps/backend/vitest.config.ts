import { defineConfig } from "vitest/config"

/**
 * Vitest configuration for the backend unit suite.
 *
 * @remarks Discovers only `test/unit/**\/*.test.ts`, so shared harness modules
 * under `test/unit/support` are never collected as cases and the live suite
 * under `test/live` never runs here; a global teardown warns of that when a
 * run ends. Tests run in Node without any external runtime; every substituted
 * global, environment variable, and spy is restored after each case. Vitest's
 * default failure on an empty selection is kept, so a run that discovers no
 * cases fails instead of passing.
 */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    globalSetup: ["test/unit/support/liveSuiteNotice.ts"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true
  }
})
