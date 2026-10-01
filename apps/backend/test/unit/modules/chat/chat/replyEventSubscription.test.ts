import type { ChatGenerationEvent } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import ReplyEventSubscription from "../../../../../src/modules/chat/chat/replyEventSubscription"
import { flushMicrotasks } from "../../../support/microtasks"
import { observeSettlement } from "../../../support/settlement"

/**
 * Most events offered while measuring a subscription's queue capacity, so a
 * queue that never refuses an event fails the case instead of growing forever.
 */
const CAPACITY_PROBE_EVENT_LIMIT = 1_000_000

/** Failure a connection writer reports once the connection has closed. */
const CLOSED_CONNECTION_FAILURE = Object.freeze(
  new Error("SSE connection closed")
)

/** Connection writer whose writes the case settles one at a time. */
type ControlledWriter = Readonly<{
  /** Writer handed to the subscription; each write stays pending. */
  sendEvent: (event: ChatGenerationEvent) => Promise<void>
  /** Events whose write started, in start order. */
  startedEvents: readonly ChatGenerationEvent[]
  /** Lets the write started at a zero-based position succeed. */
  resolveWrite: (position: number) => void
  /** Fails the write started at a zero-based position. */
  rejectWrite: (position: number, error: Error) => void
}>

/** Connection writer whose writes all wait for one gate. */
type GatedWriter = Readonly<{
  /** Writer handed to the subscription; each write waits for the gate. */
  sendEvent: (event: ChatGenerationEvent) => Promise<void>
  /** Events whose write started, in start order. */
  startedEvents: readonly ChatGenerationEvent[]
  /** Opens the gate, letting every started and later write succeed. */
  open: () => void
}>

/**
 * Creates a delta event distinguishable by its position.
 *
 * @param sequence - Position that tells the event apart in write order.
 * @returns A new delta event.
 */
function createDelta(sequence: number): ChatGenerationEvent {
  return { type: "delta", content: `chunk ${sequence}` }
}

/**
 * Creates a connection writer whose every write stays pending until the case
 * settles it.
 *
 * @returns The writer, the events whose write started in start order, and
 * operations that settle the write started at a position.
 * @remarks Settling a write that has not started throws, so a case that
 * expected a write to start fails at that point.
 */
function createControlledWriter(): ControlledWriter {
  const startedEvents: ChatGenerationEvent[] = []
  const writeCompletions: PromiseWithResolvers<void>[] = []

  /**
   * Finds the completion of a started write.
   *
   * @param position - Zero-based start order of the write.
   * @returns The write's completion.
   * @throws If no write has started at that position.
   */
  function requireWrite(position: number): PromiseWithResolvers<void> {
    const completion = writeCompletions[position]
    if (completion === undefined)
      throw new Error(`Write ${position} has not started`)
    return completion
  }

  return {
    sendEvent: async (event: ChatGenerationEvent): Promise<void> => {
      startedEvents.push(event)
      const completion = Promise.withResolvers<void>()
      writeCompletions.push(completion)
      return completion.promise
    },
    startedEvents,
    resolveWrite: (position: number) => {
      requireWrite(position).resolve()
    },
    rejectWrite: (position: number, error: Error) => {
      requireWrite(position).reject(error)
    }
  }
}

/**
 * Creates a connection writer whose writes all stay pending until the case
 * opens its gate.
 *
 * @returns The writer, the events whose write started in start order, and an
 * operation that lets every started and later write succeed.
 */
function createGatedWriter(): GatedWriter {
  const startedEvents: ChatGenerationEvent[] = []
  const gate = Promise.withResolvers<void>()
  return {
    sendEvent: async (event: ChatGenerationEvent): Promise<void> => {
      startedEvents.push(event)
      await gate.promise
    },
    startedEvents,
    open: () => {
      gate.resolve()
    }
  }
}

/**
 * Offers distinct deltas, numbered from zero, until the subscription refuses
 * one.
 *
 * @param subscription - Subscription whose writer holds its writes pending.
 * @returns The number of deltas accepted before the first refusal.
 * @throws If no delta was refused within {@link CAPACITY_PROBE_EVENT_LIMIT}.
 */
function offerUntilRefused(
  subscription: ReplyEventSubscription<ChatGenerationEvent>
): number {
  for (let accepted = 0; accepted < CAPACITY_PROBE_EVENT_LIMIT; accepted += 1) {
    if (!subscription.handleStreamEvent(createDelta(accepted))) return accepted
  }
  throw new Error("The subscription never refused an event")
}

