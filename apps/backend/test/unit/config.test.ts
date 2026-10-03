import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { backendConfigSchema, loadBackendConfig } from "../../src/config"
import { readPrompt, type PromptType } from "../../src/utils/prompts"

vi.mock("../../src/utils/prompts", () => ({ readPrompt: vi.fn() }))

/** Trimmed, non-empty prompt text the substituted reader returns per prompt. */
const FIXTURE_PROMPTS = Object.freeze({
  "lys-system": "Fixture system prompt",
  "lys-dark-side": "Fixture dark-side prompt",
  "lys-light-side": "Fixture light-side prompt",
  "title-generation": "Fixture title prompt"
} satisfies Record<PromptType, string>)

/**
 * Raw configuration input that satisfies every schema rule; each case varies
 * only the keys it names.
 */
const VALID_RAW_CONFIG = Object.freeze({
  backendHost: BACKEND_HOST,
  backendPort: BACKEND_PORT,
  lmstudioHost: LMSTUDIO_HOST,
  lmstudioPort: LMSTUDIO_PORT,
  databaseFilePath: "/test-home/lys/lys_db.sqlite",
  lysSystemPrompt: "Fixture system prompt",
  lysPersonalityPrompts: {
    dark: "Fixture dark-side prompt",
    light: "Fixture light-side prompt"
  },
  titleGenerationPrompt: "Fixture title prompt",
  titleGenerationMaxAttempts: 3,
  generatedTitleMaxLength: 100
})

/**
 * Lists the issues of the schema's rejection of raw configuration input.
 *
 * @param input - Untrusted configuration input.
 * @returns The issues of the `ZodError` the schema produces.
 * @throws If the schema accepts the input.
 */
function listConfigIssues(input: unknown): readonly z.core.$ZodIssue[] {
  const result = backendConfigSchema.safeParse(input)
  if (result.success) {
    throw new Error("Expected backendConfigSchema to reject the input")
  }
  return result.error.issues
}

/**
 * Lists the issues of the `ZodError` that loading the configuration throws.
 *
 * @returns The issues of the rejection.
 * @throws If loading succeeds, or the error it throws, when that error is not
 * a `ZodError`.
 */
function listConfigLoadIssues(): readonly z.core.$ZodIssue[] {
  try {
    loadBackendConfig()
  } catch (error) {
    if (error instanceof z.ZodError) {
      return error.issues
    }
    throw error
  }
  throw new Error("Expected loadBackendConfig to reject the configuration")
}

/**
 * Lists the configuration keys that a rejection names, without its issue
 * order, which the configuration contract leaves unspecified.
 *
 * @param issues - Issues of a configuration `ZodError`.
 * @returns The distinct first segments of the issue paths.
 */
function listIssueKeys(
  issues: readonly z.core.$ZodIssue[]
): ReadonlySet<PropertyKey | undefined> {
  return new Set(issues.map(({ path }) => path[0]))
}

/**
 * Copies the valid raw configuration without one key.
 *
 * @param omittedKey - Key left out of the copy.
 * @returns Raw input that lacks that key and keeps every other valid value.
 */
function createRawConfigWithout(
  omittedKey: string
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(VALID_RAW_CONFIG).filter(([key]) => key !== omittedKey)
    )
  )
}

