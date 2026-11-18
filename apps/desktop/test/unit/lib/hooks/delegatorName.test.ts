import { act, renderHook } from "@testing-library/react"
import { CALIGINIA_AGENT_CODE } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import {
  buildBuiltInAgent,
  buildBuiltInAgentSummary
} from "../../support/agentFixtures"

/** Displayed agent list that holds Caliginia and none of the user's agents. */
const LOADED_AGENT_LIST = Object.freeze({
  status: "loaded",
  builtInAgents: [
    buildBuiltInAgentSummary(
      buildBuiltInAgent(CALIGINIA_AGENT_CODE, { name: "Caliginia" })
    )
  ],
  agents: [],
  isRefreshing: false
} as const)

/**
 * Loads a fresh agent store with the hook that reads it, so no list of
 * another case reaches this one.
 *
 * @returns The store hook and the hook under test.
 */
async function loadFreshDelegatorNameHook() {
  vi.resetModules()
  const { useAgentStore } = await import("@/lib/store/agents")
  const { useDelegatorName } = await import("@/lib/hooks/delegatorName")
  return { useAgentStore, useDelegatorName }
}

describe("useDelegatorName", () => {
  it("names the delegator by its code until the agent list is read, then by its name", async () => {
    const { useAgentStore, useDelegatorName } =
      await loadFreshDelegatorNameHook()
    const { result } = renderHook(() => useDelegatorName(CALIGINIA_AGENT_CODE))
    const beforeListRead = result.current

    act(() => useAgentStore.setState({ list: LOADED_AGENT_LIST }))

    expect(beforeListRead).toBe(CALIGINIA_AGENT_CODE)
    expect(result.current).toBe("Caliginia")
  })

  it("names a deleted delegator by its code", async () => {
    const { useAgentStore, useDelegatorName } =
      await loadFreshDelegatorNameHook()
    useAgentStore.setState({ list: LOADED_AGENT_LIST })

    const { result } = renderHook(() => useDelegatorName("historian"))

    expect(result.current).toBe("historian")
  })

  it("names nobody in a main conversation", async () => {
    const { useAgentStore, useDelegatorName } =
      await loadFreshDelegatorNameHook()
    useAgentStore.setState({ list: LOADED_AGENT_LIST })

    const { result } = renderHook(() => useDelegatorName(null))

    expect(result.current).toBeUndefined()
  })
})
