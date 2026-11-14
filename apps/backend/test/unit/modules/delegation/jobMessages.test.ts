import { CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE } from "@lys/share"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JobMessageRefusal } from "../../../../src/modules/agent/turnDelegation"
import { ReplyGenerationRegistryClosedError } from "../../../../src/modules/chat/replyGenerationRegistry"
import type { TurnSettings } from "../../../../src/modules/chat/turnStart"
import { createJobMessage } from "../../../../src/modules/delegation/jobMessages"
import { createNewConversationTarget } from "../../support/conversationFixtures"
import {
  createJobMessageDraft,
  createPersonTurn,
  createWakeUpTurn,
  DELEGATING_TURN_SETTINGS,
  DELETED_MEMBER,
  FIRST_MEMBER,
  FIRST_MEMBER_NAME,
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  type JobMessageRequest
} from "../../support/delegationTestServices"

/** Time of a case's later turn, after every message stored before it. */
const LATER = "2026-11-13T10:05:00.000Z"

/** Other work, which some cases give the second member. */
const BUTTERFLIES_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: SECOND_MEMBER,
  title: "Butterflies",
  instructions: "Find what butterflies eat",
  jobNumber: undefined
})

/** More work for the first member, after the other two. */
const BEES_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: FIRST_MEMBER,
  title: "Bees",
  instructions: "Find what bees eat",
  jobNumber: undefined
})

/** A second message to the first member's job 1, which retitles it. */
const CATERPILLARS_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: FIRST_MEMBER,
  title: "Caterpillars",
  instructions: "Now find what caterpillars eat",
  jobNumber: 1
})

/**
 * Settings of the turn that gives the work in some cases, whose reply
 * `openai/gpt-oss-20b` writes, which tells them from the default settings.
 */
const GPT_OSS_SETTINGS: TurnSettings = Object.freeze({
  ...DELEGATING_TURN_SETTINGS,
  model: "openai/gpt-oss-20b"
})

/** A low limit, which a case reaches with few messages. */
const LOW_JOB_MESSAGE_LIMIT = 2

