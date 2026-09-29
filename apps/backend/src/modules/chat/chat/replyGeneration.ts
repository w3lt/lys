import type { ChatGenerationEvent } from "@lys/protocol"
import type ReplyEventSubscription from "./replyEventSubscription"

/** Capabilities a generation lends to one of its tasks. */
export type ReplyGenerationTaskContext = Readonly<{
  /** Cancellation owned by the generation for this task only. */
  abortSignal: AbortSignal
  /** Queues one event for every current follower; never waits or throws. */
  sendEvent: (event: ChatGenerationEvent) => void
}>

/** Work and failure reporting for one generation. */
export type StartReplyGenerationOptions = Readonly<{
  /** Runs the reply task; its signal is aborted by `stopReply` and disposal. */
  startReplyTask: (context: ReplyGenerationTaskContext) => Promise<void>
  /**
   * Runs the title task, or is absent when the conversation already has a
   * title. Its signal is aborted only by disposal.
   */
  startTitleTask:
    ((context: ReplyGenerationTaskContext) => Promise<void>) | undefined
  /** Records one task rejection; must not throw. The generation still settles. */
  reportTaskFailure: (error: unknown) => void
}>

/**
 * Owns one turn's running reply and title tasks, their cancellation, and the
 * streams that follow them.
 *
 * @remarks The invariant is that every follower receives each task event in
 * the order the tasks sent it, until the follower ends or the generation
 * settles. No HTTP connection owns the generation: a follower ending never
 * cancels work. Only `stopReply` (the reply) and disposal (both tasks) cancel
 * work. Tasks start in a later microtask, so the caller of
 * {@link ReplyGeneration.start} can register the generation and its first
 * followers in the same synchronous step. After both tasks settle, the
 * generation closes every follower and settles
 * {@link ReplyGeneration.settled}; a settled generation still accepts
 * `openSubscription` (closing the follower at once) and `stopReply`
 * (resolving at once), because a follower or stop request can race the
 * settlement. Concurrency model: single-owner, on the backend's event loop.
 */
export default class ReplyGeneration implements AsyncDisposable {
  /** Cancels the reply task for stop and shutdown. */
  readonly #replyController = new AbortController()
  /** Cancels the title task at shutdown only. */
  readonly #titleController = new AbortController()
  /** Followers receiving events until they end or the generation settles. */
  readonly #subscriptions = new Set<
    ReplyEventSubscription<ChatGenerationEvent>
  >()
  /** Settles after the reply task settles; never rejects. */
  readonly #replySettlement: Promise<void>
  /** Settles after both tasks settle and followers are closed; never rejects. */
  readonly #settlement: Promise<void>
  /** Whether both tasks have settled and every follower was closed. */
  #isSettled = false

  /**
   * Creates a generation whose tasks have not started.
   *
   * @param replySettlement - Reply-task settlement resolved by `start`.
   * @param settlement - Whole-generation settlement resolved by `start`.
   */
  private constructor(
    replySettlement: Promise<void>,
    settlement: Promise<void>
  ) {
    this.#replySettlement = replySettlement
    this.#settlement = settlement
  }

  /**
   * Starts one generation whose tasks begin after the current synchronous
   * step.
   *
   * @param options - Task launchers and the task-failure reporter.
   * @returns The running generation. Register it and open its first
   * followers before awaiting anything, so they receive every task event.
   */
  public static start(options: StartReplyGenerationOptions): ReplyGeneration {
    const replySettlement = Promise.withResolvers<void>()
    const settlement = Promise.withResolvers<void>()
    const generation = new ReplyGeneration(
      replySettlement.promise,
      settlement.promise
    )
    const replyContext = generation.#createTaskContext(
      generation.#replyController.signal
    )
    const replyTask = Promise.resolve().then(() =>
      options.startReplyTask(replyContext)
    )
    const tasks = [replyTask]
    const { startTitleTask } = options
    if (startTitleTask !== undefined) {
      const titleContext = generation.#createTaskContext(
        generation.#titleController.signal
      )
      tasks.push(Promise.resolve().then(() => startTitleTask(titleContext)))
    }

    void replyTask.then(
      () => replySettlement.resolve(),
      () => replySettlement.resolve()
    )
    void Promise.allSettled(tasks).then((outcomes) => {
      generation.#handleTasksSettled(outcomes, options.reportTaskFailure)
      settlement.resolve()
    })
    return generation
  }

  /**
   * Settlement of the whole generation.
   *
   * @returns A promise that settles after both tasks settled and every
   * follower was closed; it never rejects.
   */
  public get settled(): Promise<void> {
    return this.#settlement
  }

  /**
   * Adds a follower that receives every later event of this generation.
   *
   * @param subscription - Follower whose already queued events, such as a
   * turn-start or snapshot event, stay ahead of generation events.
   * @remarks A follower added after the generation settled is closed at
   * once, so its stream ends after its queued events.
   */
  public openSubscription(
    subscription: ReplyEventSubscription<ChatGenerationEvent>
  ): void {
    if (this.#isSettled) {
      subscription.close()
      return
    }

    this.#subscriptions.add(subscription)
  }

  /**
   * Stops the reply by cancelling its model request.
   *
   * @returns A promise that settles after the reply task settled, so the
   * reply's final state (`interrupted`, or `completed` when the model
   * finished first) is stored; it never rejects.
   * @remarks Idempotent. Title generation continues.
   */
  public stopReply(): Promise<void> {
    this.#replyController.abort()
    return this.#replySettlement
  }

  /**
   * Cancels both tasks and waits for the generation to settle.
   *
   * @returns The shared settlement; repeated calls return the same promise.
   */
  public [Symbol.asyncDispose](): Promise<void> {
    this.#replyController.abort()
    this.#titleController.abort()
    return this.#settlement
  }

  /**
   * Creates the context lent to one task.
   *
   * @param abortSignal - Cancellation for that task only.
   * @returns The task's signal and a non-blocking event sender.
   */
  #createTaskContext(abortSignal: AbortSignal): ReplyGenerationTaskContext {
    return {
      abortSignal,
      sendEvent: (event) => {
        this.#handleTaskEvent(event)
      }
    }
  }

  /**
   * Queues one task event for every open follower and forgets ended ones.
   *
   * @param event - Immutable event produced by a task.
   */
  #handleTaskEvent(event: ChatGenerationEvent): void {
    for (const subscription of this.#subscriptions) {
      if (!subscription.handleStreamEvent(event))
        this.#subscriptions.delete(subscription)
    }
  }

  /**
   * Reports rejected tasks, then marks the generation settled and closes
   * every follower.
   *
   * @param outcomes - Settled outcomes of every task this generation started.
   * @param reportTaskFailure - Reporter that receives each rejection.
   * @remarks Followers are closed even when the reporter throws, so their
   * streams always end.
   */
  #handleTasksSettled(
    outcomes: readonly PromiseSettledResult<void>[],
    reportTaskFailure: (error: unknown) => void
  ): void {
    try {
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") reportTaskFailure(outcome.reason)
      }
    } finally {
      this.#isSettled = true
      for (const subscription of this.#subscriptions) subscription.close()
      this.#subscriptions.clear()
    }
  }
}
