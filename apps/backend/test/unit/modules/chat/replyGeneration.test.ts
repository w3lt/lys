import type { ChatGenerationEvent } from "@lys/protocol"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import ReplyEventSubscription from "../../../../src/modules/chat/replyEventSubscription"
import ReplyGeneration from "../../../../src/modules/chat/replyGeneration"
import ControlledReplyTask from "../../support/controlledReplyTask"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"

/** First reply fragment a task sends. */
const FIRST_DELTA = Object.freeze({
  type: "delta",
  content: "Hi"
} satisfies ChatGenerationEvent)

/** Second reply fragment a task sends. */
const SECOND_DELTA = Object.freeze({
  type: "delta",
  content: " there"
} satisfies ChatGenerationEvent)

/** Title a title task sends while the reply is still streaming. */
const TITLE_EVENT = Object.freeze({
  type: "title",
  title: "Hanoi trip"
} satisfies ChatGenerationEvent)

/** Final event of a completed reply. */
const DONE_EVENT = Object.freeze({
  type: "done",
  finishReason: "stop"
} satisfies ChatGenerationEvent)

/** Event a follower queued before it was opened, like a reply snapshot. */
const QUEUED_EVENT = Object.freeze({
  type: "title",
  title: "Stored title"
} satisfies ChatGenerationEvent)

/**
 * Creates a follower whose connection accepts every write at once.
 *
 * @returns The follower and the events written to its connection, in write
 * order.
 */
function createRecordingFollower() {
  const written: ChatGenerationEvent[] = []
  const subscription = new ReplyEventSubscription<ChatGenerationEvent>(
    async (event) => {
      written.push(event)
    }
  )
  return { subscription, written }
}

/**
 * Starts a generation whose reply and title tasks the case settles.
 *
 * @returns The generation, both controlled tasks, and the reported task
 * failures in report order.
 * @remarks When the test finishes, both tasks are resolved, unless the case
 * already settled them, and the generation's settlement is awaited, so no
 * generation outlives its case.
 */
function startControlledGeneration() {
  const replyTask = new ControlledReplyTask()
  const titleTask = new ControlledReplyTask()
  const reportedFailures: unknown[] = []
  const generation = ReplyGeneration.start({
    startReplyTask: (context) => replyTask.start(context),
    startTitleTask: (context) => titleTask.start(context),
    reportTaskFailure: (error) => {
      reportedFailures.push(error)
    }
  })
  onTestFinished(async () => {
    replyTask.resolve()
    titleTask.resolve()
    await generation.settled
  })
  return { generation, replyTask, titleTask, reportedFailures }
}

