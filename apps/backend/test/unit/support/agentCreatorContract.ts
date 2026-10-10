import type { Agent } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { AgentCreator } from "../../../src/modules/agent/capabilities"

/** Agent creation over one store holding no agent, with the controls a case needs. */
export type AgentCreatorHarness = Readonly<{
  /** Agent creation under test. */
  agentCreator: AgentCreator
  /**
   * Reads every agent the store holds, in code order, without going through
   * the agent creation.
   */
  readStoredAgents: () => readonly Agent[]
  /**
   * Makes every later attempt to store an agent fail with an error whose
   * message is `message`, as a failing disk does; the store stays readable.
   */
  failAgentWrites: (message: string) => void
  /** Closes the store as its owner does. */
  closeStore: () => void
}>

/**
 * Creates agent creation over one store holding no agent, owned by the
 * current test, which closes the store when it finishes.
 */
export type AgentCreatorHarnessFactory = () => AgentCreatorHarness

/** Definition with a code that most cases create. */
const RESEARCHER_DEFINITION = Object.freeze({
  code: "researcher",
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
})

/** Definition without a code, whose name gives the code `researcher`. */
const RESEARCHER_NAME_ONLY_DEFINITION = Object.freeze({
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
})

/** Message of the write failure that cases induce. */
const AGENT_WRITE_FAILURE_MESSAGE = "Agent write failed"

/**
 * Registers the provider-independent {@link AgentCreator} contract cases.
 *
 * @param createHarness - Creates agent creation over one empty store per case.
 */
export function registerAgentCreatorContractSuite(
  createHarness: AgentCreatorHarnessFactory
): void {
  describe("AgentCreator contract", () => {
    it("stores the trimmed definition under its code and returns the stored agent", () => {
      const { agentCreator, readStoredAgents } = createHarness()

      const created = agentCreator.createAgent({
        ...RESEARCHER_DEFINITION,
        name: "  Researcher  ",
        systemPrompt: "\nYou research the web.\n"
      })

      expect(created).toMatchObject(RESEARCHER_DEFINITION)
      expect(readStoredAgents()).toEqual([created])
    })

    it("stores a definition without a code under the code its name gives", () => {
      const { agentCreator, readStoredAgents } = createHarness()

      const created = agentCreator.createAgent({
        ...RESEARCHER_NAME_ONLY_DEFINITION,
        name: "Web Researcher"
      })

      expect(created).toMatchObject({
        code: "web-researcher",
        name: "Web Researcher"
      })
      expect(readStoredAgents()).toEqual([created])
    })

    it("stores a definition without a code under the first free numbered code when its name's code is taken", () => {
      const { agentCreator, readStoredAgents } = createHarness()
      const first = agentCreator.createAgent(RESEARCHER_DEFINITION)
      const second = agentCreator.createAgent({
        ...RESEARCHER_DEFINITION,
        code: "researcher-2"
      })

      const created = agentCreator.createAgent(RESEARCHER_NAME_ONLY_DEFINITION)

      expect(created).toMatchObject({ code: "researcher-3" })
      expect(readStoredAgents()).toEqual([first, second, created])
    })

    it("skips a built-in agent's code when the name gives it", () => {
      const { agentCreator, readStoredAgents } = createHarness()

      const created = agentCreator.createAgent({
        ...RESEARCHER_NAME_ONLY_DEFINITION,
        name: "Caliginia"
      })

      expect(created).toMatchObject({ code: "caliginia-2", name: "Caliginia" })
      expect(readStoredAgents()).toEqual([created])
    })

    it.each([
      ["Caliginia's code", "caliginia"],
      ["Lysiptera's code", "lysiptera"],
      ["a stored agent's code", "researcher"]
    ])("returns undefined and stores nothing for %s", (_label, code) => {
      const { agentCreator, readStoredAgents } = createHarness()
      const stored = agentCreator.createAgent(RESEARCHER_DEFINITION)

      expect(
        agentCreator.createAgent({
          ...RESEARCHER_DEFINITION,
          code,
          name: "Impostor"
        })
      ).toBeUndefined()

      expect(readStoredAgents()).toEqual([stored])
    })

    it.each([
      ["an invalid code", { ...RESEARCHER_DEFINITION, code: "Researcher" }],
      ["a blank name", { ...RESEARCHER_NAME_ONLY_DEFINITION, name: "  " }]
    ])(
      "rejects a definition with %s before any storage work",
      (_label, definition) => {
        const { agentCreator, readStoredAgents, failAgentWrites } =
          createHarness()
        failAgentWrites(AGENT_WRITE_FAILURE_MESSAGE)

        expect(() => agentCreator.createAgent(definition)).toThrow(z.ZodError)

        expect(readStoredAgents()).toEqual([])
      }
    )

    it.each([
      ["its given code", { ...RESEARCHER_DEFINITION, code: "web-researcher" }],
      ["the code its name gives", RESEARCHER_NAME_ONLY_DEFINITION]
    ])(
      "fails and stores nothing when storing an agent under %s fails",
      (_label, definition) => {
        const { agentCreator, readStoredAgents, failAgentWrites } =
          createHarness()
        const stored = agentCreator.createAgent(RESEARCHER_DEFINITION)
        failAgentWrites(AGENT_WRITE_FAILURE_MESSAGE)

        expect(() => agentCreator.createAgent(definition)).toThrow(
          AGENT_WRITE_FAILURE_MESSAGE
        )

        expect(readStoredAgents()).toEqual([stored])
      }
    )

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { agentCreator, closeStore } = createHarness()
      closeStore()

      expect(() => agentCreator.createAgent(RESEARCHER_DEFINITION)).toThrow(
        "Database is closed"
      )
    })
  })
}
