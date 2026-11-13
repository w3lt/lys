import type ReplyGeneration from "../chat/replyGeneration"
import type { ReplyTarget } from "../chat/replyGenerationRegistry"
import type { DelegationRuntime } from "./dependencies"
import { findRunningReplyGeneration } from "./jobStops"

/**
 * Lists the working replies of a conversation the person is about to
 * delete, and of every job below it, as they are stored.
 *
 * @param runtime - The reply reader.
 * @param conversationId - UUIDv7 of the conversation.
 * @returns The streaming replies: the conversation's own first, then those
 * of the jobs below it, at any depth, in the order the jobs were created;
 * empty when none streams or the conversation is not stored.
 * @throws If the conversation store is closed or a stored identity violates
 * the conversation contract.
 * @remarks Only the stored replies are read, so the caller lists them in
 * the same synchronous step as the delete, which removes the rows that name
 * them. Whether a generation runs for each is found by
 * {@link stopDeletedReplies} once the delete succeeded.
 */
export function listWorkingReplies(
  runtime: Pick<DelegationRuntime, "jobActivity">,
  conversationId: string
): readonly ReplyTarget[] {
  return runtime.jobActivity.listStreamingReplies(conversationId)
}

/**
 * Cancels the work that was running in a deleted conversation and in its
 * jobs, and waits until it has ended.
 *
 * @param runtime - The generation registry, the wake settings, and the
 * event reporter.
 * @param conversationId - UUIDv7 of the deleted conversation.
 * @param replies - The working replies {@link listWorkingReplies} listed
 * right before the delete.
 * @returns A promise that resolves once the generation of each cancelled
 * reply has settled, right away when none was cancelled; it never rejects.
 * @remarks Called only once the delete succeeded. In one synchronous step,
 * the running generation of each listed reply is found, and a reply without
 * one is skipped, as is every reply once the registry's disposal began; the
 * conversation's wake settings are forgotten, which the end of a reply whose
 * rows are gone does not do; each found generation is disposed, which
 * cancels its model request, ends every tool call and approval prompt it
 * waits on without an answer, and cancels its title request, which the
 * person's stop leaves running; and one `stop-requested` is reported for
 * the conversation, with `person` as the requester and the number of
 * cancelled generations, also when there are none. No stop request is
 * remembered: the end of each cancelled reply finds its rows gone, so it
 * stores no report, starts no wake-up turn, and removes the reply from the
 * activity hub with `null`.
 */
export async function stopDeletedReplies(
  runtime: Pick<
    DelegationRuntime,
    "generations" | "wakeSettings" | "reportEvent"
  >,
  conversationId: string,
  replies: readonly ReplyTarget[]
): Promise<void> {
  const generations = findRunningGenerations(runtime.generations, replies)
  runtime.wakeSettings.removeWakeSettings(conversationId)
  const settlements = generations.map((generation) =>
    generation[Symbol.asyncDispose]()
  )
  runtime.reportEvent({
    kind: "stop-requested",
    conversationId,
    requester: "person",
    stoppedReplyCount: generations.length
  })
  await Promise.all(settlements)
}

/**
 * Finds the running generations of listed replies.
 *
 * @param generations - Finds the running generation of a reply.
 * @param replies - The replies, each with the conversation expected to hold
 * it.
 * @returns A frozen list of the generations found, in the order of the
 * replies. A reply without a running generation is left out, and so is
 * every reply once the registry's disposal began.
 */
function findRunningGenerations(
  generations: DelegationRuntime["generations"],
  replies: readonly ReplyTarget[]
): readonly ReplyGeneration[] {
  const found: ReplyGeneration[] = []
  for (const reply of replies) {
    const generation = findRunningReplyGeneration(generations, reply)
    if (generation !== undefined) found.push(generation)
  }
  return Object.freeze(found)
}
