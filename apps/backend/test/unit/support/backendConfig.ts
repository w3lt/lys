import { backendConfigSchema } from "../../../src/config"

/**
 * Valid backend configuration for tests that only forward its values.
 *
 * @remarks Parsed by `backendConfigSchema`, so it satisfies every rule a
 * production configuration must meet and is frozen. The database path is an
 * absolute placeholder under a directory that does not exist; no case opens it,
 * and neither the attachments directory nor the MCP process groups file
 * beside it is ever written: a case that starts a stdio MCP server through
 * this configuration replaces that path with one in a folder it owns. The
 * email server path names no file, so the built-in email server cannot
 * start and no account check runs through it. The agent request limits (3
 * slots, 1 waiting request) differ from the production defaults, so a case
 * can observe that they are forwarded. The vmo port differs from vmo's
 * production port, so no case reaches a vmo running on this machine there; a
 * case that needs vmo starts a fake one on a free port and passes that port.
 * Prompts are short fixed strings.
 */
export const TEST_BACKEND_CONFIG = backendConfigSchema.parse({
  backendHost: "127.0.0.1",
  backendPort: 12_345,
  databaseFilePath: "/nonexistent/lys-test/lys_db.sqlite",
  settingsFilePath: "/nonexistent/lys-test/settings.json",
  attachmentsDirectoryPath: "/nonexistent/lys-test/attachments",
  mcpProcessGroupsFilePath: "/nonexistent/lys-test/mcp-process-groups",
  emailServerPath: "/nonexistent/lys-test/runtime/email/email",
  vmoHost: "127.0.0.1",
  vmoPort: 18_080,
  caliginiaSystemPrompt: "Configured Caliginia prompt",
  lysipteraSystemPrompt: "Configured Lysiptera prompt",
  armitageSystemPrompt: "Configured Armitage prompt",
  titleGenerationPrompt: "Configured title prompt",
  titleGenerationMaxAttempts: 2,
  generatedTitleMaxLength: 40,
  agentRequestSlotCount: 3,
  agentWaitingRequestLimit: 1
})
