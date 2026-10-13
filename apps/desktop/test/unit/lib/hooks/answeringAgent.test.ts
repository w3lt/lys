import { act, renderHook } from "@testing-library/react"
import { CALIGINIA_AGENT_CODE, conversationSchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildAgent,
  buildAgentSummary,
  buildBuiltInAgent,
  buildBuiltInAgentSummary
} from "../../support/agentFixtures"
import {
  buildConversation,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"

/** Displayed agent list: Caliginia and one agent of the user's own. */
const LOADED_AGENT_LIST = Object.freeze({
  status: "loaded",
  builtInAgents: [
    buildBuiltInAgentSummary(
      buildBuiltInAgent(CALIGINIA_AGENT_CODE, { name: "Caliginia" })
    )
  ],
  agents: [buildAgentSummary(buildAgent("poet", { name: "Poet" }))],
  isRefreshing: false
} as const)

/**
 * Loads fresh agent and chat-view stores with the hook that reads them, so
 * no list, conversation, or selection of another case reaches this one.
 *
 * @returns Both store hooks and the hook under test.
 */
async function loadFreshAnsweringAgentHook() {
  vi.resetModules()
  const { useAgentStore } = await import("@/lib/store/agents")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useAnsweringAgent } = await import("@/lib/hooks/answeringAgent")
  return { useAgentStore, useChatViewStore, useAnsweringAgent }
}

describe("useAnsweringAgent", () => {
  it("knows only the selected code before the agent list is read, and starts no read", async () => {
    const { useAnsweringAgent } = await loadFreshAnsweringAgentHook()

    const { result } = renderHook(() => useAnsweringAgent())

    expect(result.current).toEqual({
      status: "unread",
      code: CALIGINIA_AGENT_CODE
    })
  })

  it("follows the agent list, the selected agent, and the shown conversation as each changes", async () => {
    const { useAgentStore, useChatViewStore, useAnsweringAgent } =
      await loadFreshAnsweringAgentHook()
    const { result } = renderHook(() => useAnsweringAgent())

    act(() => useAgentStore.setState({ list: LOADED_AGENT_LIST }))
    const afterListRead = result.current
    act(() => useChatViewStore.getState().selectAgent("poet"))
    const afterSelection = result.current
    act(() =>
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildConversation(FIXTURE_CONVERSATION_ID, null, [])
        )
      })
    )

    expect(afterListRead).toMatchObject({
      status: "listed",
      agent: { code: CALIGINIA_AGENT_CODE, name: "Caliginia" }
    })
    expect(afterSelection).toMatchObject({
      status: "listed",
      agent: { code: "poet", name: "Poet" }
    })
    expect(result.current).toMatchObject({
      status: "listed",
      agent: { code: CALIGINIA_AGENT_CODE }
    })
  })

  it("reports the shown conversation's agent as deleted once the list no longer holds it", async () => {
    const { useAgentStore, useChatViewStore, useAnsweringAgent } =
      await loadFreshAnsweringAgentHook()
    useAgentStore.setState({ list: LOADED_AGENT_LIST })
    useChatViewStore.setState({
      conversation: createStoredChatViewConversation(
        conversationSchema.parse({
          ...buildConversation(FIXTURE_CONVERSATION_ID, null, []),
          agentCode: "historian"
        })
      )
    })

    const { result } = renderHook(() => useAnsweringAgent())

    expect(result.current).toEqual({ status: "deleted", code: "historian" })
  })
})
