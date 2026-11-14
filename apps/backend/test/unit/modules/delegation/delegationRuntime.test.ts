import { describe, expect, it } from "vitest"
import { buildDelegationDefinitions } from "../../../../src/modules/agent/delegationTools"
import {
  createJobMessageDraft,
  createPersonTurn,
  listTurnHooks,
  MOTHS_REQUEST,
  openDelegationTestServices
} from "../../support/delegationTestServices"

describe("createDelegationRuntime", () => {
  it("hands the turns it starts its own hooks: a job's turn is offered report_progress and its end is handled", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    const delegation = services.runtime.createTurnDelegation(delegating)

    const outcome = delegation.createJobMessage(draft)
    const job = services.runtime.jobs.findJobByNumber(conversationId, 1)
    if (job === undefined) throw new Error("No job was stored")
    const jobTurn = services.findStartedTurn(job.replyId)
    await services.resolveReply(job.replyId, "completed")

    expect(outcome).toMatchObject({ status: "sent", jobNumber: 1 })
    expect(listTurnHooks(jobTurn.options)).toEqual(
      listTurnHooks(services.runtime)
    )
    expect(
      buildDelegationDefinitions("member", jobTurn.delegation.offer).map(
        (definition) => definition.name
      )
    ).toEqual(["report_progress"])
    expect(services.hub.removeReply).toHaveBeenCalledExactlyOnceWith(
      job.replyId,
      "completed"
    )
    expect(services.hub.sendJobUpdate).toHaveBeenLastCalledWith(
      conversationId,
      services.runtime.jobs.findJob(job.id)?.job
    )
    expect(services.runtime.jobs.findJob(job.id)?.job.state).toBe("replied")
  })
})
