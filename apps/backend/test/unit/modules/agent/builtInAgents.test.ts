import {
  ARMITAGE_AGENT_CODE,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE
} from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { buildBuiltInAgents } from "../../../../src/modules/agent/builtInAgents"

/** Valid system prompts of the built-in agents. */
const PROMPTS = Object.freeze({
  caliginia: "You are Caliginia.",
  lysiptera: "You are Lysiptera.",
  armitage: "You are Armitage."
})

describe("buildBuiltInAgents", () => {
  it("builds Caliginia, Lysiptera, then Armitage, each with its own prompt", () => {
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
      },
      {
        code: ARMITAGE_AGENT_CODE,
        name: "Armitage",
        bio: "Lys's tool keeper. It finds the tools the other agents need and answers agents, not chats.",
        systemPrompt: "You are Armitage."
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
    ["a padded Lysiptera prompt", { ...PROMPTS, lysiptera: " padded " }],
    ["an empty Armitage prompt", { ...PROMPTS, armitage: "" }]
  ])("rejects %s", (_label, prompts) => {
    expect(() => buildBuiltInAgents(prompts)).toThrow(z.ZodError)
  })
})
