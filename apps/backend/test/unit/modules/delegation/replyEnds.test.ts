import type { JobState } from "@lys/share"
import { describe, expect, it } from "vitest"
import type { EndedActivityStatus } from "../../../../src/modules/activity/activityHub"
import type { AssistantMessageCompletion } from "../../../../src/modules/agent/agent"
import type { EndedReply } from "../../../../src/modules/chat/turnStart"
import { handleReplyEnded } from "../../../../src/modules/delegation/replyEnds"
import {
  createPersonTurn,
  MOTHS_REQUEST,
  openDelegationTestServices,
  sendJobMessage
} from "../../support/delegationTestServices"

/**
 * Builds the end of a reply as its turn start tells it, without an `error`
 * event.
 *
 * @param conversationId - UUIDv7 of the conversation that holds the reply.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @returns The frozen ended reply.
 */
function buildEndedReply(
  conversationId: string,
  assistantMessageId: string
): EndedReply {
  return Object.freeze({
    conversationId,
    assistantMessageId,
    errorMessage: undefined
  })
}

describe("handleReplyEnded", () => {
  it.each<[string, AssistantMessageCompletion, EndedActivityStatus, JobState]>([
    [
      "completed",
      { status: "completed", finishReason: "stop" },
      "completed",
      "replied"
    ],
    ["failed", { status: "failed" }, "failed", "failed"],
    ["interrupted", { status: "interrupted" }, "interrupted", "stopped"]
  ])(
    "removes a job's %s reply from the hub with its stored status, and sends the job update",
    (_label, completion, status, jobState) => {
      const services = openDelegationTestServices()
      const delegating = createPersonTurn(services.conversation.turns)
      const conversationId = delegating.turn.conversation.id
      const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
      services.conversation.turns.updateAssistantMessageState(
        job.replyId,
        completion
      )

      handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

      const endedJob = services.runtime.jobs.findJob(job.id)?.job
      expect(endedJob?.state).toBe(jobState)
      expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
        job.replyId,
        status
      )
      expect(services.hub.sendJobUpdate).toHaveBeenLastCalledWith(
        conversationId,
        endedJob
      )
    }
  )

  it("removes a reply whose conversation was deleted from the hub with null, and sends no job update", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.conversation.editor.deleteConversation(
      delegating.turn.conversation.id
    )
    const updateCount = services.hub.sendJobUpdate.mock.calls.length

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      null
    )
    expect(services.hub.sendJobUpdate).toHaveBeenCalledTimes(updateCount)
  })

  it("removes a reply still stored as streaming from the hub as interrupted", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      "interrupted"
    )
  })

  it("forgets who asked the reply to stop", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.runtime.stopRequests.addStopRequest(job.replyId, "delegator")
    services.conversation.turns.updateAssistantMessageState(job.replyId, {
      status: "interrupted"
    })

    handleReplyEnded(services.runtime, buildEndedReply(job.id, job.replyId))

    expect(
      services.runtime.stopRequests.removeStopRequest(job.replyId)
    ).toBeUndefined()
  })

  it("removes a person's reply from the hub without a job update", () => {
    const services = openDelegationTestServices()
    const personTurn = createPersonTurn(services.conversation.turns)
    const { conversation, assistantMessage } = personTurn.turn
    services.conversation.turns.updateAssistantMessageState(
      assistantMessage.id,
      { status: "completed", finishReason: "stop" }
    )

    handleReplyEnded(
      services.runtime,
      buildEndedReply(conversation.id, assistantMessage.id)
    )

    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      assistantMessage.id,
      "completed"
    )
    expect(services.hub.sendJobUpdate).not.toHaveBeenCalled()
  })
})
