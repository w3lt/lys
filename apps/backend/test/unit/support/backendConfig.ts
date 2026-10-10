import { backendConfigSchema } from "../../../src/config"

/**
 * Valid backend configuration for tests that only forward its values.
 *
 * @remarks Parsed by `backendConfigSchema`, so it satisfies every rule a
 * production configuration must meet and is frozen. The database path is an
 * absolute placeholder under a directory that does not exist; no case opens it.
 * The LM Studio host and port are distinct from the production defaults so
 * endpoint derivation is observable. Prompts are short fixed strings.
 */
export const TEST_BACKEND_CONFIG = backendConfigSchema.parse({
  backendHost: "127.0.0.1",
  backendPort: 12_345,
  lmstudioHost: "lmstudio.test",
  lmstudioPort: 4321,
  databaseFilePath: "/nonexistent/lys-test/lys_db.sqlite",
  caliginiaSystemPrompt: "Configured Caliginia prompt",
  lysipteraSystemPrompt: "Configured Lysiptera prompt",
  titleGenerationPrompt: "Configured title prompt",
  titleGenerationMaxAttempts: 2,
  generatedTitleMaxLength: 40
})
