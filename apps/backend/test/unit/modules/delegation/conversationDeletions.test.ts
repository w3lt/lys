import type { ChatToolCall } from "@lys/protocol"
import type { Job } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type ReplyGeneration from "../../../../src/modules/chat/replyGeneration"
import type { ReplyTaskContext } from "../../../../src/modules/chat/replyGeneration"
import type { ReplyTarget } from "../../../../src/modules/chat/replyGenerationRegistry"
import type { TurnDelegationContext } from "../../../../src/modules/chat/turnStart"
import {
  listWorkingReplies,
  stopDeletedReplies
} from "../../../../src/modules/delegation/conversationDeletions"
import type { DelegationEvent } from "../../../../src/modules/delegation/delegationEvent"
import ControlledReplyTask from "../../support/controlledReplyTask"
import {
  createPersonTurn,
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  startPersonTurn,
  type DelegationTestServices,
  type JobMessageRequest
} from "../../support/delegationTestServices"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"

/** Work a case gives {@link SECOND_MEMBER} beside the moths job. */
const LAMPS_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: SECOND_MEMBER,
  title: "Lamps",
  instructions: "Find which lamps draw moths",
  jobNumber: undefined
})

/**
 * Builds the address of a turn's reply.
 *
 * @param context - The stored turn.
 * @returns The frozen address of the turn's reply in its conversation.
 */
function buildReplyTarget(context: TurnDelegationContext): ReplyTarget {
  return Object.freeze({
    conversationId: context.turn.conversation.id,
    assistantMessageId: context.turn.assistantMessage.id
  })
}

/**
 * Builds the address of a job's reply.
 *
 * @param job - The job, as stored.
 * @returns The frozen address of the job's reply in the job's conversation.
 */
function buildJobReplyTarget(job: Job): ReplyTarget {
  return Object.freeze({
    conversationId: job.id,
    assistantMessageId: job.replyId
  })
}

/**
 * Lists the `stop-requested` events a case's runtime reported.
 *
 * @param services - The case's event recorder.
 * @returns The events, in the order they were reported.
 */
function listStopEvents(
  services: Pick<DelegationTestServices, "reportEvent">
): readonly DelegationEvent[] {
  return services.reportEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.kind === "stop-requested")
}

/**
 * Deletes a stored conversation as the delete route does: lists its working
 * replies, deletes it in the same synchronous step, then stops the listed
 * replies.
 *
 * @param services - The case's runtime and conversation services.
 * @param conversationId - UUIDv7 of the stored main conversation.
 * @returns A promise that resolves once the stop resolved.
 * @throws If the conversation was not deleted.
 */
async function deleteConversation(
  services: Pick<DelegationTestServices, "runtime" | "conversation">,
  conversationId: string
): Promise<void> {
  const replies = listWorkingReplies(services.runtime, conversationId)
  if (!services.conversation.editor.deleteConversation(conversationId))
    throw new Error("The conversation was not deleted")
  await stopDeletedReplies(services.runtime, conversationId, replies)
}

/** A generation a case started, with the reply task the case settles. */
type ControlledGeneration = Readonly<{
  /** The generation, registered in the case's registry. */
  generation: ReplyGeneration
  /** Its reply task, which ignores its abort signal until the case settles it. */
  replyTask: ControlledReplyTask<ReplyTaskContext>
}>

/**
 * Starts a generation for a stored turn's reply, whose tasks the case
 * settles.
 *
 * @param services - The case's registry.
 * @param context - The stored turn.
 * @param titleTask - The generation's title task; none when omitted.
 * @returns The generation and its reply task. When the test finishes, both
 * tasks are resolved before the registry is disposed.
 */
function startControlledGeneration(
  services: Pick<DelegationTestServices, "generations">,
  context: TurnDelegationContext,
  titleTask?: ControlledReplyTask
): ControlledGeneration {
  const replyTask = new ControlledReplyTask<ReplyTaskContext>()
  const generation = services.generations.startReplyGeneration(
    buildReplyTarget(context),
    {
      startReplyTask: (taskContext) => replyTask.start(taskContext),
      startTitleTask:
        titleTask === undefined
          ? undefined
          : (taskContext) => titleTask.start(taskContext),
      reportTaskFailure: vi.fn()
    }
  )
  onTestFinished(() => {
    replyTask.resolve()
    titleTask?.resolve()
  })
  return Object.freeze({ generation, replyTask })
}

describe("listWorkingReplies", () => {
  it("lists the conversation's own working reply and the working replies of its jobs, and none of another conversation", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const workingJob = sendJobMessage(services, lead, MOTHS_REQUEST)
    const finishedJob = sendJobMessage(services, lead, LAMPS_REQUEST)
    await services.resolveReply(finishedJob.replyId, "completed")
    const other = startPersonTurn(services)
    sendJobMessage(services, other, MOTHS_REQUEST)

    const replies = listWorkingReplies(
      services.runtime,
      lead.turn.conversation.id
    )

    expect(replies).toEqual([
      buildReplyTarget(lead),
      buildJobReplyTarget(workingJob)
    ])
  })
})

