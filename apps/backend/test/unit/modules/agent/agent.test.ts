import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  agentDefinitionSchema,
  agentSchema,
  agentUpdateSchema
} from "../../../../src/modules/agent/agent"

/** Valid definition each case varies in one field. */
const LYS_DEFINITION = {
  code: "lys",
  name: "Lys",
  bio: "Personal assistant.",
  systemPrompt: "You are Lys."
}

/** Valid stored agent each case varies in one field. */
const STORED_LYS = {
  ...LYS_DEFINITION,
  createdAt: "2026-01-02T03:04:05.678Z",
  updatedAt: "2026-01-02T03:04:05.678Z"
}

describe("agentDefinitionSchema", () => {
  it.each([
    ["a single word", "lys"],
    ["hyphen-separated groups", "web-researcher"],
    ["letters and digits", "r2-d2"],
    ["the maximum length", "a".repeat(64)]
  ])("accepts a code made of %s", (_label, code) => {
    expect(agentDefinitionSchema.parse({ ...LYS_DEFINITION, code }).code).toBe(
      code
    )
  })

  it.each([
    ["an empty code", ""],
    ["an uppercase letter", "Lys"],
    ["a surrounding space", " lys"],
    ["a leading hyphen", "-lys"],
    ["a trailing hyphen", "lys-"],
    ["a doubled hyphen", "web--researcher"],
    ["an underscore", "web_researcher"],
    ["one character over the maximum length", "a".repeat(65)]
  ])("rejects a code with %s", (_label, code) => {
    expect(() =>
      agentDefinitionSchema.parse({ ...LYS_DEFINITION, code })
    ).toThrow(z.ZodError)
  })

  it("trims the name, bio, and system prompt", () => {
    expect(
      agentDefinitionSchema.parse({
        code: "lys",
        name: "  Lys  ",
        bio: "\tPersonal assistant.\n",
        systemPrompt: "\n You are Lys. \n"
      })
    ).toEqual(LYS_DEFINITION)
  })

  it.each([
    ["name", 64],
    ["bio", 128]
  ])("accepts a %s of %i characters after trimming", (field, length) => {
    const value = "x".repeat(length)

    expect(
      agentDefinitionSchema.parse({ ...LYS_DEFINITION, [field]: ` ${value} ` })
    ).toMatchObject({ [field]: value })
  })

  it.each([
    ["name", 65],
    ["bio", 129]
  ])("rejects a %s of %i characters", (field, length) => {
    expect(() =>
      agentDefinitionSchema.parse({
        ...LYS_DEFINITION,
        [field]: "x".repeat(length)
      })
    ).toThrow(z.ZodError)
  })

  it.each(["name", "bio", "systemPrompt"])("rejects a blank %s", (field) => {
    expect(() =>
      agentDefinitionSchema.parse({ ...LYS_DEFINITION, [field]: " \n\t " })
    ).toThrow(z.ZodError)
  })

  it("rejects an unknown field", () => {
    expect(() =>
      agentDefinitionSchema.parse({ ...LYS_DEFINITION, model: "qwen/qwen3-8b" })
    ).toThrow(z.ZodError)
  })

  it("returns a frozen definition", () => {
    expect(Object.isFrozen(agentDefinitionSchema.parse(LYS_DEFINITION))).toBe(
      true
    )
  })
})

describe("agentSchema", () => {
  it("accepts a stored agent and returns it frozen", () => {
    const agent = agentSchema.parse(STORED_LYS)

    expect(agent).toEqual(STORED_LYS)
    expect(Object.isFrozen(agent)).toBe(true)
  })

  it.each([
    ["without milliseconds", "2026-01-02T03:04:05Z"],
    ["in another format", "2026-01-02 03:04:05.678"]
  ])("rejects a timestamp %s", (_label, createdAt) => {
    expect(() => agentSchema.parse({ ...STORED_LYS, createdAt })).toThrow(
      z.ZodError
    )
  })

  it("rejects a stored code that is not a slug", () => {
    expect(() =>
      agentSchema.parse({ ...STORED_LYS, code: "Not A Slug" })
    ).toThrow(z.ZodError)
  })

  it.each(["name", "bio", "systemPrompt"])(
    "rejects a stored %s with surrounding whitespace instead of trimming it",
    (field) => {
      expect(() =>
        agentSchema.parse({ ...STORED_LYS, [field]: " Untrimmed " })
      ).toThrow(z.ZodError)
    }
  )
})

describe("agentUpdateSchema", () => {
  it("accepts a change to one field and trims it", () => {
    expect(
      agentUpdateSchema.parse({ code: "lys", bio: " Archivist. " })
    ).toEqual({ code: "lys", bio: "Archivist." })
  })

  it("accepts a change to every field", () => {
    expect(agentUpdateSchema.parse(LYS_DEFINITION)).toEqual(LYS_DEFINITION)
  })

  it.each([
    ["only the code", { code: "lys" }],
    ["undefined fields", { code: "lys", name: undefined }]
  ])("rejects an update with %s", (_label, update) => {
    expect(() => agentUpdateSchema.parse(update)).toThrow(z.ZodError)
  })

  it.each([
    ["an invalid code", { code: "Lys", name: "Lys" }],
    ["a blank field", { code: "lys", systemPrompt: "   " }],
    ["an unknown field", { code: "lys", name: "Lys", model: "qwen" }]
  ])("rejects an update with %s", (_label, update) => {
    expect(() => agentUpdateSchema.parse(update)).toThrow(z.ZodError)
  })
})
