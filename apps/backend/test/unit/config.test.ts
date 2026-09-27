import { join } from "node:path"
import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import { loadBackendConfig } from "../src/config"
import { readPrompt } from "../src/utils/prompts"

/** Home directory substituted for the developer's real one. */
const TEST_HOME = "/test-home/lys-user"

describe("loadBackendConfig", () => {
  it("uses the shared loopback endpoints for the backend and LM Studio", () => {
    const config = loadBackendConfig()

    expect(config).toMatchObject({
      backendHost: BACKEND_HOST,
      backendPort: BACKEND_PORT,
      lmstudioHost: LMSTUDIO_HOST,
      lmstudioPort: LMSTUDIO_PORT
    })
  })

  it("places the conversation database in the user's .lys directory", () => {
    vi.stubEnv("HOME", TEST_HOME)

    expect(loadBackendConfig().databaseFilePath).toBe(
      join(TEST_HOME, ".lys", "lys_db.sqlite")
    )
  })

  it("loads both maintained prompts", () => {
    const config = loadBackendConfig()

    expect(config.lysSystemPrompt).toBe(readPrompt("lys-system"))
    expect(config.titleGenerationPrompt).toBe(readPrompt("title-generation"))
  })

  it("allows three title attempts per turn and titles of up to 100 code points", () => {
    const config = loadBackendConfig()

    expect(config.titleGenerationMaxAttempts).toBe(3)
    expect(config.generatedTitleMaxLength).toBe(100)
  })

  it("returns a frozen snapshot", () => {
    expect(Object.isFrozen(loadBackendConfig())).toBe(true)
  })
})
