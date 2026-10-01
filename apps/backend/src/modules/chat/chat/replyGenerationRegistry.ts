import ReplyGeneration, {
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
 * @remarks The invariant is that at most one registered generation exists per
 * assistant reply, and a generation stays registered from
 * `startReplyGeneration` until it settles. The registry holds no reply text.
 * Lifecycle: ready until disposal begins; disposal permanently closes the
 * registry, cancels every generation, and settles after all of them settle,
 * and repeated calls share that completion. After disposal begins, starting
 * or finding a generation throws the closed-registry failure. Concurrency
 * model: single-owner, on the backend's event loop.
 */
export default class ReplyGenerationRegistry implements AsyncDisposable {
  /** Running generations keyed by assistant message identifier. */
  readonly #generations = new Map<string, RegisteredReplyGeneration>()
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
   */
  public startReplyGeneration(
    target: ReplyTarget,
    options: StartReplyGenerationOptions
  ): ReplyGeneration {
    if (this.#disposal !== undefined) throw new Error(CLOSED_REGISTRY_MESSAGE)
    if (this.#generations.has(target.assistantMessageId))
      throw new Error("A generation for this reply is already running")

    const generation = ReplyGeneration.start(options)
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
