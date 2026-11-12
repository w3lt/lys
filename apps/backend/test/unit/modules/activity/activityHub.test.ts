import {
  activityEventSchema,
  type ActivityEvent,
  type ChatGenerationEvent,
  type ChatToolCall
} from "@lys/protocol"
import type { Job } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import ActivityHub, {
  type ActivityReplyTarget
} from "../../../../src/modules/activity/activityHub"
import ReplyEventSubscription from "../../../../src/modules/chat/replyEventSubscription"
import ReplyGeneration, {
  type ReplyTaskContext
} from "../../../../src/modules/chat/replyGeneration"
import ControlledReplyTask from "../../support/controlledReplyTask"
import {
  createFixtureUuidV7,
  createTextPart,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"

/** Main conversation the followed job was started from. */
const MAIN_CONVERSATION_ID = createFixtureUuidV7(1)

/** A job's reply the backend started. */
const JOB_REPLY = Object.freeze({
  conversationId: createFixtureUuidV7(2),
  parentConversationId: MAIN_CONVERSATION_ID,
  assistantMessageId: createFixtureUuidV7(3)
} satisfies ActivityReplyTarget)

/** A wake-up reply the backend started in the main conversation. */
const WAKE_UP_REPLY = Object.freeze({
  conversationId: MAIN_CONVERSATION_ID,
  parentConversationId: null,
  assistantMessageId: createFixtureUuidV7(4)
} satisfies ActivityReplyTarget)

/** Call a followed reply shows the person for approval. */
const APPROVAL_CALL = Object.freeze({
  id: createFixtureUuidV7(10),
  toolName: "read_page",
  arguments: Object.freeze({ url: "https://example.com/" })
} satisfies ChatToolCall)

/** Call of a desktop tool a followed reply sends to run. */
const DESKTOP_TOOL_CALL = Object.freeze({
  id: createFixtureUuidV7(11),
  toolName: "read_text_file",
  arguments: Object.freeze({ path: "/notes/todo.md" })
} satisfies ChatToolCall)

/** The job of {@link JOB_REPLY} while that reply works. */
const WORKING_JOB = Object.freeze({
  id: JOB_REPLY.conversationId,
  number: 1,
  agentCode: "lysiptera",
  title: "Compare the two plans",
  state: "working",
  latestNote: null,
  replyId: JOB_REPLY.assistantMessageId,
  jobCallIds: Object.freeze([createFixtureUuidV7(20)]),
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP
} satisfies Job)

/** The same job once its reply completed. */
const REPLIED_JOB = Object.freeze({
  ...WORKING_JOB,
  state: "replied"
} satisfies Job)

/** Event that reports {@link WORKING_JOB} to the main conversation. */
const WORKING_JOB_UPDATE = Object.freeze({
  type: "job-updated",
  parentConversationId: MAIN_CONVERSATION_ID,
  job: WORKING_JOB
} satisfies ActivityEvent)

/** Event that reports {@link REPLIED_JOB} to the main conversation. */
const REPLIED_JOB_UPDATE = Object.freeze({
  type: "job-updated",
  parentConversationId: MAIN_CONVERSATION_ID,
  job: REPLIED_JOB
} satisfies ActivityEvent)

/**
 * One generation event of every kind the activity stream does not carry, by
 * its type; a kind added to the generation events must be placed here or
 * among the forwarded ones.
 */
const UNFORWARDED_EVENTS = Object.freeze({
  title: { type: "title", title: "Trip plan" },
  "reply-part": {
    type: "reply-part",
    part: createTextPart({ sequence: 30, round: 0, content: "Here is" })
  },
  "reply-part-delta": {
    type: "reply-part-delta",
    partId: createFixtureUuidV7(30),
    content: " a plan",
    updatedAt: FIXTURE_TIMESTAMP
  },
  sources: {
    type: "sources",
    sources: [{ number: 1, url: "https://trips.example/", title: "Trips" }]
  },
  done: { type: "done", finishReason: "stop" },
  interrupted: { type: "interrupted" },
  error: { type: "error", message: "The model stopped answering." }
} satisfies {
  [
    Type in Exclude<ChatGenerationEvent["type"], "tool-approval" | "tool-call">
  ]: Extract<ChatGenerationEvent, { type: Type }>
})

/**
 * Most events offered while measuring a stream's queue capacity, so a queue
 * that never refuses an event fails the case instead of growing forever.
 */
const CAPACITY_PROBE_EVENT_LIMIT = 100_000

/**
 * Builds the snapshot of a hub that follows these replies while none of
 * them waits on a call.
 *
 * @param targets - Followed replies, in the order they were added.
 * @returns The `activity-snapshot` event a new stream starts with.
 */
function buildIdleSnapshot(
  targets: readonly ActivityReplyTarget[]
): ActivityEvent {
  return {
    type: "activity-snapshot",
    replies: targets.map((target) => ({
      ...target,
      pendingToolCalls: [],
      pendingToolApprovals: []
    }))
  }
}

/** Snapshot of a hub that follows no reply. */
const EMPTY_SNAPSHOT = buildIdleSnapshot([])

/**
 * Fails the case for a task failure that no case arranges.
 *
 * @param error - What the generation reported.
 * @throws Always.
 */
function handleUnexpectedTaskFailure(error: unknown): never {
  throw new Error("Unexpected reply task failure", { cause: error })
}

/**
 * Starts a real generation whose reply task the case controls, without a
 * title task, as the backend starts a job's reply or a wake-up reply.
 *
 * @returns The generation and its controlled reply task.
 * @remarks When the test finishes, the reply task is resolved, unless the
 * case already settled it, and the generation's settlement is awaited, so no
 * generation outlives its case.
 */
function startControlledGeneration() {
  const replyTask = new ControlledReplyTask<ReplyTaskContext>()
  const generation = ReplyGeneration.start({
    startReplyTask: (context) => replyTask.start(context),
    startTitleTask: undefined,
    reportTaskFailure: handleUnexpectedTaskFailure
  })
  onTestFinished(async () => {
    replyTask.resolve()
    await generation.settled
  })
  return { generation, replyTask }
}

/**
 * Opens a stream whose connection accepts every write at once.
 *
 * @param hub - Hub the stream follows.
 * @returns The stream's subscription and the events written to its
 * connection, in write order.
 */
function openRecordingStream(hub: ActivityHub) {
  const written: ActivityEvent[] = []
  const subscription = hub.openStream(async (event) => {
    written.push(event)
  })
  return { subscription, written }
}

/**
 * Opens a stream whose writes all stay pending until the case opens its
 * gate, as a connection whose client reads nothing.
 *
 * @param hub - Hub the stream follows.
 * @returns The stream's subscription, the events whose write started in
 * start order, and an operation that lets every started and later write
 * succeed.
 */
function openGatedStream(hub: ActivityHub) {
  const startedEvents: ActivityEvent[] = []
  const gate = Promise.withResolvers<void>()
  const subscription = hub.openStream(async (event) => {
    startedEvents.push(event)
    await gate.promise
  })
  return {
    subscription,
    startedEvents,
    open: () => {
      gate.resolve()
    }
  }
}

/**
 * Starts recording the followers a generation is given.
 *
 * @param generation - Generation a hub is about to follow.
 * @returns The subscriptions opened on the generation from now on, in the
 * order opened; the generation still receives each one.
 */
function recordFollowers(generation: ReplyGeneration) {
  const followers: ReplyEventSubscription<ChatGenerationEvent>[] = []
  const openSubscription = generation.openSubscription.bind(generation)
  vi.spyOn(generation, "openSubscription").mockImplementation(
    (subscription) => {
      followers.push(subscription)
      openSubscription(subscription)
    }
  )
  return followers
}

/**
 * Offers events to a subscription whose writes never settle until it
 * refuses one.
 *
 * @param subscription - Subscription that has accepted nothing yet.
 * @returns The number of events accepted before the first refusal: the
 * queue capacity of one stream.
 * @throws If no event was refused within {@link CAPACITY_PROBE_EVENT_LIMIT}.
 */
function offerEventsUntilRefused(
  subscription: ReplyEventSubscription<ActivityEvent>
): number {
  for (let accepted = 0; accepted < CAPACITY_PROBE_EVENT_LIMIT; accepted += 1) {
    if (!subscription.handleStreamEvent(WORKING_JOB_UPDATE)) return accepted
  }
  throw new Error("The subscription never refused an event")
}

describe("ActivityHub", () => {
  describe("openStream", () => {
    it("sends activity-snapshot first, with every reply it follows and each one's pending prompts and desktop tool calls", async () => {
      const hub = new ActivityHub()
      const job = startControlledGeneration()
      const wakeUp = startControlledGeneration()
      hub.addReply(JOB_REPLY, job.generation)
      hub.addReply(WAKE_UP_REPLY, wakeUp.generation)
      await waitForMicrotasks()
      void job.replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      void job.replyTask.context.sendClientToolCall(DESKTOP_TOOL_CALL)
      // Both calls reach the hub before any stream connects, so the stream
      // below learns of them from its snapshot alone.
      await waitForMicrotasks()

      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        {
          type: "activity-snapshot",
          replies: [
            {
              ...JOB_REPLY,
              pendingToolCalls: [DESKTOP_TOOL_CALL],
              pendingToolApprovals: [APPROVAL_CALL]
            },
            {
              ...WAKE_UP_REPLY,
              pendingToolCalls: [],
              pendingToolApprovals: []
            }
          ]
        }
      ])
    })

    it("lists what a reply waits on at that moment: a prompt the person answered is left out of the next snapshot", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()
      hub.addReply(JOB_REPLY, generation)
      await waitForMicrotasks()
      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      void replyTask.context.sendClientToolCall(DESKTOP_TOOL_CALL)
      await waitForMicrotasks()

      generation.resolveToolCall(APPROVAL_CALL.id, { status: "allowed" })
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        {
          type: "activity-snapshot",
          replies: [
            {
              ...JOB_REPLY,
              pendingToolCalls: [DESKTOP_TOOL_CALL],
              pendingToolApprovals: []
            }
          ]
        }
      ])
    })

    it("shows a prompt sent in the step that opens a stream in its snapshot and again as an event", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()
      hub.addReply(JOB_REPLY, generation)
      await waitForMicrotasks()

      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        {
          type: "activity-snapshot",
          replies: [
            {
              ...JOB_REPLY,
              pendingToolCalls: [],
              pendingToolApprovals: [APPROVAL_CALL]
            }
          ]
        },
        { type: "tool-approval", ...JOB_REPLY, call: APPROVAL_CALL }
      ])
    })

    it("builds the snapshot and adds the stream in one step: an event sent right after openStream arrives after the snapshot, never before and never lost", async () => {
      const hub = new ActivityHub()
      const { generation } = startControlledGeneration()

      const stream = openRecordingStream(hub)
      hub.addReply(JOB_REPLY, generation)
      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        EMPTY_SNAPSHOT,
        { type: "reply-started", ...JOB_REPLY },
        WORKING_JOB_UPDATE
      ])
    })

    it("accepts every call while no stream is connected, and replays nothing to a stream that connects later", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()

      hub.addReply(JOB_REPLY, generation)
      await waitForMicrotasks()
      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      await waitForMicrotasks()
      hub.removeReply(JOB_REPLY.assistantMessageId, "completed")
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(stream.written).toEqual([EMPTY_SNAPSHOT])
    })
  })

  describe("addReply", () => {
    it("sends reply-started with the conversation, its parent, and the reply", async () => {
      const hub = new ActivityHub()
      const stream = openRecordingStream(hub)
      const { generation } = startControlledGeneration()

      hub.addReply(JOB_REPLY, generation)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        EMPTY_SNAPSHOT,
        {
          type: "reply-started",
          conversationId: JOB_REPLY.conversationId,
          parentConversationId: MAIN_CONVERSATION_ID,
          assistantMessageId: JOB_REPLY.assistantMessageId
        }
      ])
    })

    it("keeps its own copy of the conversation, its parent, and the reply, so nothing else the given target carries or later becomes reaches an event", async () => {
      const hub = new ActivityHub()
      const stream = openRecordingStream(hub)
      const { generation } = startControlledGeneration()
      const givenTarget = { ...JOB_REPLY, startedBy: "backend" }

      hub.addReply(givenTarget, generation)
      givenTarget.conversationId = createFixtureUuidV7(99)
      const laterStream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        EMPTY_SNAPSHOT,
        { type: "reply-started", ...JOB_REPLY }
      ])
      expect(laterStream.written).toEqual([buildIdleSnapshot([JOB_REPLY])])
    })

    it("forwards a tool-approval event of a followed reply with that reply's target and the call", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()
      hub.addReply(JOB_REPLY, generation)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        buildIdleSnapshot([JOB_REPLY]),
        { type: "tool-approval", ...JOB_REPLY, call: APPROVAL_CALL }
      ])
    })

    it("forwards a tool-call event of a followed reply with that reply's target, not another followed reply's", async () => {
      const hub = new ActivityHub()
      const job = startControlledGeneration()
      const wakeUp = startControlledGeneration()
      hub.addReply(JOB_REPLY, job.generation)
      hub.addReply(WAKE_UP_REPLY, wakeUp.generation)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      void wakeUp.replyTask.context.sendClientToolCall(DESKTOP_TOOL_CALL)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        buildIdleSnapshot([JOB_REPLY, WAKE_UP_REPLY]),
        { type: "tool-call", ...WAKE_UP_REPLY, call: DESKTOP_TOOL_CALL }
      ])
    })

    it("forwards no reply-part, reply-part-delta, sources, title, done, interrupted, or error event, and keeps following the reply after them", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()
      hub.addReply(JOB_REPLY, generation)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      for (const event of Object.values(UNFORWARDED_EVENTS))
        replyTask.context.sendEvent(event)
      await waitForMicrotasks()
      const writtenAfterUnforwardedEvents = [...stream.written]
      // The hub has handled every event above, so this prompt shows that it
      // still follows the reply.
      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      await waitForMicrotasks()

      expect(writtenAfterUnforwardedEvents).toEqual([
        buildIdleSnapshot([JOB_REPLY])
      ])
      expect(stream.written).toEqual([
        buildIdleSnapshot([JOB_REPLY]),
        { type: "tool-approval", ...JOB_REPLY, call: APPROVAL_CALL }
      ])
    })

    it("refuses a reply it already follows and keeps following the first generation only", async () => {
      const hub = new ActivityHub()
      const first = startControlledGeneration()
      const second = startControlledGeneration()
      hub.addReply(JOB_REPLY, first.generation)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(() => {
        hub.addReply(JOB_REPLY, second.generation)
      }).toThrow("This reply is already followed")
      void second.replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      void first.replyTask.context.sendClientToolCall(DESKTOP_TOOL_CALL)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        buildIdleSnapshot([JOB_REPLY]),
        { type: "tool-call", ...JOB_REPLY, call: DESKTOP_TOOL_CALL }
      ])
    })
  })

  describe("removeReply", () => {
    it.each([
      ["the stored status completed", "completed"],
      ["the stored status interrupted", "interrupted"],
      ["the stored status failed", "failed"],
      ["null for a reply that is no longer stored", null]
    ] as const)(
      "sends reply-ended with %s and leaves the reply out of the next snapshot",
      async (_label, status) => {
        const hub = new ActivityHub()
        const { generation } = startControlledGeneration()
        hub.addReply(JOB_REPLY, generation)
        const stream = openRecordingStream(hub)

        hub.removeReply(JOB_REPLY.assistantMessageId, status)
        const laterStream = openRecordingStream(hub)
        await waitForMicrotasks()

        expect(stream.written).toEqual([
          buildIdleSnapshot([JOB_REPLY]),
          { type: "reply-ended", ...JOB_REPLY, status }
        ])
        expect(laterStream.written).toEqual([EMPTY_SNAPSHOT])
      }
    )

    it("sends no prompt or tool call of a reply after its reply-ended", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()
      hub.addReply(JOB_REPLY, generation)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      // The prompt is still on its way to the hub when the reply is removed;
      // the tool call is sent after the removal.
      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      hub.removeReply(JOB_REPLY.assistantMessageId, "interrupted")
      void replyTask.context.sendClientToolCall(DESKTOP_TOOL_CALL)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        buildIdleSnapshot([JOB_REPLY]),
        { type: "reply-ended", ...JOB_REPLY, status: "interrupted" }
      ])
    })

    it("closes its subscription on the removed reply's generation, and on no other", async () => {
      const hub = new ActivityHub()
      const job = startControlledGeneration()
      const wakeUp = startControlledGeneration()
      const jobFollowers = recordFollowers(job.generation)
      const wakeUpFollowers = recordFollowers(wakeUp.generation)
      hub.addReply(JOB_REPLY, job.generation)
      hub.addReply(WAKE_UP_REPLY, wakeUp.generation)
      const readClosures = [...jobFollowers, ...wakeUpFollowers].map(
        (follower) => createSettlementReader(follower.closed)
      )
      await waitForMicrotasks()
      const closuresWhileFollowed = readClosures.map((read) => read())

      hub.removeReply(JOB_REPLY.assistantMessageId, "completed")
      await waitForMicrotasks()

      expect(closuresWhileFollowed).toEqual(["pending", "pending"])
      expect(readClosures.map((read) => read())).toEqual([
        "fulfilled",
        "pending"
      ])
    })

    it("sends nothing for the end of a reply it does not follow", async () => {
      const hub = new ActivityHub()
      const { generation } = startControlledGeneration()
      hub.addReply(JOB_REPLY, generation)
      hub.removeReply(JOB_REPLY.assistantMessageId, "completed")
      const stream = openRecordingStream(hub)

      hub.removeReply(JOB_REPLY.assistantMessageId, "completed")
      hub.removeReply(WAKE_UP_REPLY.assistantMessageId, "failed")
      await waitForMicrotasks()

      expect(stream.written).toEqual([EMPTY_SNAPSHOT])
    })
  })

  describe("sendJobUpdate", () => {
    it("sends job-updated with the parent and the whole job", async () => {
      const hub = new ActivityHub()
      const stream = openRecordingStream(hub)

      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        EMPTY_SNAPSHOT,
        {
          type: "job-updated",
          parentConversationId: MAIN_CONVERSATION_ID,
          job: WORKING_JOB
        }
      ])
    })
  })

  describe("streams", () => {
    it("sends every kind of event as the activity contract defines it", async () => {
      const hub = new ActivityHub()
      const { generation, replyTask } = startControlledGeneration()
      const stream = openRecordingStream(hub)
      hub.addReply(JOB_REPLY, generation)
      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      await waitForMicrotasks()
      void replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      void replyTask.context.sendClientToolCall(DESKTOP_TOOL_CALL)
      await waitForMicrotasks()
      const laterStream = openRecordingStream(hub)
      hub.removeReply(JOB_REPLY.assistantMessageId, "completed")
      await waitForMicrotasks()

      const events = [...stream.written, ...laterStream.written]
      expect(events.map((event) => event.type)).toEqual([
        "activity-snapshot",
        "reply-started",
        "job-updated",
        "tool-approval",
        "tool-call",
        "reply-ended",
        "activity-snapshot",
        "reply-ended"
      ])
      for (const event of events)
        expect(activityEventSchema.safeParse(event).success).toBe(true)
    })

    it("keeps sending to the other streams after one stream's write failed", async () => {
      const hub = new ActivityHub()
      const failedStream = hub.openStream(async () => {
        throw new Error("SSE connection closed")
      })
      const stream = openRecordingStream(hub)
      await failedStream.closed

      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      hub.sendJobUpdate(MAIN_CONVERSATION_ID, REPLIED_JOB)
      await waitForMicrotasks()

      expect(stream.written).toEqual([
        EMPTY_SNAPSHOT,
        WORKING_JOB_UPDATE,
        REPLIED_JOB_UPDATE
      ])
    })

    it("closes a stream whose queue is full, and keeps sending to the others", async () => {
      const capacity = offerEventsUntilRefused(
        new ReplyEventSubscription<ActivityEvent>(
          () => new Promise<void>(() => {})
        )
      )
      const hub = new ActivityHub()
      const stalledStream = openGatedStream(hub)
      const stalledClosure = createSettlementReader(
        stalledStream.subscription.closed
      )
      // The snapshot holds one place of the stalled stream's queue, so one
      // update fewer than its capacity fills it.
      for (let sent = 1; sent < capacity; sent += 1)
        hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      const stream = openRecordingStream(hub)

      hub.sendJobUpdate(MAIN_CONVERSATION_ID, REPLIED_JOB)
      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      stalledStream.open()
      await waitForMicrotasks()

      expect(stalledClosure()).toBe("fulfilled")
      expect(stalledStream.startedEvents).toHaveLength(capacity)
      expect(stalledStream.startedEvents).not.toContainEqual(REPLIED_JOB_UPDATE)
      expect(stream.written).toEqual([
        EMPTY_SNAPSHOT,
        REPLIED_JOB_UPDATE,
        WORKING_JOB_UPDATE
      ])
    })
  })

  describe("close", () => {
    it("closes every stream on close, and gives a closed subscription to a later openStream", async () => {
      const hub = new ActivityHub()
      const firstStream = openRecordingStream(hub)
      const secondStream = openRecordingStream(hub)
      const firstClosure = createSettlementReader(
        firstStream.subscription.closed
      )
      const secondClosure = createSettlementReader(
        secondStream.subscription.closed
      )

      hub.close()
      hub.close()
      const lateStream = openRecordingStream(hub)
      const lateClosure = createSettlementReader(lateStream.subscription.closed)
      await waitForMicrotasks()

      expect(firstClosure()).toBe("fulfilled")
      expect(secondClosure()).toBe("fulfilled")
      expect(lateClosure()).toBe("fulfilled")
      expect(firstStream.written).toEqual([EMPTY_SNAPSHOT])
      expect(secondStream.written).toEqual([EMPTY_SNAPSHOT])
      expect(lateStream.written).toEqual([])
    })

    it("closes its subscription on every followed generation and leaves the generations running", async () => {
      const hub = new ActivityHub()
      const job = startControlledGeneration()
      const wakeUp = startControlledGeneration()
      const jobFollowers = recordFollowers(job.generation)
      const wakeUpFollowers = recordFollowers(wakeUp.generation)
      hub.addReply(JOB_REPLY, job.generation)
      hub.addReply(WAKE_UP_REPLY, wakeUp.generation)
      const readClosures = [...jobFollowers, ...wakeUpFollowers].map(
        (follower) => createSettlementReader(follower.closed)
      )
      await waitForMicrotasks()
      const closuresWhileOpen = readClosures.map((read) => read())

      hub.close()
      await waitForMicrotasks()

      expect(closuresWhileOpen).toEqual(["pending", "pending"])
      expect(readClosures.map((read) => read())).toEqual([
        "fulfilled",
        "fulfilled"
      ])
      expect(job.replyTask.context.abortSignal.aborted).toBe(false)
      expect(wakeUp.replyTask.context.abortSignal.aborted).toBe(false)
    })

    it("accepts every call after close, sends nothing, and follows no generation", async () => {
      const hub = new ActivityHub()
      const job = startControlledGeneration()
      const wakeUp = startControlledGeneration()
      const wakeUpFollowers = recordFollowers(wakeUp.generation)
      hub.addReply(JOB_REPLY, job.generation)
      const stream = openRecordingStream(hub)
      await waitForMicrotasks()

      // The prompt is still on its way to the hub when the hub closes.
      void job.replyTask.context.sendToolApprovalPrompt(APPROVAL_CALL)
      hub.close()
      hub.sendJobUpdate(MAIN_CONVERSATION_ID, WORKING_JOB)
      hub.removeReply(JOB_REPLY.assistantMessageId, "interrupted")
      hub.addReply(WAKE_UP_REPLY, wakeUp.generation)
      hub.removeReply(WAKE_UP_REPLY.assistantMessageId, "interrupted")
      const lateStream = openRecordingStream(hub)
      await waitForMicrotasks()

      expect(stream.written).toEqual([buildIdleSnapshot([JOB_REPLY])])
      expect(lateStream.written).toEqual([])
      expect(wakeUpFollowers).toEqual([])
    })
  })
})
