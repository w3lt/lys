import { describe, expect, it } from "vitest"
import {
  findAgentRole,
  hasAgentPermission
} from "../../../../src/modules/agent/agentRoles"

describe("findAgentRole", () => {
  it("makes a built-in agent a leader and a stored agent a member", () => {
    expect(findAgentRole("built-in")).toBe("leader")
    expect(findAgentRole("custom")).toBe("member")
  })
})

describe("hasAgentPermission", () => {
  it.each([
    ["leader", "read-own-state", true],
    ["leader", "find-agents", true],
    ["leader", "read-any-state", true],
    ["member", "read-own-state", true],
    ["member", "find-agents", false],
    ["member", "read-any-state", false]
  ] as const)("answers whether a %s may %s", (role, permission, expected) => {
    expect(hasAgentPermission(role, permission)).toBe(expected)
  })
})
