import { CALIGINIA_AGENT_CODE } from "@lys/share"
import { describe, expect, it } from "vitest"
import type { TurnSettings } from "../../../../src/modules/chat/turnStart"
import {
  createTurnDelegation,
  handleTurnStarted
} from "../../../../src/modules/delegation/turnDelegations"
import { createNewConversationTarget } from "../../support/conversationFixtures"
import {
  createJobMessageDraft,
  createPersonTurn,
  createWakeUpTurn,
  DELEGATING_TURN_SETTINGS,
  FIRST_MEMBER,
  MOTHS_REQUEST,
  openDelegationTestServices,
  sendJobMessage
} from "../../support/delegationTestServices"

/**
 * Settings of a later turn, whose reply `openai/gpt-oss-20b` writes, which
 * tells them from the settings of the turn that gave the work.
 */
const LATER_TURN_SETTINGS: TurnSettings = Object.freeze({
  ...DELEGATING_TURN_SETTINGS,
  model: "openai/gpt-oss-20b"
})

describe("createTurnDelegation", () => {
  it("lets a main conversation's turn delegate when its settings offer delegate_work, and not otherwise", () => {
    /** Settings of a turn whose tool offer does not name `delegate_work`. */
    const nonDelegatingSettings: TurnSettings = Object.freeze({
      ...DELEGATING_TURN_SETTINGS,
      offersDelegateWork: false
    })

    const services = openDelegationTestServices()
    const offering = createPersonTurn(services.conversation.turns)
    const notOffering = createPersonTurn(
      services.conversation.turns,
      createNewConversationTarget(CALIGINIA_AGENT_CODE),
      nonDelegatingSettings
    )

    const offered = createTurnDelegation(services.runtime, offering)
    const notOffered = createTurnDelegation(services.runtime, notOffering)

    expect(offered.offer).toEqual({
      mayDelegate: true,
      hasJobs: false,
      job: undefined
    })
    expect(notOffered.offer).toEqual({
      mayDelegate: false,
      hasJobs: false,
      job: undefined
    })
  })

  it("never lets a job's turn delegate, and gives it the delegator's name and its job number", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const jobTurn = services.findStartedTurn(job.replyId).context

    const delegation = createTurnDelegation(services.runtime, jobTurn)

    expect(jobTurn.settings.offersDelegateWork).toBe(true)
    expect(delegation.offer).toEqual({
      mayDelegate: false,
      hasJobs: false,
      job: { delegatorName: "Caliginia", jobNumber: 1 }
    })
  })

  it("says a conversation has jobs only once one was created", () => {
    const services = openDelegationTestServices()
    const first = createPersonTurn(services.conversation.turns)
    sendJobMessage(services, first, MOTHS_REQUEST)
    const second = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: first.turn.conversation.id
    })

    const beforeJob = createTurnDelegation(services.runtime, first)
    const afterJob = createTurnDelegation(services.runtime, second)

    expect(beforeJob.offer.hasJobs).toBe(false)
    expect(afterJob.offer.hasJobs).toBe(true)
  })

  it("sends job messages from its own turn's conversation, and stops that conversation's jobs", async () => {
    /** Cancellation of a wait that a case never cancels. */
    const neverAbortedSignal = new AbortController().signal

    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    const delegation = createTurnDelegation(services.runtime, delegating)

    const sent = delegation.createJobMessage(draft)
    const stopped = await delegation.stopJob(1, neverAbortedSignal)

    expect(sent).toMatchObject({ status: "sent", jobNumber: 1 })
    expect(stopped).toEqual({ status: "stopped", jobNumber: 1 })
    expect(
      services.runtime.jobs.listJobs(delegating.turn.conversation.id)
    ).toMatchObject([
      {
        number: 1,
        agentCode: FIRST_MEMBER,
        state: "stopped",
        jobCallIds: [draft.toolCallId]
      }
    ])
  })

  it("stores the progress notes of a job's turn for that job", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const jobTurn = services.findStartedTurn(job.replyId).context
    const delegation = createTurnDelegation(services.runtime, jobTurn)

    const outcome = delegation.createProgressNote("Found three moths")

    expect(outcome).toBe("stored")
    expect(services.runtime.jobs.findJob(job.id)?.job).toMatchObject({
      replyId: job.replyId,
      latestNote: "Found three moths"
    })
  })
})

describe("handleTurnStarted", () => {
  it("takes a person's turn's settings as wake settings while a job of the conversation works, and drops them when none works", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const whileWorking = createPersonTurn(
      services.conversation.turns,
      { kind: "existing", id: conversationId },
      LATER_TURN_SETTINGS
    )

    handleTurnStarted(services.runtime, whileWorking)
    const takenSettings =
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    await services.resolveReply(job.replyId, "completed")
    const afterReply = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    handleTurnStarted(services.runtime, afterReply)

    expect(takenSettings).toEqual({
      status: "found",
      settings: LATER_TURN_SETTINGS
    })
    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
  })

  it("leaves the wake settings alone for a backend-started turn", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const jobTurn = services.findStartedTurn(job.replyId).context
    const wakeUpWhileWorking = createWakeUpTurn(
      services.conversation.turns,
      conversationId,
      LATER_TURN_SETTINGS
    )

    handleTurnStarted(services.runtime, wakeUpWhileWorking)
    handleTurnStarted(services.runtime, jobTurn)
    await services.resolveReply(job.replyId, "completed")
    const wakeUpAfterReply = createWakeUpTurn(
      services.conversation.turns,
      conversationId,
      LATER_TURN_SETTINGS
    )
    handleTurnStarted(services.runtime, wakeUpAfterReply)

    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "found", settings: DELEGATING_TURN_SETTINGS })
  })
})
