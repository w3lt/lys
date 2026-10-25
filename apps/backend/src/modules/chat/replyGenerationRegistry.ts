import ReplyGeneration, {
  type ReplyGenerationTaskContext,
  type StartReplyGenerationOptions
} from "./replyGeneration"

/** Assistant reply addressed together with the conversation that holds it. */
export type ReplyTarget = Readonly<{
  /** UUIDv7 of the conversation that holds the reply. */
  conversationId: string
  /** UUIDv7 of the assistant reply. */
  assistantMessageId: string
}>

/** A running generation and the conversation its reply belongs to. */
type RegisteredReplyGeneration = Readonly<{
  /** Conversation that must match a lookup before the generation is returned. */
  conversationId: string
  /** Running generation owned by the registry until it settles. */
  generation: ReplyGeneration
}>

/** Canonical failure for any registry operation after disposal began. */
const CLOSED_REGISTRY_MESSAGE = "Reply generation registry is closed"

/**
 * Owns every running reply generation: admits new ones, finds one for a
 * follower or a stop request, and ends them all at shutdown.
 *
 * @remarks The invariants are that at most one registered generation exists
 * per assistant reply, a generation stays registered from
 * `startReplyGeneration` until it settles, and at most one title task runs per
 * conversation. The registry holds no reply text.
 * Lifecycle: ready until disposal begins; disposal permanently closes the
 * registry, cancels every generation, and settles after all of them settle,
 * and repeated calls share that completion. After disposal begins, starting
 * or finding a generation throws the closed-registry failure. Concurrency
 * model: single-owner, on the backend's event loop.
 */
export default class ReplyGenerationRegistry implements AsyncDisposable {
  /** Running generations keyed by assistant message identifier. */
  readonly #generations = new Map<string, RegisteredReplyGeneration>()
  /** Conversations with a running title task, from admission to settlement. */
  readonly #conversationIdsGeneratingTitle = new Set<string>()
  /** Shared disposal completion; its presence means the registry is closed. */
  #disposal: Promise<void> | undefined

  /**
   * Admits and starts the generation for one newly stored reply.
   *
   * @param target - Stored reply the generation writes, with its conversation.
   * @param options - Task launchers and the task-failure reporter.
   * @returns The running generation, registered until it settles.
   * @throws If the registry is closed or a generation for the reply is already
   * running; nothing is started in either case.
   * @remarks A title launcher is dropped while another generation of the same
   * conversation is running a title task, so the new generation runs only its
   * reply and settles without waiting for that title. A later generation can
   * start a title task once the running one settles, whatever its outcome.
   */
  public startReplyGeneration(
    target: ReplyTarget,
    options: StartReplyGenerationOptions
  ): ReplyGeneration {
    if (this.#disposal !== undefined) throw new Error(CLOSED_REGISTRY_MESSAGE)
    if (this.#generations.has(target.assistantMessageId))
      throw new Error("A generation for this reply is already running")

    const generation = ReplyGeneration.start({
      startReplyTask: options.startReplyTask,
      startTitleTask: this.#startTitleTracking(
        target.conversationId,
        options.startTitleTask
      ),
      reportTaskFailure: options.reportTaskFailure
    })
    this.#generations.set(target.assistantMessageId, {
      conversationId: target.conversationId,
      generation
    })
    void generation.settled.then(() => {
      this.#removeSettledGeneration(target.assistantMessageId, generation)
    })
    return generation
  }

  /**
   * Finds the running generation for one reply.
   *
   * @param target - Reply and the conversation expected to hold it.
   * @returns The generation, or undefined when none is running for that
   * reply in that conversation.
   * @throws If the registry is closed.
   */
  public findReplyGeneration(target: ReplyTarget): ReplyGeneration | undefined {
    if (this.#disposal !== undefined) throw new Error(CLOSED_REGISTRY_MESSAGE)

    const registered = this.#generations.get(target.assistantMessageId)
    return registered?.conversationId === target.conversationId
      ? registered.generation
      : undefined
  }

  /**
   * Closes the registry, cancels every running generation, and waits for them.
   *
   * @returns Shared completion for repeated or concurrent calls; it settles
   * after every generation has stored its final state and never rejects.
   */
  public [Symbol.asyncDispose](): Promise<void> {
    this.#disposal ??= Promise.allSettled(
      [...this.#generations.values()].map(({ generation }) =>
        generation[Symbol.asyncDispose]()
      )
    ).then(() => undefined)
    return this.#disposal
  }

  /**
   * Starts tracking a conversation's title task unless one is already running.
   *
   * @param conversationId - Conversation of the generation being admitted.
   * @param startTitleTask - Requested title launcher, or undefined when the
   * conversation needs no title.
   * @returns A launcher that starts the requested task and ends the tracking
   * once that task settles, or undefined when no title was requested or the
   * conversation's title task is already running.
   * @remarks Tracking begins in the admission step, so no other generation of
   * the conversation is admitted with a title task before this one starts.
   * The caller hands the launcher to {@link ReplyGeneration.start}, which
   * always runs a supplied title launcher, so the tracking always ends.
   */
  #startTitleTracking(
    conversationId: string,
    startTitleTask: StartReplyGenerationOptions["startTitleTask"]
  ): StartReplyGenerationOptions["startTitleTask"] {
    if (
      startTitleTask === undefined ||
      this.#conversationIdsGeneratingTitle.has(conversationId)
    )
      return undefined

    this.#conversationIdsGeneratingTitle.add(conversationId)
    return (context) =>
      this.#startTrackedTitleTask(conversationId, startTitleTask, context)
  }

  /**
   * Starts an admitted title task and ends its conversation's tracking once
   * the task settles.
   *
   * @param conversationId - Conversation whose title task is tracked.
   * @param startTitleTask - Title launcher admitted for that conversation.
   * @param context - Generation-owned cancellation and event sender.
   * @returns Settlement after the title task settles and tracking ended.
   * @throws The title task's failure, after tracking ended; the generation
   * reports it.
   */
  async #startTrackedTitleTask(
    conversationId: string,
    startTitleTask: NonNullable<StartReplyGenerationOptions["startTitleTask"]>,
    context: ReplyGenerationTaskContext
  ): Promise<void> {
    try {
      await startTitleTask(context)
    } finally {
      this.#conversationIdsGeneratingTitle.delete(conversationId)
    }
  }

  /**
   * Forgets a generation once it settled, unless another took its place.
   *
   * @param assistantMessageId - Reply the settled generation wrote.
   * @param generation - The exact generation instance that settled.
   */
  #removeSettledGeneration(
    assistantMessageId: string,
    generation: ReplyGeneration
  ): void {
    const registered = this.#generations.get(assistantMessageId)
    if (registered?.generation === generation)
      this.#generations.delete(assistantMessageId)
  }
}