describe("stopDeletedReplies", () => {
  it("cancels each listed reply's generation after the conversation was deleted and resolves when each has settled", async () => {
    const services = openDelegationTestServices()
    const lead = createPersonTurn(services.conversation.turns)
    const conversationId = lead.turn.conversation.id
    const { replyTask } = startControlledGeneration(services, lead)
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await waitForMicrotasks()
    const replies = listWorkingReplies(services.runtime, conversationId)
    services.conversation.editor.deleteConversation(conversationId)

    const stop = stopDeletedReplies(services.runtime, conversationId, replies)
    const readStop = createSettlementReader(stop)
    await waitForMicrotasks()

    expect(replyTask.context.abortSignal.aborted).toBe(true)
    expect(
      services.generations.findReplyGeneration(buildJobReplyTarget(job))
    ).toBeUndefined()
    expect(readStop()).toBe("pending")
    replyTask.resolve()
    await stop
    expect(
      services.generations.findReplyGeneration(buildReplyTarget(lead))
    ).toBeUndefined()
  })

  it("cancels the title request of a deleted conversation's turn as well as its reply", async () => {
    const services = openDelegationTestServices()
    const lead = createPersonTurn(services.conversation.turns)
    const conversationId = lead.turn.conversation.id
    const titleTask = new ControlledReplyTask()
    const { replyTask } = startControlledGeneration(services, lead, titleTask)
    await waitForMicrotasks()
    const replies = listWorkingReplies(services.runtime, conversationId)
    services.conversation.editor.deleteConversation(conversationId)

    const stop = stopDeletedReplies(services.runtime, conversationId, replies)
    replyTask.resolve()
    const readStop = createSettlementReader(stop)
    await waitForMicrotasks()

    expect(replyTask.context.abortSignal.aborted).toBe(true)
    expect(titleTask.context.abortSignal.aborted).toBe(true)
    expect(readStop()).toBe("pending")
    titleTask.resolve()
    await stop
  })

  it("ends an approval prompt and a desktop tool call a deleted conversation's reply was waiting on", async () => {
    /** Call of a desktop tool the reply sends to run. */
    const desktopToolCall = Object.freeze({
      id: "01900000-0000-7000-8000-00000000000a",
      toolName: "read_text_file",
      arguments: Object.freeze({ path: "/notes/moths.md" })
    } satisfies ChatToolCall)

    /** Call the reply shows to the person for approval. */
    const approvalToolCall = Object.freeze({
      id: "01900000-0000-7000-8000-00000000000b",
      toolName: "read_page",
      arguments: Object.freeze({ url: "https://moths.example/" })
    } satisfies ChatToolCall)

    const services = openDelegationTestServices()
    const lead = createPersonTurn(services.conversation.turns)
    const conversationId = lead.turn.conversation.id
    const { generation, replyTask } = startControlledGeneration(services, lead)
    await waitForMicrotasks()
    const approval = replyTask.context.sendToolApprovalPrompt(approvalToolCall)
    const toolResult = replyTask.context.sendClientToolCall(desktopToolCall)
    const replies = listWorkingReplies(services.runtime, conversationId)
    services.conversation.editor.deleteConversation(conversationId)

    const stop = stopDeletedReplies(services.runtime, conversationId, replies)

    expect(await approval).toBeUndefined()
    expect(await toolResult).toBeUndefined()
    expect(generation.pendingToolCalls).toEqual({
      toolCalls: [],
      toolApprovals: []
    })
    expect(
      generation.resolveToolCall(approvalToolCall.id, { status: "allowed" })
    ).toBe("not-pending")
    expect(
      generation.resolveToolCall(desktopToolCall.id, {
        status: "succeeded",
        content: "Moths eat nectar."
      })
    ).toBe("not-pending")
    replyTask.resolve()
    await stop
  })

  it("stores no report and starts no wake-up for a job whose conversation is gone, and removes its reply from the hub with null", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    const addStopRequest = vi.spyOn(
      services.runtime.stopRequests,
      "addStopRequest"
    )
    const jobUpdateCount = services.hub.sendJobUpdate.mock.calls.length

    await deleteConversation(services, conversationId)

    expect(services.hub.removeReply).toHaveBeenCalledWith(job.replyId, null)
    expect(services.hub.removeReply).toHaveBeenCalledWith(
      lead.turn.assistantMessage.id,
      null
    )
    expect(services.hub.sendJobUpdate).toHaveBeenCalledTimes(jobUpdateCount)
    expect(addStopRequest).not.toHaveBeenCalled()
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "report-stored" })
    )
    expect(services.reportEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "wake-up-started" })
    )
    expect(services.listStartedTurns()).toHaveLength(2)
  })

  it("skips a listed reply that has no running generation", async () => {
    const services = openDelegationTestServices()
    const lead = createPersonTurn(services.conversation.turns)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    const replies = listWorkingReplies(services.runtime, conversationId)
    services.conversation.editor.deleteConversation(conversationId)

    await stopDeletedReplies(services.runtime, conversationId, replies)

    expect(replies).toEqual([buildReplyTarget(lead), buildJobReplyTarget(job)])
    expect(
      services.generations.findReplyGeneration(buildJobReplyTarget(job))
    ).toBeUndefined()
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 1
      }
    ])
  })

  it("cancels no reply once the registry's disposal began, and still forgets the conversation's wake settings", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    sendJobMessage(services, lead, MOTHS_REQUEST)
    const replies = listWorkingReplies(services.runtime, conversationId)
    services.conversation.editor.deleteConversation(conversationId)
    const disposal = services.generations[Symbol.asyncDispose]()

    await stopDeletedReplies(services.runtime, conversationId, replies)
    await disposal

    expect(replies).toHaveLength(2)
    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 0
      }
    ])
  })

  it("forgets the conversation's wake settings and reports one stop-requested with the count", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    sendJobMessage(services, lead, MOTHS_REQUEST)
    sendJobMessage(services, lead, LAMPS_REQUEST)

    await deleteConversation(services, conversationId)

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
    expect(listStopEvents(services)).toEqual([
      {
        kind: "stop-requested",
        conversationId,
        requester: "person",
        stoppedReplyCount: 3
      }
    ])
  })
})
