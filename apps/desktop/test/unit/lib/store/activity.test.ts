import { activityEventSchema, type ActivityEvent } from "@lys/protocol"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { BackendServerInfo } from "@/lib/store"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import type { ToolListState } from "@/lib/store/tools"
import {
  ACTIVITY_ROUTE,
  buildActivityReply,
  buildIdleActivityRoute
} from "../../support/activityFixtures"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  listRouteKeys,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendRoute
} from "../../support/backendFake"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildUserMessage,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import { waitForMicrotasks } from "../../support/settlement"
import { buildToolCall, buildToolDefinition } from "../../support/toolFixtures"

/** Backend whose health route answered. */
const RUNNING_BACKEND: BackendServerInfo = Object.freeze({ status: "running" })

/** Backend that does not run. */
const STOPPED_BACKEND: BackendServerInfo = Object.freeze({ status: "stopped" })

/** Snapshot that starts a stream while no backend-started reply generates. */
const EMPTY_SNAPSHOT_EVENT = activityEventSchema.parse({
  type: "activity-snapshot",
  replies: []
})

/**
 * Loads fresh stores from one module graph, with the backend at
 * {@link FIXTURE_BACKEND_URL}, and registers the activity follow until the
 * case ends.
 *
 * @param backendServerInfo - Backend status published before the
 * registration.
 * @returns The application store, the stores the follow hands events to, the
 * tool store, and the stop the registration returned.
 */
async function startActivityFollow(backendServerInfo: BackendServerInfo) {
  vi.resetModules()
  const { registerActivityFollow } = await import("@/lib/store/activity")
  const { useLysStore } = await import("@/lib/store")
  const { useToolStore } = await import("@/lib/store/tools")
  const { useToolCallStore } = await import("@/lib/store/tool-calls")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  useLysStore.setState({ backendUrl: FIXTURE_BACKEND_URL, backendServerInfo })
  const stopFollow = registerActivityFollow()
  onTestFinished(stopFollow)
  return {
    useLysStore,
    useToolStore,
    useToolCallStore,
    useChatViewStore,
    stopFollow
  }
}

