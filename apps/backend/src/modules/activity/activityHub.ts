import type {
  ActivityEvent,
  ActivityReply,
  ChatGenerationEvent
} from "@lys/protocol"
import type { Job } from "@lys/share"
import ReplyEventSubscription from "../chat/replyEventSubscription"
import type ReplyGeneration from "../chat/replyGeneration"

/**
 * Identifies one reply the backend started: a job's reply, or a wake-up
 * reply of a main conversation.
 */
export type ActivityReplyTarget = Readonly<{
  /** UUIDv7 identity of the conversation that holds the reply. */
  conversationId: string
  /**
   * UUIDv7 identity of that conversation's parent; null for a wake-up reply,
   * whose conversation is a main one.
   */
  parentConversationId: string | null
  /** UUIDv7 identity of the reply. */
  assistantMessageId: string
}>

/**
 * What the hub borrows from the generation of a reply it follows: the
 * generation's later events, and the calls the reply waits on.
 */
export type ActivityGeneration = Pick<
  ReplyGeneration,
  "openSubscription" | "pendingToolCalls"
>

/**
 * Stored final state of a reply that ended: the status a `reply-ended`
 * event carries when it has one.
 */
export type EndedActivityStatus = NonNullable<
  Extract<ActivityEvent, { type: "reply-ended" }>["status"]
>

/** One reply the hub follows, with what the hub holds for it. */
type FollowedReply = Readonly<{
  /**
   * The hub's own frozen copy of the reply's identifiers, sent with its
   * events.
   */
  target: ActivityReplyTarget
  /** The reply's generation, borrowed to read the calls the reply waits on. */
  generation: ActivityGeneration
  /** The hub's follower on that generation, which the hub closes. */
  subscription: ReplyEventSubscription<ChatGenerationEvent>
}>

/** Whether the hub still sends events, and what it holds while it does. */
type ActivityHubState =
  | Readonly<{
      /** Events reach every open stream. */
      status: "open"
      /** Open activity streams; owned by this state. */
      streams: Set<ReplyEventSubscription<ActivityEvent>>
      /**
       * Followed replies by reply identity, in the order they were added;
       * owned by this state.
       */
      followedReplies: Map<string, FollowedReply>
    }>
  | Readonly<{
      /**
       * The hub was disposed: every stream and follower was closed, and
       * nothing is sent again.
       */
      status: "disposed"
    }>

/**
 * Owns the open activity streams and the subscriptions on the replies it
 * follows, to tell every stream what the backend started, while every
 * followed reply is in a new stream's snapshot until it is removed.
 *
 * @remarks The invariant is that a reply is followed from its `addReply`
 * until its `removeReply` or the hub's disposal, and that every open stream
 * receives the hub's events in the order the hub sent them, after the
 * snapshot the stream started with.
 *
 * Delivery: each event is offered once to every stream open when it is
 * sent, and is never sent again; a stream that connects later learns the
 * current state from its snapshot only. Having no stream is valid: the
 * event then reaches nobody. Streams are independent: a stream ends when a
 * write to its connection fails, or when an event finds its queue of
 * unwritten events full, and the hub forgets an ended stream when it sends
 * the next event; the other streams keep receiving. No operation waits for
 * a write.
 *
 * Resources: the hub owns its follower on each followed generation and the
 * membership of every stream, and closes both. It borrows the generations:
 * it never stops or disposes one, and a stream ending never affects a
 * reply. The connection behind a stream stays with the route that opened
 * the stream.
 *
 * Lifecycle: `[Symbol.dispose]` is the cleanup, and it is final. After
 * disposal, `addReply`, `removeReply`, and `sendJobUpdate` do nothing and
 * `openStream` returns a closed subscription, rather than failing, because
 * shutdown ends the streams in `preClose` while in-flight requests may
 * still reach the hub: replies still end and jobs still change while the
 * backend shuts down.
 *
 * Concurrency model: single-owner, on the backend's event loop. Every
 * operation is synchronous.
 */
export default class ActivityHub {
  /** Authoritative state, replaced only by the hub's disposal. */
  #state: ActivityHubState