describe("loadBackendConfig", () => {
  beforeEach(() => {
    vi.stubEnv("LYS_HOME", "/test-home/lys")
    vi.mocked(readPrompt).mockImplementation((type) => FIXTURE_PROMPTS[type])
  })

  it("resolves the shared endpoints, the Lys home database path, every prompt, and the fixed title limits", () => {
    expect(loadBackendConfig()).toEqual({
      backendHost: BACKEND_HOST,
      backendPort: BACKEND_PORT,
      lmstudioHost: LMSTUDIO_HOST,
      lmstudioPort: LMSTUDIO_PORT,
      databaseFilePath: "/test-home/lys/lys_db.sqlite",
      lysSystemPrompt: "Fixture system prompt",
      lysPersonalityPrompts: {
        dark: "Fixture dark-side prompt",
        light: "Fixture light-side prompt"
      },
      titleGenerationPrompt: "Fixture title prompt",
      titleGenerationMaxAttempts: 3,
      generatedTitleMaxLength: 100
    })
  })

  it("returns a frozen snapshot, including the side prompts", () => {
    const config = loadBackendConfig()

    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.lysPersonalityPrompts)).toBe(true)
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

  it("rejects prompt text with surrounding whitespace with a ZodError naming each prompt key", () => {
    vi.mocked(readPrompt).mockImplementation(
      (type) => ` ${FIXTURE_PROMPTS[type]} `
    )

    expect(listIssueKeys(listConfigLoadIssues())).toEqual(
      new Set([
        "lysSystemPrompt",
        "lysPersonalityPrompts",
        "titleGenerationPrompt"
      ])
    )
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

describe("backendConfigSchema", () => {
  it.each([
    [
      "the lowest ports",
      { ...VALID_RAW_CONFIG, backendPort: 1, lmstudioPort: 1 }
    ],
    [
      "the highest ports",
      { ...VALID_RAW_CONFIG, backendPort: 65_535, lmstudioPort: 65_535 }
    ],
    [
      "another IPv4 loopback backend host",
      { ...VALID_RAW_CONFIG, backendHost: "127.0.0.2" }
    ],
    [
      "an IPv4 LM Studio host",
      { ...VALID_RAW_CONFIG, lmstudioHost: "192.168.1.20" }
    ],
    [
      "limits of 1",
      {
        ...VALID_RAW_CONFIG,
        titleGenerationMaxAttempts: 1,
        generatedTitleMaxLength: 1
      }
    ]
  ])("accepts %s unchanged as a frozen snapshot", (_label, input) => {
    const config = backendConfigSchema.parse(input)

    expect(config).toEqual(input)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it.each([
    [
      "a backend port of 0",
      { ...VALID_RAW_CONFIG, backendPort: 0 },
      "backendPort"
    ],
    [
      "a backend port of 65536",
      { ...VALID_RAW_CONFIG, backendPort: 65_536 },
      "backendPort"
    ],
    [
      "a fractional backend port",
      { ...VALID_RAW_CONFIG, backendPort: 1.5 },
      "backendPort"
    ],
    [
      "a backend port given as text",
      { ...VALID_RAW_CONFIG, backendPort: "3000" },
      "backendPort"
    ],
    [
      "an LM Studio port of 0",
      { ...VALID_RAW_CONFIG, lmstudioPort: 0 },
      "lmstudioPort"
    ],
    [
      "an LM Studio port of 65536",
      { ...VALID_RAW_CONFIG, lmstudioPort: 65_536 },
      "lmstudioPort"
    ],
    [
      "a host name as the backend host",
      { ...VALID_RAW_CONFIG, backendHost: "localhost" },
      "backendHost"
    ],
    [
      "the IPv6 loopback as the backend host",
      { ...VALID_RAW_CONFIG, backendHost: "::1" },
      "backendHost"
    ],
    [
      "a non-loopback IPv4 backend host",
      { ...VALID_RAW_CONFIG, backendHost: "10.0.0.1" },
      "backendHost"
    ],
    [
      "an LM Studio host with a scheme",
      { ...VALID_RAW_CONFIG, lmstudioHost: "http://localhost" },
      "lmstudioHost"
    ],
    [
      "an LM Studio host with a port",
      { ...VALID_RAW_CONFIG, lmstudioHost: "localhost:1234" },
      "lmstudioHost"
    ],
    [
      "a relative database path",
      { ...VALID_RAW_CONFIG, databaseFilePath: "lys_db.sqlite" },
      "databaseFilePath"
    ],
    [
      "the SQLite in-memory database name",
      { ...VALID_RAW_CONFIG, databaseFilePath: ":memory:" },
      "databaseFilePath"
    ],
    [
      "a system prompt with leading whitespace",
      { ...VALID_RAW_CONFIG, lysSystemPrompt: " Fixture system prompt" },
      "lysSystemPrompt"
    ],
    [
      "an empty system prompt",
      { ...VALID_RAW_CONFIG, lysSystemPrompt: "" },
      "lysSystemPrompt"
    ],
    [
      "a side prompt with trailing whitespace",
      {
        ...VALID_RAW_CONFIG,
        lysPersonalityPrompts: {
          dark: "Fixture dark-side prompt\n",
          light: "Fixture light-side prompt"
        }
      },
      "lysPersonalityPrompts"
    ],
    [
      "an empty side prompt",
      {
        ...VALID_RAW_CONFIG,
        lysPersonalityPrompts: {
          dark: "Fixture dark-side prompt",
          light: ""
        }
      },
      "lysPersonalityPrompts"
    ],
    [
      "side prompts without the light side",
      {
        ...VALID_RAW_CONFIG,
        lysPersonalityPrompts: { dark: "Fixture dark-side prompt" }
      },
      "lysPersonalityPrompts"
    ],
    [
      "a prompt for an unknown side",
      {
        ...VALID_RAW_CONFIG,
        lysPersonalityPrompts: {
          ...VALID_RAW_CONFIG.lysPersonalityPrompts,
          dusk: "Fixture dusk prompt"
        }
      },
      "lysPersonalityPrompts"
    ],
    [
      "a title prompt with trailing whitespace",
      { ...VALID_RAW_CONFIG, titleGenerationPrompt: "Fixture title prompt\n" },
      "titleGenerationPrompt"
    ],
    [
      "an empty title prompt",
      { ...VALID_RAW_CONFIG, titleGenerationPrompt: "" },
      "titleGenerationPrompt"
    ],
    [
      "zero title-generation attempts",
      { ...VALID_RAW_CONFIG, titleGenerationMaxAttempts: 0 },
      "titleGenerationMaxAttempts"
    ],
    [
      "a generated-title length limit of 0",
      { ...VALID_RAW_CONFIG, generatedTitleMaxLength: 0 },
      "generatedTitleMaxLength"
    ]
  ])("rejects %s and names only that key", (_label, input, key) => {
    expect(listIssueKeys(listConfigIssues(input))).toEqual(new Set([key]))
  })

  it.each(Object.keys(VALID_RAW_CONFIG))(
    "rejects input without %s and names that key",
    (omittedKey) => {
      expect(
        listIssueKeys(listConfigIssues(createRawConfigWithout(omittedKey)))
      ).toEqual(new Set([omittedKey]))
    }
  )

  it("rejects an unknown key and names it", () => {
    expect(
      listConfigIssues({ ...VALID_RAW_CONFIG, unexpectedSetting: true })
    ).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["unexpectedSetting"]
      })
    ])
  })
})
