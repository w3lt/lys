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
    vi.stubEnv("LYS_HOME", "/test-home/lys")
    vi.mocked(readPrompt).mockImplementation((type) => FIXTURE_PROMPTS[type])
  })

  it("resolves the shared endpoints, the Lys home database path, both prompts, and the fixed title limits", () => {
    expect(loadBackendConfig()).toEqual({
      backendHost: BACKEND_HOST,
      backendPort: BACKEND_PORT,
      lmstudioHost: LMSTUDIO_HOST,
      lmstudioPort: LMSTUDIO_PORT,
      databaseFilePath: "/test-home/lys/lys_db.sqlite",
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

  it.each([
    ["unset", undefined],
    ["empty", ""]
  ])("rejects an %s Lys home directory", (_label, lysHome) => {
    vi.stubEnv("LYS_HOME", lysHome)

    expect(() => loadBackendConfig()).toThrow("LYS_HOME is not set")
  })

  it("rejects a relative Lys home directory", () => {
    vi.stubEnv("LYS_HOME", "relative-home")

    expect(() => loadBackendConfig()).toThrow(
      'LYS_HOME must be an absolute path, got "relative-home"'
    )
  })
})
