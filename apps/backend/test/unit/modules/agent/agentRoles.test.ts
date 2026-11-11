import { ARMITAGE_AGENT_CODE, CALIGINIA_AGENT_CODE } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateAgentRole,
  hasAgentPermission
} from "../../../../src/modules/agent/agentRoles"

describe("calculateAgentRole", () => {
  it("makes a built-in agent a leader and a stored agent a member", () => {
    expect(
      calculateAgentRole({ code: CALIGINIA_AGENT_CODE, kind: "built-in" })
    ).toBe("leader")
    expect(calculateAgentRole({ code: "researcher", kind: "custom" })).toBe(
      "member"
    )
  })

  it("makes Armitage the tool keeper", () => {
    expect(
      calculateAgentRole({ code: ARMITAGE_AGENT_CODE, kind: "built-in" })
    ).toBe("tool-keeper")
  })

  it("makes a stored agent a member whatever its code", () => {
    expect(
      calculateAgentRole({ code: ARMITAGE_AGENT_CODE, kind: "custom" })
    ).toBe("member")
  })
})

describe("hasAgentPermission", () => {
  it.each([
    ["leader", "read-own-state", true],
    ["leader", "find-agents", true],
    ["leader", "read-any-state", true],
    ["member", "read-own-state", true],
    ["member", "find-agents", false],
    ["member", "read-any-state", false],
    ["tool-keeper", "read-own-state", false],
    ["tool-keeper", "find-agents", false],
    ["tool-keeper", "read-any-state", false]
  ] as const)("answers whether a %s may %s", (role, permission, expected) => {
    expect(hasAgentPermission(role, permission)).toBe(expected)
  })
})
