import { describe, expect, it, onTestFinished, vi, type Mock } from "vitest"
import type { StartReplyGenerationOptions } from "../../../../src/modules/chat/replyGeneration"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../../src/modules/chat/replyGenerationRegistry"
import ControlledReplyTask from "../../support/controlledReplyTask"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"

/** Conversation whose replies share title tracking in the dedup cases. */
const CONVERSATION_X_ID = createFixtureUuidV7(1)

/** Conversation independent of {@link CONVERSATION_X_ID}. */
const CONVERSATION_Y_ID = createFixtureUuidV7(2)

/** First reply of conversation X. */
const FIRST_REPLY_OF_X: ReplyTarget = Object.freeze({
  conversationId: CONVERSATION_X_ID,
  assistantMessageId: createFixtureUuidV7(11)
})

/** Second reply of conversation X, distinct from {@link FIRST_REPLY_OF_X}. */
const SECOND_REPLY_OF_X: ReplyTarget = Object.freeze({
  conversationId: CONVERSATION_X_ID,
  assistantMessageId: createFixtureUuidV7(12)
})

/** Reply of conversation Y. */
const REPLY_OF_Y: ReplyTarget = Object.freeze({
  conversationId: CONVERSATION_Y_ID,
  assistantMessageId: createFixtureUuidV7(21)
})

/** Registry owned by one case, with the controls its generations use. */
type RegistryHarness = Readonly<{
  /** Registry under test; disposed when the test finishes. */
  registry: ReplyGenerationRegistry
  /** Reporter shared by every generation the case starts. */
  reportTaskFailure: Mock<(error: unknown) => void>
  /** Creates a pending task that teardown settles if the case did not. */
  createTask: () => ControlledReplyTask
  /**
   * Builds one generation's launchers from controlled tasks.
   *
   * @param replyTask - Task started as the reply.
   * @param titleTask - Task offered as the title, or undefined when the
   * conversation needs no title.
   * @returns Options using the harness reporter.
   */
  createLaunchers: (
    replyTask: ControlledReplyTask,
    titleTask?: ControlledReplyTask
  ) => StartReplyGenerationOptions
}>

/**
 * Creates a registry that is disposed when the test finishes.
 *
 * @returns The registry, its shared failure reporter, and task factories.
 * @remarks Teardown first resolves every task the case created, then awaits
 * disposal, so work a case leaves pending cannot make teardown wait forever.
 * Resolving an already settled or never started task changes nothing.
 */
function createRegistryHarness(): RegistryHarness {
  const registry = new ReplyGenerationRegistry()
  const tasks: ControlledReplyTask[] = []
  onTestFinished(async () => {
    for (const task of tasks) task.resolve()
    await registry[Symbol.asyncDispose]()
  })
  const reportTaskFailure = vi.fn<(error: unknown) => void>()
  return Object.freeze({
    registry,
    reportTaskFailure,
    createTask: () => {
      const task = new ControlledReplyTask()
      tasks.push(task)
      return task
    },
    createLaunchers: (replyTask, titleTask) => ({
      startReplyTask: (context) => replyTask.start(context),
      startTitleTask:
        titleTask === undefined
          ? undefined
          : (context) => titleTask.start(context),
      reportTaskFailure
    })
  })
}