describe("ReplyGeneration", () => {
  describe("start", () => {
    it("starts neither task before the caller's synchronous step ends", async () => {
      const { replyTask, titleTask } = startControlledGeneration()

      expect(replyTask.hasStarted).toBe(false)
      expect(titleTask.hasStarted).toBe(false)

      await waitForMicrotasks()
      expect(replyTask.hasStarted).toBe(true)
      expect(titleTask.hasStarted).toBe(true)
    })

    it("delivers an event sent as soon as a task starts to a follower opened in the same step", async () => {
      const reportedFailures: unknown[] = []
      const generation = ReplyGeneration.start({
        startReplyTask: async ({ sendEvent }) => {
          sendEvent(FIRST_DELTA)
        },
        startTitleTask: undefined,
        reportTaskFailure: (error) => {
          reportedFailures.push(error)
        }
      })
      const follower = createRecordingFollower()
      generation.openSubscription(follower.subscription)

      await generation.settled
      await follower.subscription.closed

      expect(follower.written).toEqual([FIRST_DELTA])
      expect(reportedFailures).toEqual([])
    })

    it.each(["reply", "title"] as const)(
      "reports a %s launcher that throws synchronously as a task failure",
      async (failingTask) => {
        const launcherFailure = new Error(`${failingTask} launcher failed`)
        const startFailingTask = (): Promise<void> => {
          throw launcherFailure
        }
        const reportedFailures: unknown[] = []
        let generation: ReplyGeneration | undefined

        expect(() => {
          generation = ReplyGeneration.start({
            startReplyTask:
              failingTask === "reply" ? startFailingTask : async () => {},
            startTitleTask:
              failingTask === "title" ? startFailingTask : async () => {},
            reportTaskFailure: (error) => {
              reportedFailures.push(error)
            }
          })
        }).not.toThrow()
        await generation?.settled

        expect(reportedFailures).toHaveLength(1)
        expect(reportedFailures[0]).toBe(launcherFailure)
      }
    )
  })

  describe("openSubscription", () => {
    it("sends every task event to every open follower in send order", async () => {
      const { generation, replyTask, titleTask } = startControlledGeneration()
      const firstFollower = createRecordingFollower()
      const secondFollower = createRecordingFollower()
      generation.openSubscription(firstFollower.subscription)
      generation.openSubscription(secondFollower.subscription)
      await waitForMicrotasks()

      replyTask.context.sendEvent(FIRST_DELTA)
      titleTask.context.sendEvent(TITLE_EVENT)
      replyTask.context.sendEvent(SECOND_DELTA)
      replyTask.context.sendEvent(DONE_EVENT)
      replyTask.resolve()
      titleTask.resolve()
      await generation.settled
      await Promise.all([
        firstFollower.subscription.closed,
        secondFollower.subscription.closed
      ])

      const expectedEvents = [
        FIRST_DELTA,
        TITLE_EVENT,
        SECOND_DELTA,
        DONE_EVENT
      ]
      expect(firstFollower.written).toEqual(expectedEvents)
      expect(secondFollower.written).toEqual(expectedEvents)
    })

    it("stops sending to a follower that ended while the others keep receiving", async () => {
      const { generation, replyTask } = startControlledGeneration()
      const closedFollower = createRecordingFollower()
      const remainingFollower = createRecordingFollower()
      const failingWrite = vi.fn(async () => {
        throw new Error("Connection closed")
      })
      const failingFollower = new ReplyEventSubscription<ChatGenerationEvent>(
        failingWrite
      )
      generation.openSubscription(closedFollower.subscription)
      generation.openSubscription(remainingFollower.subscription)
      generation.openSubscription(failingFollower)
      await waitForMicrotasks()

      replyTask.context.sendEvent(FIRST_DELTA)
      closedFollower.subscription.close()
      await failingFollower.closed
      replyTask.context.sendEvent(SECOND_DELTA)
      await waitForMicrotasks()

      expect(closedFollower.written).toEqual([FIRST_DELTA])
      expect(failingWrite).toHaveBeenCalledExactlyOnceWith(FIRST_DELTA)
      expect(remainingFollower.written).toEqual([FIRST_DELTA, SECOND_DELTA])
    })

    it("sends a follower opened mid-generation only later events, after its queued events", async () => {
      const { generation, replyTask } = startControlledGeneration()
      await waitForMicrotasks()
      replyTask.context.sendEvent(FIRST_DELTA)
      const lateFollower = createRecordingFollower()
      lateFollower.subscription.handleStreamEvent(QUEUED_EVENT)

      generation.openSubscription(lateFollower.subscription)
      replyTask.context.sendEvent(SECOND_DELTA)
      await waitForMicrotasks()

      expect(lateFollower.written).toEqual([QUEUED_EVENT, SECOND_DELTA])
    })

    it("closes a follower opened after settlement once its queued events are written", async () => {
      const { generation, replyTask, titleTask } = startControlledGeneration()
      replyTask.resolve()
      titleTask.resolve()
      await generation.settled
      const lateFollower = createRecordingFollower()
      lateFollower.subscription.handleStreamEvent(QUEUED_EVENT)

      generation.openSubscription(lateFollower.subscription)

      expect(lateFollower.subscription.handleStreamEvent(FIRST_DELTA)).toBe(
        false
      )
      await lateFollower.subscription.closed
      expect(lateFollower.written).toEqual([QUEUED_EVENT])
    })
  })

  describe("stopReply", () => {
    it("aborts only the reply task's signal and lets the title task keep sending", async () => {
      const { generation, replyTask, titleTask } = startControlledGeneration()
      const follower = createRecordingFollower()
      generation.openSubscription(follower.subscription)
      await waitForMicrotasks()

      void generation.stopReply()
      titleTask.context.sendEvent(TITLE_EVENT)
      await waitForMicrotasks()

      expect(replyTask.context.abortSignal.aborted).toBe(true)
      expect(titleTask.context.abortSignal.aborted).toBe(false)
      expect(follower.written).toEqual([TITLE_EVENT])
    })

    it("resolves only after the reply task settled, without waiting for the title task", async () => {
      const { generation, replyTask } = startControlledGeneration()
      await waitForMicrotasks()

      const stop = createSettlementReader(generation.stopReply())
      const settlement = createSettlementReader(generation.settled)
      await waitForMicrotasks()
      expect(stop()).toBe("pending")

      replyTask.resolve()
      await waitForMicrotasks()
      expect(stop()).toBe("fulfilled")
      expect(settlement()).toBe("pending")
    })

    it("resolves rather than rejecting when the reply task rejects", async () => {
      const { generation, replyTask } = startControlledGeneration()
      await waitForMicrotasks()
      const stop = generation.stopReply()

      replyTask.reject(new Error("Reply could not be stored"))

      await expect(stop).resolves.toBeUndefined()
    })

    it("can be called again while the stop is pending, and both calls resolve", async () => {
      const { generation, replyTask } = startControlledGeneration()
      await waitForMicrotasks()

      const firstStop = createSettlementReader(generation.stopReply())
      const secondStop = createSettlementReader(generation.stopReply())
      await waitForMicrotasks()
      expect(firstStop()).toBe("pending")
      expect(secondStop()).toBe("pending")
      expect(replyTask.context.abortSignal.aborted).toBe(true)

      replyTask.resolve()
      await waitForMicrotasks()
      expect(firstStop()).toBe("fulfilled")
      expect(secondStop()).toBe("fulfilled")
    })

    it("resolves at once on a settled generation", async () => {
      const { generation, replyTask, titleTask } = startControlledGeneration()
      replyTask.resolve()
      titleTask.resolve()
      await generation.settled

      const stop = createSettlementReader(generation.stopReply())
      await waitForMicrotasks()

      expect(stop()).toBe("fulfilled")
    })
  })

  describe("settled", () => {
    it.each([
      { firstSettled: "reply", lastSettled: "title" },
      { firstSettled: "title", lastSettled: "reply" }
    ] as const)(
      "stays pending after the $firstSettled task settles until the $lastSettled task settles too, then closes every follower",
      async ({ firstSettled }) => {
        const { generation, replyTask, titleTask, reportedFailures } =
          startControlledGeneration()
        const follower = createRecordingFollower()
        generation.openSubscription(follower.subscription)
        await waitForMicrotasks()
        const [firstTask, remainingTask] =
          firstSettled === "reply"
            ? [replyTask, titleTask]
            : [titleTask, replyTask]
        const settlement = createSettlementReader(generation.settled)

        firstTask.resolve()
        await waitForMicrotasks()
        expect(settlement()).toBe("pending")
        remainingTask.context.sendEvent(FIRST_DELTA)
        await waitForMicrotasks()
        expect(follower.written).toEqual([FIRST_DELTA])

        remainingTask.resolve()
        await generation.settled
        expect(follower.subscription.handleStreamEvent(SECOND_DELTA)).toBe(
          false
        )
        await follower.subscription.closed
        expect(follower.written).toEqual([FIRST_DELTA])
        expect(reportedFailures).toEqual([])
      }
    )

    it("settles after the reply task alone when no title task was requested", async () => {
      const replyTask = new ControlledReplyTask()
      const reportedFailures: unknown[] = []
      const generation = ReplyGeneration.start({
        startReplyTask: (context) => replyTask.start(context),
        startTitleTask: undefined,
        reportTaskFailure: (error) => {
          reportedFailures.push(error)
        }
      })
      const follower = createRecordingFollower()
      generation.openSubscription(follower.subscription)
      await waitForMicrotasks()

      replyTask.resolve()
      await generation.settled

      expect(follower.subscription.handleStreamEvent(FIRST_DELTA)).toBe(false)
      await follower.subscription.closed
      expect(reportedFailures).toEqual([])
    })

    it("reports each rejected task once, then settles and closes every follower", async () => {
      const { generation, replyTask, titleTask, reportedFailures } =
        startControlledGeneration()
      const follower = createRecordingFollower()
      generation.openSubscription(follower.subscription)
      await waitForMicrotasks()
      const replyFailure = new Error("Reply could not be stored")
      const titleFailure = new Error("Title could not be stored")

      replyTask.reject(replyFailure)
      titleTask.reject(titleFailure)
      await generation.settled

      expect(reportedFailures).toHaveLength(2)
      expect(reportedFailures).toContain(replyFailure)
      expect(reportedFailures).toContain(titleFailure)
      expect(follower.subscription.handleStreamEvent(FIRST_DELTA)).toBe(false)
      await follower.subscription.closed
    })
  })

  describe("[Symbol.asyncDispose]", () => {
    it("aborts both tasks' signals", async () => {
      const { generation, replyTask, titleTask } = startControlledGeneration()
      await waitForMicrotasks()

      void generation[Symbol.asyncDispose]()

      expect(replyTask.context.abortSignal.aborted).toBe(true)
      expect(titleTask.context.abortSignal.aborted).toBe(true)
    })

    it("returns the generation's settlement on every call", async () => {
      const { generation } = startControlledGeneration()

      const firstDisposal = generation[Symbol.asyncDispose]()
      const secondDisposal = generation[Symbol.asyncDispose]()

      expect(firstDisposal).toBe(generation.settled)
      expect(secondDisposal).toBe(generation.settled)
    })

    it("resolves only after both tasks settled, with every follower closed", async () => {
      const { generation, replyTask, titleTask } = startControlledGeneration()
      const follower = createRecordingFollower()
      generation.openSubscription(follower.subscription)
      await waitForMicrotasks()

      const disposal = createSettlementReader(generation[Symbol.asyncDispose]())
      await waitForMicrotasks()
      expect(disposal()).toBe("pending")
      replyTask.resolve()
      await waitForMicrotasks()
      expect(disposal()).toBe("pending")

      titleTask.resolve()
      await waitForMicrotasks()
      expect(disposal()).toBe("fulfilled")
      expect(follower.subscription.handleStreamEvent(FIRST_DELTA)).toBe(false)
    })
  })
})
