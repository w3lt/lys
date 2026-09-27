import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadBackendConfig } from "../../src/config"
import { readPrompt, type PromptType } from "../../src/utils/prompts"

vi.mock("../../src/utils/prompts", () => ({ readPrompt: vi.fn() }))

/** Trimmed, non-empty prompt text the substituted reader returns per prompt. */
const FIXTURE_PROMPTS = Object.freeze({
  "lys-system": "Fixture system prompt",
  "title-generation": "Fixture title prompt"
} satisfies Record<PromptType, string>)

describe("loadBackendConfig", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/test-home/lys-user")
    vi.mocked(readPrompt).mockImplementation((type) => FIXTURE_PROMPTS[type])
  })

  it("resolves the shared endpoints, the home database path, both prompts, and the fixed title limits", () => {
    expect(loadBackendConfig()).toEqual({
      backendHost: BACKEND_HOST,
      backendPort: BACKEND_PORT,
      lmstudioHost: LMSTUDIO_HOST,
      lmstudioPort: LMSTUDIO_PORT,
      databaseFilePath: "/test-home/lys-user/.lys/lys_db.sqlite",
      lysSystemPrompt: "Fixture system prompt",
      titleGenerationPrompt: "Fixture title prompt",
      titleGenerationMaxAttempts: 3,
      generatedTitleMaxLength: 100
    })
  })

  it("returns a frozen snapshot", () => {
    expect(Object.isFrozen(loadBackendConfig())).toBe(true)
  })

  it("propagates a prompt read failure", () => {
    const readFailure = new Error(
      "Prompt title-generation must not be empty after trimming."
    )
    vi.mocked(readPrompt).mockImplementation((type) => {
      if (type === "title-generation") {
        throw readFailure
      }
      return FIXTURE_PROMPTS[type]
    })

    expect(() => loadBackendConfig()).toThrow(readFailure)
  })

  it("rejects a database path under a relative home directory", () => {
    vi.stubEnv("HOME", "relative-home")

    expect(() => loadBackendConfig()).toThrow(
      expect.objectContaining({
        name: "ZodError",
        issues: [expect.objectContaining({ path: ["databaseFilePath"] })]
      })
    )
  })
})
