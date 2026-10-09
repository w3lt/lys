import type {
  ChatGenerationEvent,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"
import PendingToolCalls from "./pendingToolCalls"
import type ReplyEventSubscription from "./replyEventSubscription"

/** Capabilities a generation lends to one of its tasks. */
export type ReplyGenerationTaskContext = Readonly<{
  /** Cancellation owned by the generation for this task only. */
  abortSignal: AbortSignal
  /** Queues one event for every current follower; never waits or throws. */
  sendEvent: (event: ChatGenerationEvent) => void
}>

/** Capabilities a generation lends to its reply task. */
export type ReplyTaskContext = ReplyGenerationTaskContext &
  Readonly<{
    /**
     * Lists one checked tool call and sends it to every follower, then waits
     * for its answer. Resolves with the client's answer, or with undefined
     * once the reply was stopped, the generation disposed, or the reply task
     * settled; never rejects.
     * Throws if a call with the same identifier is already waiting.
     */
    sendToolCall: (
      toolCall: ChatToolCall
    ) => Promise<ChatToolResult | undefined>
  }>

/** Work and failure reporting for one generation. */
export type StartReplyGenerationOptions = Readonly<{
  /** Runs the reply task; its signal is aborted by `stopReply` and disposal. */
  startReplyTask: (context: ReplyTaskContext) => Promise<void>
  /**
   * Runs the title task, or is absent when no title task is requested. Its
   * signal is aborted only by disposal.
   */
  startTitleTask:
    ((context: ReplyGenerationTaskContext) => Promise<void>) | undefined
  /**
   * Records one task rejection; must not throw. A reporter that throws still
   * lets the generation settle and close its followers; its own failure is
   * left unhandled, the process's last diagnostic signal.
   */
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
 * settlement. Tool calls the reply task sends are listed until they are
 * answered, the reply is stopped or disposed, or the reply task settles;
 * there is no timer.
 * Concurrency model: single-owner, on the backend's event loop.
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
  /** Tool calls the reply task waits on. */
  readonly #pendingToolCalls = new PendingToolCalls()

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
    const replyContext = generation.#createReplyTaskContext()
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

    const settleReply = () => {
      generation.#pendingToolCalls.cancelToolCalls()
      replySettlement.resolve()
    }
    void replyTask.then(settleReply, settleReply)
    void Promise.allSettled(tasks).then((outcomes) => {
      try {
        generation.#handleTasksSettled(outcomes, options.reportTaskFailure)
      } finally {
        settlement.resolve()
      }
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
   * reply's final state is stored: `interrupted`, or `completed` or `failed`
   * when the reply ended before the stop; it never rejects.
   * @remarks Idempotent. Title generation continues. Every tool call the
   * reply waits on ends without an answer.
   */
  public stopReply(): Promise<void> {
    this.#replyController.abort()
    this.#pendingToolCalls.cancelToolCalls()
    return this.#replySettlement
  }

  /**
   * Cancels both tasks, ends every tool call the reply waits on without an
   * answer, and waits for the generation to settle.
   *
   * @returns The shared settlement; repeated calls return the same promise.
   */
  public [Symbol.asyncDispose](): Promise<void> {
    this.#replyController.abort()
    this.#pendingToolCalls.cancelToolCalls()
    this.#titleController.abort()
    return this.#settlement
  }

  /**
   * Lists the tool calls the reply waits on.
   *
   * @returns Calls sent and not yet answered, in send order; empty once the
   * reply was stopped, the generation disposed, the reply task settled, or
   * every call answered.
   */
  public get pendingToolCalls(): readonly ChatToolCall[] {
    return this.#pendingToolCalls.toolCalls
  }

  /**
   * Resumes the reply with the client's answer to one waiting call.
   *
   * @param toolCallId - Identifier of the call's `tool-call` event.
   * @param result - Validated answer, handed to the reply unchanged.
   * @returns True when the call was waiting; false when it is unknown,
   * already answered, or ended with its reply, which changes nothing. Calls
   * still waiting when the reply task settles end without an answer.
   */
  public resolveToolCall(toolCallId: string, result: ChatToolResult): boolean {
    return this.#pendingToolCalls.resolveToolCall(toolCallId, result)
  }

  /**
   * Creates the context lent to the reply task.
   *
   * @returns The reply's signal, a non-blocking event sender, and the tool
   * call sender.
   */
  #createReplyTaskContext(): ReplyTaskContext {
    return {
      ...this.#createTaskContext(this.#replyController.signal),
      sendToolCall: (toolCall) =>
        this.#pendingToolCalls.sendToolCall(toolCall, (event) => {
          this.#handleTaskEvent(event)
        })
    }
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
   * @throws The reporter's failure, after every follower was closed.
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
