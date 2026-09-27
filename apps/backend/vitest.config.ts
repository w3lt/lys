import { defineConfig } from "vitest/config"

/**
 * Vitest configuration for the backend unit suite.
 *
 * @remarks Discovers only `test/**\/*.test.ts`, so shared harness modules under
 * `test/support` are never collected as cases. Tests run in Node without any
 * external runtime; every substituted global, environment variable, and spy is
 * restored after each case. Vitest's default failure on an empty selection is
 * kept, so a run that discovers no cases fails instead of passing.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true
  }
})
