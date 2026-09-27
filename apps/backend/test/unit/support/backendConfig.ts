import type { BackendConfig } from "../../../src/config"

/**
 * Backend configuration that keeps every test-owned resource isolated.
 *
 * @remarks The conversation database is in memory, so no developer database
 * is opened. The LM Studio host and port are distinct from the production
 * defaults so endpoint derivation is observable; no connection is made because
 * tests replace the SDK and `fetch`. Prompts are short fixed strings.
 */
export const TEST_BACKEND_CONFIG = Object.freeze({
  backendHost: "127.0.0.1",
  backendPort: 0,
  lmstudioHost: "lmstudio.test",
  lmstudioPort: 4321,
  databaseFilePath: ":memory:",
  lysSystemPrompt: "Configured system prompt",
  titleGenerationPrompt: "Configured title prompt",
  titleGenerationMaxAttempts: 2,
  generatedTitleMaxLength: 40
} satisfies BackendConfig)
