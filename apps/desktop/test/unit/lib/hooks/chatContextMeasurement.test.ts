import { act, renderHook, waitFor } from "@testing-library/react"
import { CALIGINIA_AGENT_CODE } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildJsonResponse,
  createControlledRoute,
  startBackendFake,
  type BackendFake
} from "../../support/backendFake"
import {
  CHAT_CONTEXT_ROUTE,
  FIXTURE_CHAT_CONTEXT_MEASUREMENT
} from "../../support/chatContextFixtures"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildUserMessage,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  READY_RUNTIME,
  updateStoreRuntime
} from "../../support/runtimeFixtures"
import { buildToolDefinition } from "../../support/toolFixtures"

/** Desktop tool the Tools pane offers once its list is read. */
const READ_TEXT_FILE = buildToolDefinition("read_text_file")

/**
 * Loads fresh stores with the hook under test, the runtime ready with
 * `qwen3-8b` loaded.
 *
 * @returns The store hooks and the hook under test.
 */
async function loadFreshMeasurementHook() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useToolStore } = await import("@/lib/store/tools")
  const { useChatContextMeasurement } =
    await import("@/lib/hooks/chatContextMeasurement")
  updateStoreRuntime(useLysStore, READY_RUNTIME)
  return {
    useLysStore,
    useChatViewStore,
    useToolStore,
    useChatContextMeasurement
  }
}

/**
 * Lists the measurement requests a backend received.
 *
 * @param backend - Observation handle of the case's backend.
 * @returns Each request body, in arrival order.
 */
function listMeasurementBodies(backend: BackendFake): unknown[] {
  return backend.requests
    .filter((request) => request.routeKey === CHAT_CONTEXT_ROUTE)
    .map((request) => request.body)
}