describe("createJobMessage", () => {
  beforeEach(() => {
    /** Time the clock reads when a case starts. */
    const now = "2026-11-13T10:00:00.000Z"

    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(now))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates job 1 with the member as its agent, the title, and the instructions as its only message, and starts its reply with the delegating turn's settings and model", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(
      services.conversation.turns,
      createNewConversationTarget(CALIGINIA_AGENT_CODE),
      GPT_OSS_SETTINGS
    )
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )

    createJobMessage(services.runtime, delegating, draft)

    const [job, ...otherJobs] = services.runtime.jobs.listJobs(conversationId)
    if (job === undefined) throw new Error("No job was stored")
    expect(otherJobs).toEqual([])
    expect(job).toMatchObject({
      number: 1,
      agentCode: FIRST_MEMBER,
      title: "Moths",
      state: "working",
      jobCallIds: [draft.toolCallId]
    })
    expect(services.conversation.history.getConversation(job.id)).toMatchObject(
      {
        parentConversationId: conversationId,
        jobNumber: 1,
        delegatorAgentCode: CALIGINIA_AGENT_CODE,
        messages: [
          { role: "user", content: "Find what moths eat", origin: "delegator" },
          {
            role: "assistant",
            id: job.replyId,
            model: "openai/gpt-oss-20b",
            status: "streaming"
          }
        ]
      }
    )
    const { options } = services.findStartedTurn(job.replyId)
    expect(options.settings).toEqual(GPT_OSS_SETTINGS)
    expect(options.startedBy).toBe("backend")
    expect(options.agent.code).toBe(FIRST_MEMBER)
    expect(options.delegation).toBe(services.runtime.hooks)
    expect(options.logger).toBe(services.runtime.logger)
  })

  it("answers sent with the job number, the member's display name, and isNewJob", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )

    const outcome = createJobMessage(services.runtime, delegating, draft)

    expect(outcome).toEqual({
      status: "sent",
      jobNumber: 1,
      agentName: FIRST_MEMBER_NAME,
      title: "Moths",
      isNewJob: true
    })
  })

  it("adds the reply to the hub, sends the job update, takes the wake settings, and reports job-message-sent", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(
      services.conversation.turns,
      createNewConversationTarget(CALIGINIA_AGENT_CODE),
      GPT_OSS_SETTINGS
    )
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )

    createJobMessage(services.runtime, delegating, draft)

    const job = services.runtime.jobs.findJobByNumber(conversationId, 1)
    if (job === undefined) throw new Error("No job was stored")
    const { generation } = services.findStartedTurn(job.replyId)
    expect(services.hub.addReply).toHaveBeenCalledExactlyOnceWith(
      {
        conversationId: job.id,
        parentConversationId: conversationId,
        assistantMessageId: job.replyId
      },
      generation
    )
    expect(services.hub.sendJobUpdate).toHaveBeenCalledExactlyOnceWith(
      conversationId,
      job
    )
    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "found", settings: GPT_OSS_SETTINGS })
    expect(services.reportEvent).toHaveBeenCalledExactlyOnceWith({
      kind: "job-message-sent",
      conversationId,
      jobId: job.id,
      jobNumber: 1,
      agentCode: FIRST_MEMBER,
      isNewJob: true
    })
  })

  it("numbers two jobs sent in the same round 1 and 2", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const mothsDraft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    const butterfliesDraft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      BUTTERFLIES_REQUEST
    )

    const moths = createJobMessage(services.runtime, delegating, mothsDraft)
    const butterflies = createJobMessage(
      services.runtime,
      delegating,
      butterfliesDraft
    )

    expect(moths).toMatchObject({ status: "sent", jobNumber: 1 })
    expect(butterflies).toMatchObject({ status: "sent", jobNumber: 2 })
    expect(services.runtime.jobs.listJobs(conversationId)).toMatchObject([
      { number: 1, agentCode: FIRST_MEMBER, title: "Moths" },
      { number: 2, agentCode: SECOND_MEMBER, title: "Butterflies" }
    ])
  })

  it("continues a finished job: same job, a second message with its own call id, the new title, isNewJob false", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const firstJob = sendJobMessage(services, delegating, MOTHS_REQUEST)
    await services.resolveReply(firstJob.replyId, "completed")
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      CATERPILLARS_REQUEST
    )

    const outcome = createJobMessage(services.runtime, delegating, draft)

    expect(outcome).toEqual({
      status: "sent",
      jobNumber: 1,
      agentName: FIRST_MEMBER_NAME,
      title: "Caterpillars",
      isNewJob: false
    })
    const job = services.runtime.jobs.findJobByNumber(conversationId, 1)
    expect(services.runtime.jobs.listJobs(conversationId)).toHaveLength(1)
    expect(job).toMatchObject({
      id: firstJob.id,
      title: "Caterpillars",
      state: "working",
      jobCallIds: [...firstJob.jobCallIds, draft.toolCallId]
    })
    expect(
      services.conversation.history.getConversation(firstJob.id)?.messages
    ).toMatchObject([
      { role: "user", content: "Find what moths eat" },
      { role: "assistant", id: firstJob.replyId, status: "completed" },
      {
        role: "user",
        content: "Now find what caterpillars eat",
        origin: "delegator"
      },
      { role: "assistant", id: job?.replyId, status: "streaming" }
    ])
    expect(services.reportEvent).toHaveBeenLastCalledWith({
      kind: "job-message-sent",
      conversationId,
      jobId: firstJob.id,
      jobNumber: 1,
      agentCode: FIRST_MEMBER,
      isNewJob: false
    })
  })

  /**
   * Number of a job that only the other conversation of the refusal cases has.
   */
  const otherConversationsJob = 2

  it.each<[string, string, number | undefined, JobMessageRefusal]>([
    [
      "an unknown agent",
      "nobody",
      undefined,
      { kind: "agent-not-found", agentCode: "nobody" }
    ],
    [
      "a deleted agent",
      DELETED_MEMBER,
      undefined,
      { kind: "agent-deleted", agentCode: DELETED_MEMBER }
    ],
    [
      "a leader",
      LYSIPTERA_AGENT_CODE,
      undefined,
      { kind: "agent-cannot-take-work", agentCode: LYSIPTERA_AGENT_CODE }
    ],
    [
      "itself",
      CALIGINIA_AGENT_CODE,
      undefined,
      { kind: "agent-cannot-take-work", agentCode: CALIGINIA_AGENT_CODE }
    ],
    [
      "a job number the conversation does not have",
      FIRST_MEMBER,
      9,
      { kind: "job-not-found", jobNumber: 9 }
    ],
    [
      "a job of another conversation",
      FIRST_MEMBER,
      otherConversationsJob,
      { kind: "job-not-found", jobNumber: otherConversationsJob }
    ],
    [
      "another agent's job",
      SECOND_MEMBER,
      1,
      { kind: "job-has-another-agent", jobNumber: 1, agentCode: FIRST_MEMBER }
    ],
    [
      "a job that is still working",
      FIRST_MEMBER,
      1,
      { kind: "job-is-working", jobNumber: 1 }
    ]
  ])(
    "refuses %s, stores nothing, starts nothing, and reports the refusal",
    (_label, agentCode, jobNumber, refusal) => {
      const services = openDelegationTestServices()
      const other = createPersonTurn(services.conversation.turns)
      sendJobMessage(services, other, MOTHS_REQUEST)
      sendJobMessage(services, other, BEES_REQUEST)
      const delegating = createPersonTurn(services.conversation.turns)
      const conversationId = delegating.turn.conversation.id
      sendJobMessage(services, delegating, MOTHS_REQUEST)
      const draft = createJobMessageDraft(
        services.conversation.replyParts,
        delegating,
        {
          agentCode,
          title: "Moths",
          instructions: "Find what moths eat",
          jobNumber
        }
      )
      const conversationIds = [other.turn.conversation.id, conversationId]
      const jobsBefore = conversationIds.map((id) =>
        services.runtime.jobs.listJobs(id)
      )
      const startedCount = services.listStartedTurns().length
      const addedReplyCount = services.hub.addReply.mock.calls.length

      const outcome = createJobMessage(services.runtime, delegating, draft)

      expect(outcome).toEqual({ status: "refused", refusal })
      expect(
        conversationIds.map((id) => services.runtime.jobs.listJobs(id))
      ).toEqual(jobsBefore)
      expect(services.listStartedTurns()).toHaveLength(startedCount)
      expect(services.hub.addReply).toHaveBeenCalledTimes(addedReplyCount)
      expect(services.reportEvent).toHaveBeenLastCalledWith({
        kind: "job-message-refused",
        conversationId,
        agentCode,
        jobNumber,
        reason: refusal.kind
      })
    }
  )

  it("refuses the 13th job message since the person's last message with the limit in the refusal", () => {
    /** Job messages a limited case allows since the person's last message. */
    const jobMessageLimit = 12

    const services = openDelegationTestServices({
      agentJobMessageLimit: jobMessageLimit
    })
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    for (let sent = 0; sent < jobMessageLimit; sent += 1)
      sendJobMessage(services, delegating, MOTHS_REQUEST)
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )

    const outcome = createJobMessage(services.runtime, delegating, draft)

    expect(outcome).toEqual({
      status: "refused",
      refusal: { kind: "limit-reached", limit: jobMessageLimit }
    })
    expect(services.runtime.jobs.listJobs(conversationId)).toHaveLength(
      jobMessageLimit
    )
    expect(services.reportEvent).toHaveBeenLastCalledWith({
      kind: "job-message-refused",
      conversationId,
      agentCode: FIRST_MEMBER,
      jobNumber: undefined,
      reason: "limit-reached"
    })
  })

  it("counts again from zero after the person's next message", () => {
    const services = openDelegationTestServices({
      agentJobMessageLimit: LOW_JOB_MESSAGE_LIMIT
    })
    const first = createPersonTurn(services.conversation.turns)
    const conversationId = first.turn.conversation.id
    sendJobMessage(services, first, MOTHS_REQUEST)
    sendJobMessage(services, first, BUTTERFLIES_REQUEST)
    vi.setSystemTime(new Date(LATER))
    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    const drafts = [MOTHS_REQUEST, BUTTERFLIES_REQUEST, BEES_REQUEST].map(
      (request) =>
        createJobMessageDraft(services.conversation.replyParts, next, request)
    )

    const outcomes = drafts.map((draft) =>
      createJobMessage(services.runtime, next, draft)
    )

    expect(outcomes).toMatchObject([
      { status: "sent", jobNumber: 3 },
      { status: "sent", jobNumber: 4 },
      {
        status: "refused",
        refusal: { kind: "limit-reached", limit: LOW_JOB_MESSAGE_LIMIT }
      }
    ])
  })

  it("does not reset the count for a wake-up message", () => {
    const services = openDelegationTestServices({
      agentJobMessageLimit: LOW_JOB_MESSAGE_LIMIT
    })
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    sendJobMessage(services, delegating, MOTHS_REQUEST)
    sendJobMessage(services, delegating, BUTTERFLIES_REQUEST)
    vi.setSystemTime(new Date(LATER))
    const wakeUp = createWakeUpTurn(
      services.conversation.turns,
      conversationId,
      DELEGATING_TURN_SETTINGS
    )
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      wakeUp,
      BEES_REQUEST
    )

    const outcome = createJobMessage(services.runtime, wakeUp, draft)

    expect(outcome).toEqual({
      status: "refused",
      refusal: { kind: "limit-reached", limit: LOW_JOB_MESSAGE_LIMIT }
    })
    expect(services.runtime.jobs.listJobs(conversationId)).toHaveLength(
      LOW_JOB_MESSAGE_LIMIT
    )
  })

  it("refuses when the conversation was deleted", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    services.conversation.editor.deleteConversation(conversationId)

    const outcome = createJobMessage(services.runtime, delegating, draft)

    expect(outcome).toEqual({
      status: "refused",
      refusal: { kind: "conversation-missing" }
    })
    expect(services.runtime.jobs.listJobs(conversationId)).toEqual([])
    expect(services.listStartedTurns()).toEqual([])
    expect(services.hub.addReply).not.toHaveBeenCalled()
    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
    expect(services.reportEvent).toHaveBeenCalledExactlyOnceWith({
      kind: "job-message-refused",
      conversationId,
      agentCode: FIRST_MEMBER,
      jobNumber: undefined,
      reason: "conversation-missing"
    })
  })

  it("keeps the job turn stored with an interrupted reply whose end was handled, and throws, when the job's reply cannot start", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      services.conversation.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    await services.generations[Symbol.asyncDispose]()

    expect(() => createJobMessage(services.runtime, delegating, draft)).toThrow(
      ReplyGenerationRegistryClosedError
    )

    const job = services.runtime.jobs.findJobByNumber(conversationId, 1)
    if (job === undefined) throw new Error("No job was stored")
    expect(job).toMatchObject({
      state: "interrupted",
      jobCallIds: [draft.toolCallId]
    })
    expect(
      services.conversation.history.getConversation(job.id)?.messages
    ).toMatchObject([
      { role: "user", origin: "delegator" },
      { role: "assistant", id: job.replyId, status: "interrupted" }
    ])
    vi.setSystemTime(new Date(LATER))
    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "interrupted", content: "" }
    ])
    expect(services.hub.addReply).not.toHaveBeenCalled()
    expect(services.hub.sendJobUpdate).toHaveBeenCalledExactlyOnceWith(
      conversationId,
      job
    )
    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
  })
})
