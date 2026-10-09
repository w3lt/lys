import type { ReplyGenerationTaskContext } from "../../../src/modules/chat/replyGeneration"

/**
 * Generation task whose start is observable and whose settlement the case
 * controls.
 *
 * @remarks Stands in for a reply or title task handed to a generation. The
 * task stays pending until the case calls {@link ControlledReplyTask.resolve}
 * or {@link ControlledReplyTask.reject}; it does not observe its abort signal
 * unless the case does. A generation starts a task at most once, so a second
 * start rejects. `TContext` is the context its generation lends, a reply
 * task's when the case sends tool calls. Concurrency model: single-owner, on
 * the test's event loop.
 */
export default class ControlledReplyTask<
  TContext extends ReplyGenerationTaskContext = ReplyGenerationTaskContext
> {
  /** Settlement returned to the generation that started the task. */
  readonly #settlement = Promise.withResolvers<void>()
  /** Context lent by the generation, or undefined before the task started. */
  #context: TContext | undefined

  /**
   * Starts the task for the generation that launches it as its reply or title
   * task.
   *
   * @param context - Cancellation and event sender lent by the generation.
   * @returns The task's settlement, pending until the case settles it.
   * @throws If the task was already started.
   * @remarks A case hands the generation a launcher that calls this method,
   * such as `(context) => task.start(context)`.
   */
  public async start(context: TContext): Promise<void> {
    if (this.#context !== undefined)
      throw new Error("Controlled reply task started twice")
    this.#context = context
    return this.#settlement.promise
  }

  /**
   * Whether a generation has started the task.
   *
   * @returns True once {@link ControlledReplyTask.start} has run.
   */
  public get hasStarted(): boolean {
    return this.#context !== undefined
  }

  /**
   * Context lent by the generation that started the task.
   *
   * @returns The task's abort signal and event sender.
   * @throws If the task has not started, so a case that expected a start
   * fails at the point of use.
   */
  public get context(): TContext {
    if (this.#context === undefined)
      throw new Error("Controlled reply task has not started")
    return this.#context
  }

  /** Settles the started task successfully. */
  public resolve(): void {
    this.#settlement.resolve()
  }

  /**
   * Rejects the started task.
   *
   * @param error - Failure the generation receives from the task.
   * @remarks Call only after the task started, so the generation observes the
   * rejection.
   */
  public reject(error: unknown): void {
    this.#settlement.reject(error)
  }
}