describe("useChatContextMeasurement", () => {
  it("measures a new conversation with the loaded model and reports the measurement", async () => {
    const backend = startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
    })
    const { useChatContextMeasurement } = await loadFreshMeasurementHook()

    const { result } = renderHook(() => useChatContextMeasurement(true))

    expect(result.current).toEqual({ outcome: undefined, isPending: true })
    await waitFor(() => {
      expect(result.current.isPending).toBe(false)
    })
    expect(result.current.outcome).toEqual({
      status: "measured",
      measurement: FIXTURE_CHAT_CONTEXT_MEASUREMENT
    })
    expect(listMeasurementBodies(backend)).toEqual([
      {
        conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
        model: "qwen3-8b"
      }
    ])
  })

  it("starts no measurement while the composer is busy", async () => {
    const backend = startBackendFake({})
    const { useChatContextMeasurement } = await loadFreshMeasurementHook()

    const { result } = renderHook(() => useChatContextMeasurement(false))

    expect(result.current).toEqual({ outcome: undefined, isPending: false })
    expect(backend.requests).toEqual([])
  })

  it("measures the shown conversation again once its stored messages change, reporting the earlier outcome as pending meanwhile", async () => {
    const { route, responses } = createControlledRoute()
    const backend = startBackendFake({ [CHAT_CONTEXT_ROUTE]: route })
    const { useChatViewStore, useChatContextMeasurement } =
      await loadFreshMeasurementHook()
    const question = buildUserMessage(2, "Hello")
    act(() => {
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildConversation(FIXTURE_CONVERSATION_ID, null, [question])
        )
      })
    })
    const { result } = renderHook(() => useChatContextMeasurement(true))
    await waitFor(() => {
      expect(responses).toHaveLength(1)
    })
    await act(async () => {
      responses[0]?.resolve(
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
      )
    })
    await waitFor(() => {
      expect(result.current.isPending).toBe(false)
    })

    act(() => {
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildConversation(FIXTURE_CONVERSATION_ID, null, [
            question,
            buildCompletedAssistantMessage(3, "Hi")
          ])
        )
      })
    })

    expect(result.current).toEqual({
      outcome: {
        status: "measured",
        measurement: FIXTURE_CHAT_CONTEXT_MEASUREMENT
      },
      isPending: true
    })
    await waitFor(() => {
      expect(responses).toHaveLength(2)
    })
    expect(listMeasurementBodies(backend)).toEqual([
      {
        conversation: { kind: "existing", id: FIXTURE_CONVERSATION_ID },
        model: "qwen3-8b"
      },
      {
        conversation: { kind: "existing", id: FIXTURE_CONVERSATION_ID },
        model: "qwen3-8b"
      }
    ])
  })

  it("never publishes a measurement it abandoned for newer inputs", async () => {
    const { route, responses } = createControlledRoute()
    startBackendFake({ [CHAT_CONTEXT_ROUTE]: route })
    const { useChatViewStore, useChatContextMeasurement } =
      await loadFreshMeasurementHook()
    const { result } = renderHook(() => useChatContextMeasurement(true))
    await waitFor(() => {
      expect(responses).toHaveLength(1)
    })

    act(() => {
      useChatViewStore.getState().selectAgent("lysiptera")
    })
    await waitFor(() => {
      expect(responses).toHaveLength(2)
    })
    await act(async () => {
      responses[0]?.resolve(
        buildJsonResponse(200, {
          ...FIXTURE_CHAT_CONTEXT_MEASUREMENT,
          systemPromptTokens: 1
        })
      )
    })

    expect(result.current).toEqual({ outcome: undefined, isPending: true })
    await act(async () => {
      responses[1]?.resolve(
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
      )
    })
    await waitFor(() => {
      expect(result.current).toEqual({
        outcome: {
          status: "measured",
          measurement: FIXTURE_CHAT_CONTEXT_MEASUREMENT
        },
        isPending: false
      })
    })
  })

  it("measures with the tools the Tools pane would offer a model trained for tool use", async () => {
    const backend = startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
    })
    const { useLysStore, useToolStore, useChatContextMeasurement } =
      await loadFreshMeasurementHook()
    updateStoreRuntime(useLysStore, {
      ...READY_RUNTIME,
      modelInventory: {
        status: "ready",
        models: [
          buildLlmInfo("qwen3-8b", { loaded: true, trainedForToolUse: true })
        ]
      }
    })
    useToolStore.setState({
      list: {
        status: "loaded",
        tools: [READ_TEXT_FILE],
        unavailableTools: new Map()
      }
    })

    const { result } = renderHook(() => useChatContextMeasurement(true))
    await waitFor(() => {
      expect(result.current.isPending).toBe(false)
    })

    expect(listMeasurementBodies(backend)).toEqual([
      {
        conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
        model: "qwen3-8b",
        tools: { definitions: [READ_TEXT_FILE] }
      }
    ])
  })

  it("starts reading a tool list that was never read when the next message would offer tools", async () => {
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
    })
    const { useLysStore, useToolStore, useChatContextMeasurement } =
      await loadFreshMeasurementHook()
    updateStoreRuntime(useLysStore, {
      ...READY_RUNTIME,
      modelInventory: {
        status: "ready",
        models: [
          buildLlmInfo("qwen3-8b", { loaded: true, trainedForToolUse: true })
        ]
      }
    })
    const loadTools = vi.fn(async () => undefined)
    useToolStore.setState({ loadTools })

    const { result } = renderHook(() => useChatContextMeasurement(true))
    await waitFor(() => {
      expect(result.current.isPending).toBe(false)
    })

    expect(loadTools).toHaveBeenCalledOnce()
  })

  it.each([
    [
      "a model LM Studio has not loaded",
      buildJsonResponse(503, {
        type: "urn:lys:problem:llm:model-not-loaded",
        title: "Model not loaded",
        status: 503,
        detail: "The model is not loaded in LM Studio."
      }),
      { status: "model-not-loaded" }
    ],
    [
      "a failed measurement",
      buildJsonResponse(500, { detail: "boom" }),
      {
        status: "failed",
        message: "The context could not be measured (HTTP 500)."
      }
    ]
  ])("reports %s", async (_scenario, response, outcome) => {
    startBackendFake({ [CHAT_CONTEXT_ROUTE]: () => response })
    const { useChatContextMeasurement } = await loadFreshMeasurementHook()

    const { result } = renderHook(() => useChatContextMeasurement(true))

    await waitFor(() => {
      expect(result.current).toEqual({ outcome, isPending: false })
    })
  })
})