/** Switches the case to fake timers until it ends. */
function startFakeTimers(): void {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

/**
 * Creates an activity route that answers each request with its own stream,
 * which sent the given snapshot and stays open until the case closes it, the
 * client cancels it, or the case finishes.
 *
 * @param snapshotEvent - First event of every stream.
 * @returns The route and the streams it opened, in request order.
 */
function createActivityStreamRoute(snapshotEvent: ActivityEvent) {
  const streams: BackendEventStream[] = []
  const route: BackendRoute = () => {
    const stream = startBackendEventStream()
    stream.sendEvent(snapshotEvent)
    streams.push(stream)
    return stream.response
  }
  return { route, streams }
}

/**
 * Builds a route whose answers follow the given routes, one per request; the
 * last route answers every later request.
 *
 * @param routes - Routes in answer order, at least one.
 * @returns The route.
 */
function buildRouteInTurn(routes: readonly BackendRoute[]): BackendRoute {
  let answered = 0
  return (request) => {
    const route = routes[Math.min(answered, routes.length - 1)]
    answered += 1
    return route(request)
  }
}

describe("registerActivityFollow", () => {
  it.each([
    ["when the backend starts running", STOPPED_BACKEND],
    ["at once when the backend already runs", RUNNING_BACKEND]
  ] as const)(
    "opens the activity stream %s",
    async (_label, backendAtRegistration) => {
      const backend = startBackendFake({
        [ACTIVITY_ROUTE]: buildIdleActivityRoute()
      })
      const { useLysStore } = await startActivityFollow(backendAtRegistration)

      // The first row's backend starts running here; the second row's is
      // published as running again, which must not open a second stream.
      useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
      await waitForMicrotasks()

      expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE])
    }
  )

  it("opens nothing while the backend changes between states that are not running", async () => {
    const startingBackend: BackendServerInfo = { status: "starting" }
    const unresponsiveBackend: BackendServerInfo = { status: "unresponsive" }
    const backend = startBackendFake({})
    const { useLysStore } = await startActivityFollow(STOPPED_BACKEND)

    useLysStore.setState({ backendServerInfo: startingBackend })
    useLysStore.setState({ backendServerInfo: unresponsiveBackend })
    await waitForMicrotasks()

    expect(backend.requests).toEqual([])
  })

  it("hands each event to the tool-call store, then to the chat view", async () => {
    const jobCall = buildToolCall(70, "read_text_file")
    const jobPromptReply = buildActivityReply({
      pendingToolApprovals: [jobCall]
    })
    const jobPromptSnapshotEvent = activityEventSchema.parse({
      type: "activity-snapshot",
      replies: [jobPromptReply]
    })
    const mainConversation = buildConversation(
      FIXTURE_CONVERSATION_ID,
      "Main",
      [buildUserMessage(2, "Hello"), buildCompletedAssistantMessage(3, "Hi")]
    )
    const mainReadRoute = `GET /api/v1/conversations/${FIXTURE_CONVERSATION_ID}`
    const stores = await startActivityFollow(STOPPED_BACKEND)
    const activity = createActivityStreamRoute(jobPromptSnapshotEvent)
    const heldCallCountsAtRead: number[] = []
    const backend = startBackendFake({
      [ACTIVITY_ROUTE]: activity.route,
      [mainReadRoute]: () => {
        heldCallCountsAtRead.push(
          stores.useToolCallStore.getState().heldCalls.length
        )
        return buildJsonResponse(200, mainConversation)
      }
    })
    const readTextFileTool = buildToolDefinition("read_text_file")
    const noUnavailableTools = new Map<string, never>()
    const loadedToolList: ToolListState = {
      status: "loaded",
      tools: [readTextFileTool],
      unavailableTools: noUnavailableTools
    }
    stores.useToolStore.setState({ list: loadedToolList })
    const shownConversation = createStoredChatViewConversation(mainConversation)
    stores.useChatViewStore.setState({ conversation: shownConversation })

    stores.useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await vi.waitFor(() => {
      expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE, mainReadRoute])
    })

    const { heldCalls } = stores.useToolCallStore.getState()
    // The tool-call store held the prompt before the chat view read again.
    expect(heldCallCountsAtRead).toEqual([1])
    expect(heldCalls.map((heldCall) => heldCall.call.id)).toEqual([jobCall.id])
  })

  it("opens the stream again one second after the backend closes it", async () => {
    startFakeTimers()
    const activity = createActivityStreamRoute(EMPTY_SNAPSHOT_EVENT)
    const backend = startBackendFake({ [ACTIVITY_ROUTE]: activity.route })
    await startActivityFollow(RUNNING_BACKEND)
    await vi.advanceTimersByTimeAsync(5000)
    const requestsWhileOpen = backend.requests.length

    activity.streams[0]?.close()
    await vi.advanceTimersByTimeAsync(999)
    const requestsBeforeASecond = backend.requests.length
    await vi.advanceTimersByTimeAsync(1)

    expect([requestsWhileOpen, requestsBeforeASecond]).toEqual([1, 1])
    expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE, ACTIVITY_ROUTE])
  })

  it.each<[string, BackendRoute]>([
    ["a failed open", () => Promise.reject(createTransportFailure())],
    [
      "an event that does not match the contract",
      () => {
        const stream = startBackendEventStream()
        stream.sendEvent({ type: "nonsense" })
        return stream.response
      }
    ]
  ])(
    "opens the stream again one second after %s",
    async (_label, answerFirstRequest) => {
      startFakeTimers()
      const laterActivity = createActivityStreamRoute(EMPTY_SNAPSHOT_EVENT)
      const activityRoute = buildRouteInTurn([
        answerFirstRequest,
        laterActivity.route
      ])
      const backend = startBackendFake({ [ACTIVITY_ROUTE]: activityRoute })
      await startActivityFollow(RUNNING_BACKEND)

      await vi.advanceTimersByTimeAsync(999)
      const requestsBeforeASecond = backend.requests.length
      await vi.advanceTimersByTimeAsync(1)
      const requestsAfterASecond = backend.requests.length
      await vi.advanceTimersByTimeAsync(5000)

      expect([requestsBeforeASecond, requestsAfterASecond]).toEqual([1, 2])
      expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE, ACTIVITY_ROUTE])
      expect(laterActivity.streams[0]?.isCancelled()).toBe(false)
    }
  )

  it("stops following when the backend stops running", async () => {
    startFakeTimers()
    const activity = createActivityStreamRoute(EMPTY_SNAPSHOT_EVENT)
    const backend = startBackendFake({ [ACTIVITY_ROUTE]: activity.route })
    const { useLysStore } = await startActivityFollow(RUNNING_BACKEND)
    await waitForMicrotasks()

    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
    await waitForMicrotasks()
    const timersAfterStop = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(5000)

    expect(timersAfterStop).toBe(0)
    expect(activity.streams[0]?.isCancelled()).toBe(true)
    expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE])
  })

  it("opens a new stream in place of the old one when the backend runs again after it stopped", async () => {
    const activity = createActivityStreamRoute(EMPTY_SNAPSHOT_EVENT)
    const backend = startBackendFake({ [ACTIVITY_ROUTE]: activity.route })
    const { useLysStore } = await startActivityFollow(RUNNING_BACKEND)
    await waitForMicrotasks()

    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await waitForMicrotasks()

    expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE, ACTIVITY_ROUTE])
    expect(activity.streams.map((stream) => stream.isCancelled())).toEqual([
      true,
      false
    ])
  })

  it("stops following when unregistered, and no longer follows the backend", async () => {
    startFakeTimers()
    const activity = createActivityStreamRoute(EMPTY_SNAPSHOT_EVENT)
    const backend = startBackendFake({ [ACTIVITY_ROUTE]: activity.route })
    const { useLysStore, stopFollow } =
      await startActivityFollow(RUNNING_BACKEND)
    await waitForMicrotasks()

    stopFollow()
    await waitForMicrotasks()
    const timersAfterStop = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(5000)
    useLysStore.setState({ backendServerInfo: STOPPED_BACKEND })
    useLysStore.setState({ backendServerInfo: RUNNING_BACKEND })
    await waitForMicrotasks()

    expect(timersAfterStop).toBe(0)
    expect(activity.streams[0]?.isCancelled()).toBe(true)
    expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE])
  })

  it("stops following when unregistered while it waits to open the stream again", async () => {
    startFakeTimers()
    const activity = createActivityStreamRoute(EMPTY_SNAPSHOT_EVENT)
    const backend = startBackendFake({ [ACTIVITY_ROUTE]: activity.route })
    const { stopFollow } = await startActivityFollow(RUNNING_BACKEND)
    await waitForMicrotasks()
    activity.streams[0]?.close()
    await vi.advanceTimersByTimeAsync(500)

    stopFollow()
    await waitForMicrotasks()
    const timersAfterStop = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(5000)

    expect(timersAfterStop).toBe(0)
    expect(listRouteKeys(backend)).toEqual([ACTIVITY_ROUTE])
  })
})