describe("ReplyEventSubscription", () => {
  it("writes accepted events in acceptance order, each after the previous write settled", async () => {
    const writer = createControlledWriter()
    const subscription = new ReplyEventSubscription(writer.sendEvent)

    const accepted = [createDelta(1), createDelta(2), createDelta(3)].map(
      (event) => subscription.handleStreamEvent(event)
    )
    await flushMicrotasks()

    expect(accepted).toEqual([true, true, true])
    expect(writer.startedEvents).toEqual([createDelta(1)])

    writer.resolveWrite(0)
    await flushMicrotasks()

    expect(writer.startedEvents).toEqual([createDelta(1), createDelta(2)])

    writer.resolveWrite(1)
    await flushMicrotasks()

    expect(writer.startedEvents).toEqual([
      createDelta(1),
      createDelta(2),
      createDelta(3)
    ])
  })

  it("keeps closed pending while open, even with nothing queued", async () => {
    const subscription = new ReplyEventSubscription(
      createControlledWriter().sendEvent
    )
    const closedState = observeSettlement(subscription.closed)

    await flushMicrotasks()

    expect(closedState()).toBe("pending")
  })

  it("settles closed once closed with nothing queued", async () => {
    const subscription = new ReplyEventSubscription(
      createControlledWriter().sendEvent
    )
    const closedState = observeSettlement(subscription.closed)

    subscription.close()
    await flushMicrotasks()

    expect(closedState()).toBe("fulfilled")
  })

  it("refuses events after close and settles closed only after every accepted write settled", async () => {
    const writer = createControlledWriter()
    const subscription = new ReplyEventSubscription(writer.sendEvent)
    const closedState = observeSettlement(subscription.closed)
    subscription.handleStreamEvent(createDelta(1))
    subscription.handleStreamEvent(createDelta(2))
    await flushMicrotasks()

    subscription.close()
    subscription.close()
    const acceptedAfterClose = subscription.handleStreamEvent(createDelta(3))
    writer.resolveWrite(0)
    await flushMicrotasks()

    expect(acceptedAfterClose).toBe(false)
    expect(writer.startedEvents).toEqual([createDelta(1), createDelta(2)])
    expect(closedState()).toBe("pending")

    writer.resolveWrite(1)
    await flushMicrotasks()

    expect(closedState()).toBe("fulfilled")
    expect(writer.startedEvents).toEqual([createDelta(1), createDelta(2)])
  })

  it("ends after a failed write and settles closed without rejecting once accepted writes settled", async () => {
    const writer = createControlledWriter()
    const subscription = new ReplyEventSubscription(writer.sendEvent)
    const closedState = observeSettlement(subscription.closed)
    const accepted = [
      subscription.handleStreamEvent(createDelta(1)),
      subscription.handleStreamEvent(createDelta(2))
    ]
    await flushMicrotasks()

    writer.rejectWrite(0, CLOSED_CONNECTION_FAILURE)
    await flushMicrotasks()

    expect(accepted).toEqual([true, true])
    expect(subscription.handleStreamEvent(createDelta(3))).toBe(false)
    expect(closedState()).toBe("pending")

    writer.rejectWrite(1, CLOSED_CONNECTION_FAILURE)
    await flushMicrotasks()

    expect(closedState()).toBe("fulfilled")
    expect(writer.startedEvents).toEqual([createDelta(1), createDelta(2)])
  })

  it("refuses the event that would exceed its queue capacity and ends", async () => {
    const writer = createGatedWriter()
    const subscription = new ReplyEventSubscription(writer.sendEvent)
    const closedState = observeSettlement(subscription.closed)

    const capacity = offerUntilRefused(subscription)
    await flushMicrotasks()

    expect(capacity).toBeGreaterThan(1)
    expect(closedState()).toBe("pending")

    writer.open()
    await flushMicrotasks()

    expect(closedState()).toBe("fulfilled")
    expect(writer.startedEvents).toEqual(
      Array.from({ length: capacity }, (_, sequence) => createDelta(sequence))
    )
    expect(subscription.handleStreamEvent(createDelta(capacity))).toBe(false)
  })

  it("accepts exactly one more event at capacity after one queued write settled", async () => {
    const capacity = offerUntilRefused(
      new ReplyEventSubscription(createControlledWriter().sendEvent)
    )
    const writer = createControlledWriter()
    const subscription = new ReplyEventSubscription(writer.sendEvent)
    const accepted = Array.from({ length: capacity }, (_, sequence) =>
      subscription.handleStreamEvent(createDelta(sequence))
    )
    await flushMicrotasks()

    writer.resolveWrite(0)
    await flushMicrotasks()

    expect(accepted.filter(Boolean)).toHaveLength(capacity)
    expect(subscription.handleStreamEvent(createDelta(capacity))).toBe(true)
    expect(subscription.handleStreamEvent(createDelta(capacity + 1))).toBe(
      false
    )
  })
})