describe("ReplyGenerationRegistry", () => {
  describe("startReplyGeneration and findReplyGeneration", () => {
    it("finds the running generation only by its reply and conversation", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const replyTask = createTask()

      const generation = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(replyTask)
      )
      await waitForMicrotasks()

      expect(replyTask.hasStarted).toBe(true)
      expect(registry.findReplyGeneration(FIRST_REPLY_OF_X)).toBe(generation)
      expect(
        registry.findReplyGeneration({
          conversationId: CONVERSATION_X_ID,
          assistantMessageId: SECOND_REPLY_OF_X.assistantMessageId
        })
      ).toBeUndefined()
      expect(
        registry.findReplyGeneration({
          conversationId: CONVERSATION_Y_ID,
          assistantMessageId: FIRST_REPLY_OF_X.assistantMessageId
        })
      ).toBeUndefined()
    })

    it("rejects a second generation for a running reply without starting it", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const running = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(createTask(), createTask())
      )
      const duplicateReply = createTask()
      const duplicateTitle = createTask()

      expect(() =>
        registry.startReplyGeneration(
          FIRST_REPLY_OF_X,
          createLaunchers(duplicateReply, duplicateTitle)
        )
      ).toThrow(Error)
      await waitForMicrotasks()

      expect(duplicateReply.hasStarted).toBe(false)
      expect(duplicateTitle.hasStarted).toBe(false)
      expect(registry.findReplyGeneration(FIRST_REPLY_OF_X)).toBe(running)
    })

    it("leaves no title tracking behind for a rejected duplicate", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const runningReply = createTask()
      const running = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(runningReply)
      )
      expect(() =>
        registry.startReplyGeneration(
          FIRST_REPLY_OF_X,
          createLaunchers(createTask(), createTask())
        )
      ).toThrow(Error)
      await waitForMicrotasks()
      runningReply.resolve()
      await running.settled
      const laterTitle = createTask()

      registry.startReplyGeneration(
        SECOND_REPLY_OF_X,
        createLaunchers(createTask(), laterTitle)
      )
      await waitForMicrotasks()

      expect(laterTitle.hasStarted).toBe(true)
    })

    it("forgets a settled generation so the same reply can start again", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const firstReply = createTask()
      const first = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(firstReply)
      )
      await waitForMicrotasks()
      firstReply.resolve()
      await first.settled
      await waitForMicrotasks()

      expect(registry.findReplyGeneration(FIRST_REPLY_OF_X)).toBeUndefined()

      const nextReply = createTask()
      const next = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(nextReply)
      )
      await waitForMicrotasks()

      expect(next).not.toBe(first)
      expect(registry.findReplyGeneration(FIRST_REPLY_OF_X)).toBe(next)
      expect(nextReply.hasStarted).toBe(true)
    })
  })

  describe("title tasks", () => {
    it("drops the title of a second generation while its conversation's title is running", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const firstReply = createTask()
      const firstTitle = createTask()
      const first = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(firstReply, firstTitle)
      )
      const secondReply = createTask()
      const secondTitle = createTask()

      const second = registry.startReplyGeneration(
        SECOND_REPLY_OF_X,
        createLaunchers(secondReply, secondTitle)
      )
      await waitForMicrotasks()
      const firstSettlement = createSettlementReader(first.settled)
      secondReply.resolve()
      await second.settled

      expect(firstTitle.hasStarted).toBe(true)
      expect(secondReply.hasStarted).toBe(true)
      expect(secondTitle.hasStarted).toBe(false)
      expect(firstSettlement()).toBe("pending")
    })

    it("runs the titles of different conversations concurrently", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const titleOfX = createTask()
      const titleOfY = createTask()

      registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(createTask(), titleOfX)
      )
      registry.startReplyGeneration(
        REPLY_OF_Y,
        createLaunchers(createTask(), titleOfY)
      )
      await waitForMicrotasks()

      expect(titleOfX.hasStarted).toBe(true)
      expect(titleOfY.hasStarted).toBe(true)
    })

    it("starts a later title once the running title settled, even while its generation still runs", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const firstTitle = createTask()
      const first = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(createTask(), firstTitle)
      )
      await waitForMicrotasks()
      const firstSettlement = createSettlementReader(first.settled)
      firstTitle.resolve()
      await waitForMicrotasks()
      const laterTitle = createTask()

      registry.startReplyGeneration(
        SECOND_REPLY_OF_X,
        createLaunchers(createTask(), laterTitle)
      )
      await waitForMicrotasks()

      expect(firstSettlement()).toBe("pending")
      expect(laterTitle.hasStarted).toBe(true)
    })

    it("ends title tracking when the title task rejects and reports the rejection", async () => {
      const { registry, reportTaskFailure, createTask, createLaunchers } =
        createRegistryHarness()
      const firstReply = createTask()
      const firstTitle = createTask()
      const titleFailure = new Error("title model unavailable")
      const first = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(firstReply, firstTitle)
      )
      await waitForMicrotasks()
      firstTitle.reject(titleFailure)
      await waitForMicrotasks()
      const laterTitle = createTask()

      registry.startReplyGeneration(
        SECOND_REPLY_OF_X,
        createLaunchers(createTask(), laterTitle)
      )
      await waitForMicrotasks()
      firstReply.resolve()
      await first.settled

      expect(laterTitle.hasStarted).toBe(true)
      expect(reportTaskFailure).toHaveBeenCalledExactlyOnceWith(titleFailure)
    })
  })

  describe("[Symbol.asyncDispose]", () => {
    it("cancels both tasks of every generation and resolves only after all settle", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const replyOfX = createTask()
      const titleOfX = createTask()
      const replyOfY = createTask()
      const titleOfY = createTask()
      const generationOfX = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(replyOfX, titleOfX)
      )
      const generationOfY = registry.startReplyGeneration(
        REPLY_OF_Y,
        createLaunchers(replyOfY, titleOfY)
      )
      await waitForMicrotasks()

      const disposal = registry[Symbol.asyncDispose]()
      const disposalSettlement = createSettlementReader(disposal)

      expect(
        [replyOfX, titleOfX, replyOfY, titleOfY].map(
          (task) => task.context.abortSignal.aborted
        )
      ).toEqual([true, true, true, true])
      replyOfX.resolve()
      titleOfX.resolve()
      replyOfY.resolve()
      await waitForMicrotasks()
      expect(disposalSettlement()).toBe("pending")

      const settlementOfX = createSettlementReader(generationOfX.settled)
      const settlementOfY = createSettlementReader(generationOfY.settled)
      titleOfY.resolve()
      await disposal

      expect(settlementOfX()).toBe("fulfilled")
      expect(settlementOfY()).toBe("fulfilled")
    })

    it("resolves and reports the failure when a cancelled task rejects", async () => {
      const { registry, reportTaskFailure, createTask, createLaunchers } =
        createRegistryHarness()
      const replyTask = createTask()
      const replyFailure = new Error("Reply failure could not be finalized")
      registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(replyTask)
      )
      await waitForMicrotasks()

      const disposal = registry[Symbol.asyncDispose]()
      replyTask.reject(replyFailure)

      await expect(disposal).resolves.toBeUndefined()
      expect(reportTaskFailure).toHaveBeenCalledExactlyOnceWith(replyFailure)
    })

    it("shares one completion across concurrent and repeated calls", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const replyTask = createTask()
      registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(replyTask)
      )
      await waitForMicrotasks()

      const first = registry[Symbol.asyncDispose]()
      const concurrent = registry[Symbol.asyncDispose]()
      replyTask.resolve()
      await first
      const repeated = registry[Symbol.asyncDispose]()

      expect(concurrent).toBe(first)
      expect(repeated).toBe(first)
    })

    it("resolves for a registry without generations", async () => {
      const { registry } = createRegistryHarness()

      await expect(registry[Symbol.asyncDispose]()).resolves.toBeUndefined()
    })

    it("rejects starting and finding generations once disposal began", async () => {
      const { registry, createTask, createLaunchers } = createRegistryHarness()
      const runningReply = createTask()
      const running = registry.startReplyGeneration(
        FIRST_REPLY_OF_X,
        createLaunchers(runningReply)
      )
      await waitForMicrotasks()
      expect(registry.findReplyGeneration(FIRST_REPLY_OF_X)).toBe(running)
      const disposal = registry[Symbol.asyncDispose]()
      const lateReply = createTask()
      const lateTitle = createTask()

      expect(() =>
        registry.startReplyGeneration(
          REPLY_OF_Y,
          createLaunchers(lateReply, lateTitle)
        )
      ).toThrow(Error)
      expect(() => registry.findReplyGeneration(FIRST_REPLY_OF_X)).toThrow(
        Error
      )
      runningReply.resolve()
      await disposal
      await waitForMicrotasks()

      expect(lateReply.hasStarted).toBe(false)
      expect(lateTitle.hasStarted).toBe(false)
      expect(() => registry.findReplyGeneration(FIRST_REPLY_OF_X)).toThrow(
        Error
      )
    })
  })
})
