import { CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { buildBuiltInAgents } from "../../../../src/modules/agent/builtInAgents"

/** Valid system prompts of the two built-in agents. */
const PROMPTS = Object.freeze({
  caliginia: "You are Caliginia.",
  lysiptera: "You are Lysiptera."
})

describe("buildBuiltInAgents", () => {
  it("builds Caliginia, then Lysiptera, each with her own prompt", () => {
    expect(buildBuiltInAgents(PROMPTS)).toEqual([
      {
        code: CALIGINIA_AGENT_CODE,
        name: "Caliginia",
        bio: "Lys's dark side.",
        systemPrompt: "You are Caliginia."
      },
      {
        code: LYSIPTERA_AGENT_CODE,
        name: "Lysiptera",
        bio: "Lys's light side.",
        systemPrompt: "You are Lysiptera."
      }
    ])
  })

  it("returns frozen agents in a frozen list", () => {
    const builtInAgents = buildBuiltInAgents(PROMPTS)

    expect(Object.isFrozen(builtInAgents)).toBe(true)
    expect(builtInAgents.every((agent) => Object.isFrozen(agent))).toBe(true)
  })

  it.each([
    ["an empty Caliginia prompt", { ...PROMPTS, caliginia: "" }],
    ["a padded Lysiptera prompt", { ...PROMPTS, lysiptera: " padded " }]
  ])("rejects %s", (_label, prompts) => {
    expect(() => buildBuiltInAgents(prompts)).toThrow(z.ZodError)
  })
})