  /** Creates an open hub that follows no reply and has no stream. */
  public constructor() {
    const streams = new Set<ReplyEventSubscription<ActivityEvent>>()
    const followedReplies = new Map<string, FollowedReply>()
    this.#state = { status: "open", streams, followedReplies }
  }

  /**
   * Starts following a backend-started reply: sends `reply-started`, then
   * forwards its approval prompts and desktop tool calls until it is
   * removed.
   *
   * @param target - Identifiers of the reply; the hub keeps its own copy of
   * the three, so nothing else the object carries, and no later change of
   * it, reaches an event.
   * @param generation - The reply's running generation, borrowed until the
   * reply is removed or the hub is disposed.
   * @throws If the hub already follows a reply with that identity; nothing
   * changes.
   * @remarks Call it in the synchronous step that started the generation,
   * so every prompt and tool call of the reply is forwarded. A call the
   * reply already waits on is not sent as an event; it appears only in the
   * snapshots of later streams. Does nothing once the hub is disposed.
   */
  public addReply(
    target: ActivityReplyTarget,
    generation: ActivityGeneration
  ): void {
    if (this.#state.status === "disposed") return
    const { followedReplies } = this.#state
    if (followedReplies.has(target.assistantMessageId))
      throw new Error("This reply is already followed")

    const followedTarget: ActivityReplyTarget = Object.freeze({
      conversationId: target.conversationId,
      parentConversationId: target.parentConversationId,
      assistantMessageId: target.assistantMessageId
    })
    const subscription = new ReplyEventSubscription<ChatGenerationEvent>(
      (event) => {
        this.#handleFollowedReplyEvent(followedTarget, event)
        return Promise.resolve()
      }
    )
    generation.openSubscription(subscription)
    followedReplies.set(followedTarget.assistantMessageId, {
      target: followedTarget,
      generation,
      subscription
    })
    this.#sendEvent({ type: "reply-started", ...followedTarget })
  }

  /**
   * Stops following the reply and sends `reply-ended`.
   *
   * @param assistantMessageId - Identity of the reply that ended.
   * @param status - Stored final state of the reply; null when the reply is
   * no longer stored or could not be read.
   * @remarks Does nothing for a reply the hub does not follow, and nothing
   * once the hub is disposed. No prompt or tool call of the reply is sent
   * after its `reply-ended`, not even one the reply sent before this call.
   * The generation is left as it is.
   */
  public removeReply(
    assistantMessageId: string,
    status: EndedActivityStatus | null
  ): void {
    if (this.#state.status === "disposed") return
    const followedReply = this.#state.followedReplies.get(assistantMessageId)
    if (followedReply === undefined) return

    this.#state.followedReplies.delete(assistantMessageId)
    followedReply.subscription.close()
    this.#sendEvent({ type: "reply-ended", ...followedReply.target, status })
  }

  /**
   * Sends `job-updated` with the whole job.
   *
   * @param parentConversationId - Identity of the conversation the job was
   * started from.
   * @param job - The job as it is now; an immutable value, written to each
   * stream after this call returns.
   * @remarks Sends nothing once the hub is disposed.
   */
  public sendJobUpdate(parentConversationId: string, job: Job): void {
    this.#sendEvent({ type: "job-updated", parentConversationId, job })
  }

  /**
   * Queues the snapshot on a new stream and adds the stream, in one
   * synchronous step.
   *
   * @param sendEvent - Borrowed writer of one connection, which the caller
   * keeps owning. It resolves once the event is written and rejects once
   * the connection has closed; a write pending when the connection closes
   * may never settle.
   * @returns The stream's subscription. Its `closed` settles once the
   * stream ended, because the hub was disposed, a write failed, or its queue
   * was full, and its accepted writes settled. The caller closes it when the
   * connection ends. After the hub's disposal, the returned subscription is
   * already closed and nothing is written to it.
   * @remarks The snapshot lists every followed reply, in the order the
   * replies were added, with the prompts and desktop tool calls each one
   * waits on at this moment. Because the snapshot is queued in the step
   * that adds the stream, every event sent afterwards follows it, and none
   * is missed. A call can be in the snapshot and still arrive as an event
   * when the reply sent it just before this call.
   */
  public openStream(
    sendEvent: (event: ActivityEvent) => Promise<void>
  ): ReplyEventSubscription<ActivityEvent> {
    const stream = new ReplyEventSubscription<ActivityEvent>(sendEvent)
    if (this.#state.status === "disposed") {
      stream.close()
      return stream
    }

    const followedReplies = [...this.#state.followedReplies.values()]
    stream.handleStreamEvent({
      type: "activity-snapshot",
      replies: followedReplies.map((followedReply) =>
        buildActivityReply(followedReply)
      )
    })
    this.#state.streams.add(stream)
    return stream
  }

  /**
   * Disposes of the hub: closes every stream; later events go nowhere.
   *
   * @remarks Idempotent, final, and infallible. It also closes the hub's
   * follower on every followed generation and leaves the generations
   * running. Events a stream accepted before the disposal are still written,
   * then the stream's `closed` settles and its route ends the response.
   */
  public [Symbol.dispose](): void {
    if (this.#state.status === "disposed") return
    const { streams, followedReplies } = this.#state
    this.#state = { status: "disposed" }

    for (const followedReply of followedReplies.values())
      followedReply.subscription.close()
    for (const stream of streams) stream.close()
  }

  /**
   * Forwards one event of a followed reply when it is an approval prompt or
   * a desktop tool call.
   *
   * @param target - The hub's copy of the identifiers of the reply whose
   * generation sent the event.
   * @param event - Event the hub's follower on that generation delivered.
   * @throws {TypeError} If the event is of a kind this module does not know.
   * @remarks An event delivered after the hub was disposed, or after its
   * reply was removed, is dropped, so nothing of a reply follows its
   * `reply-ended`.
   */
  #handleFollowedReplyEvent(
    target: ActivityReplyTarget,
    event: ChatGenerationEvent
  ): void {
    if (this.#state.status === "disposed") return
    const followedReply = this.#state.followedReplies.get(
      target.assistantMessageId
    )
    if (followedReply?.target !== target) return

    const forwardedEvent = buildForwardedEvent(target, event)
    if (forwardedEvent !== undefined) this.#sendEvent(forwardedEvent)
  }

  /**
   * Offers one event to every open stream and forgets the streams that
   * ended.
   *
   * @param event - Immutable event; each stream writes it after its earlier
   * events.
   * @remarks Sends nothing once the hub is disposed.
   */
  #sendEvent(event: ActivityEvent): void {
    if (this.#state.status === "disposed") return
    const { streams } = this.#state
    for (const stream of streams) {
      if (!stream.handleStreamEvent(event)) streams.delete(stream)
    }
  }
}

/**
 * Builds the activity event that forwards one event of a followed reply.
 *
 * @param target - Identifiers of the reply whose generation sent the event.
 * @param event - Event of that generation.
 * @returns The `tool-approval` or `tool-call` event with the reply's
 * identifiers and the call; undefined for every other kind, which the
 * activity stream does not carry: a reply's parts, sources, title, and end
 * reach clients through the reply's own stream and through `reply-ended`.
 * @throws {TypeError} If the event is of a kind this module does not know.
 */
function buildForwardedEvent(
  target: ActivityReplyTarget,
  event: ChatGenerationEvent
): ActivityEvent | undefined {
  switch (event.type) {
    case "tool-approval":
    case "tool-call":
      return { type: event.type, ...target, call: event.call }
    case "title":
    case "reply-part":
    case "reply-part-delta":
    case "sources":
    case "done":
    case "interrupted":
    case "error":
      return undefined
    default: {
      const unhandledEvent: never = event
      throw new TypeError(
        `Unhandled generation event: ${JSON.stringify(unhandledEvent)}`
      )
    }
  }
}

/**
 * Builds the snapshot entry of one followed reply.
 *
 * @param followedReply - Reply the hub follows.
 * @returns The reply's identifiers with the desktop tool calls and the
 * approval prompts its generation waits on now, each in the order sent;
 * both empty once the reply was stopped or its reply task settled.
 */
function buildActivityReply(followedReply: FollowedReply): ActivityReply {
  const { toolCalls, toolApprovals } = followedReply.generation.pendingToolCalls
  return {
    ...followedReply.target,
    pendingToolCalls: toolCalls,
    pendingToolApprovals: toolApprovals
  }
}
