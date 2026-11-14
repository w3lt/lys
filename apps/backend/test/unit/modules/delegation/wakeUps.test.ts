import { CALIGINIA_AGENT_CODE, type Job, type JobState } from "@lys/share"
import { describe, expect, it } from "vitest"
import { ReplyGenerationRegistryClosedError } from "../../../../src/modules/chat/replyGenerationRegistry"
import type { TurnSettings } from "../../../../src/modules/chat/turnStart"
import type { DelegationEvent } from "../../../../src/modules/delegation/delegationEvent"
import { createJobMessage } from "../../../../src/modules/delegation/jobMessages"
import { stopJob } from "../../../../src/modules/delegation/jobStops"
import { startDueWakeUpTurn } from "../../../../src/modules/delegation/wakeUps"
import { createNewConversationTarget } from "../../support/conversationFixtures"
import {
  createJobMessageDraft,
  createPersonTurn,
  DELEGATING_TURN_SETTINGS,
  DELETED_MEMBER,
  FIRST_MEMBER,
  MOTHS_REQUEST,
  openDelegationTestServices,
  SECOND_MEMBER,
  sendJobMessage,
  startPersonTurn,
  type DelegationTestServices,
  type JobMessageRequest,
  type ScriptedTurn
} from "../../support/delegationTestServices"

/** Text of the last round of the job replies the cases complete. */
const RESULT_TEXT = "Most moths drink nectar."

/** Work a case gives {@link SECOND_MEMBER} beside the moths job. */
const ARCHIVE_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: SECOND_MEMBER,
  title: "Archive",
  instructions: "File what is known about moths",
  jobNumber: undefined
})

/**
 * Ends a working job in a way that wakes nobody.
 *
 * @param services - The case's runtime and controls.
 * @param job - The working job, as stored when it was sent.
 * @param conversationId - UUIDv7 of the conversation the job belongs to.
 * @returns A promise that resolves once the end of the job's reply was
 * handled.
 */
type QuietJobEnding = (
  services: DelegationTestServices,
  job: Job,
  conversationId: string
) => Promise<void>

/**
 * Stops a job as its delegator does with `stop_job`.
 *
 * @param services - The case's runtime.
 * @param job - The working job.
 * @param conversationId - UUIDv7 of the conversation the job belongs to.
 * @returns A promise that resolves once the stop answered, after the job's
 * reply ended.
 */
async function stopJobAsDelegator(
  services: DelegationTestServices,
  job: Job,
  conversationId: string
): Promise<void> {
  /** Cancellation of a wait that a case never cancels. */
  const neverAbortedSignal = new AbortController().signal

  await stopJob(services.runtime, {
    conversationId,
    jobNumber: job.number,
    abortSignal: neverAbortedSignal
  })
}

/**
 * Stops a job's reply at the person's request.
 *
 * @param services - The case's runtime and controls.
 * @param job - The working job.
 * @returns A promise that resolves once the reply's end was handled.
 */
async function stopJobAsPerson(
  services: DelegationTestServices,
  job: Job
): Promise<void> {
  services.runtime.stopRequests.addStopRequest(job.replyId, "person")
  await services.findStartedTurn(job.replyId).generation.stopReply()
}

/**
 * Ends a job's reply as interrupted without anyone asking it to stop, as
 * the backend's shutdown cuts a reply off.
 *
 * @param services - The case's controls.
 * @param job - The working job.
 * @returns A promise that resolves once the reply's end was handled.
 */
async function interruptJob(
  services: DelegationTestServices,
  job: Job
): Promise<void> {
  await services.resolveReply(job.replyId, "interrupted")
}

/**
 * Stores the text a job's reply writes in its first round, as the reply's
 * agent writes it.
 *
 * @param services - The case's conversation services.
 * @param job - The working job.
 * @throws If the job's reply is no longer streaming.
 */
function createResultText(
  services: Pick<DelegationTestServices, "conversation">,
  job: Job
): void {
  const part = services.conversation.replyParts.createReplyPart(job.replyId, {
    kind: "text",
    round: 0,
    content: RESULT_TEXT
  })
  if (part === undefined) throw new Error("The job's reply took no text")
}

/**
 * Lists the wake-up turns a case's runtime started.
 *
 * @param services - The case's controls.
 * @returns The started turns whose message is a wake-up message, in start
 * order.
 */
function listWakeUpTurns(
  services: Pick<DelegationTestServices, "listStartedTurns">
): readonly ScriptedTurn[] {
  return services
    .listStartedTurns()
    .filter((started) => started.context.turn.userMessage.origin === "wake-up")
}

/**
 * Finds the latest wake-up turn a case's runtime started.
 *
 * @param services - The case's controls.
 * @returns The wake-up turn started last.
 * @throws If no wake-up turn was started.
 */
function findLatestWakeUpTurn(
  services: Pick<DelegationTestServices, "listStartedTurns">
): ScriptedTurn {
  const wakeUp = listWakeUpTurns(services).at(-1)
  if (wakeUp === undefined) throw new Error("No wake-up turn was started")
  return wakeUp
}

/**
 * Finds the only wake-up turn a case's runtime started.
 *
 * @param services - The case's controls.
 * @returns The wake-up turn.
 * @throws If no wake-up turn was started, or more than one.
 */
function findOnlyWakeUpTurn(
  services: Pick<DelegationTestServices, "listStartedTurns">
): ScriptedTurn {
  const wakeUpCount = listWakeUpTurns(services).length
  if (wakeUpCount !== 1)
    throw new Error(`${wakeUpCount} wake-up turns were started, not one`)
  return findLatestWakeUpTurn(services)
}

/**
 * Lists the events a case's runtime reported about wake-up turns.
 *
 * @param services - The case's event recorder.
 * @returns The `wake-up-started` and `wake-up-skipped` events, in the order
 * they were reported.
 */
function listWakeUpEvents(
  services: Pick<DelegationTestServices, "reportEvent">
): readonly DelegationEvent[] {
  return services.reportEvent.mock.calls
    .map(([event]) => event)
    .filter(
      (event) =>
        event.kind === "wake-up-started" || event.kind === "wake-up-skipped"
    )
}

describe("startDueWakeUpTurn", () => {
  it("starts a wake-up turn in the idle parent when a job's result arrives: a wake-up message that carries the report, the lead's reply started with the settings of the turn that delegated", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    createResultText(services, job)

    await services.resolveReply(job.replyId, "completed")

    const { options, generation } = findOnlyWakeUpTurn(services)
    const assistantMessageId = options.turn.assistantMessage.id
    expect(options.turn.conversation.id).toBe(conversationId)
    expect(options.turn.userMessage).toMatchObject({
      origin: "wake-up",
      content: "Reports from your jobs arrived. No job is still working.",
      attachments: [],
      reports: [
        {
          jobId: job.id,
          jobNumber: 1,
          agentCode: FIRST_MEMBER,
          title: "Moths",
          kind: "result",
          content: RESULT_TEXT
        }
      ]
    })
    expect(options.turn.assistantMessage.model).toBe(
      DELEGATING_TURN_SETTINGS.model
    )
    expect(options.agent.code).toBe(CALIGINIA_AGENT_CODE)
    expect(options.settings).toBe(DELEGATING_TURN_SETTINGS)
    expect(options.startedBy).toBe("backend")
    expect(options.delegation).toBe(services.runtime.hooks)
    expect(services.hub.addReply).toHaveBeenLastCalledWith(
      { conversationId, parentConversationId: null, assistantMessageId },
      generation
    )
    expect(listWakeUpEvents(services)).toEqual([
      {
        kind: "wake-up-started",
        conversationId,
        assistantMessageId,
        reportCount: 1
      }
    ])
  })

  it("starts a wake-up turn for a failed job, which delivers the failure", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")

    await services.resolveReply(
      job.replyId,
      "failed",
      "The model stopped answering."
    )

    const { options } = findOnlyWakeUpTurn(services)
    expect(options.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "failed", content: "The model stopped answering." }
    ])
  })

  it.each<[string, QuietJobEnding, JobState]>([
    ["its delegator stopped", stopJobAsDelegator, "stopped"],
    ["the person stopped", stopJobAsPerson, "stopped"],
    ["was interrupted", interruptJob, "interrupted"]
  ])(
    "starts no wake-up for a job that %s",
    async (_label, endJob, jobState) => {
      const services = openDelegationTestServices()
      const lead = startPersonTurn(services)
      const conversationId = lead.turn.conversation.id
      const job = sendJobMessage(services, lead, MOTHS_REQUEST)
      await services.resolveReply(lead.turn.assistantMessage.id, "completed")

      await endJob(services, job, conversationId)

      expect(services.runtime.jobs.findJob(job.id)?.job.state).toBe(jobState)
      expect(listWakeUpTurns(services)).toEqual([])
      expect(listWakeUpEvents(services)).toEqual([])
    }
  )

  it("starts no wake-up for a progress note", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    const jobTurn = services.findStartedTurn(job.replyId)

    const outcome = jobTurn.delegation.createProgressNote("Half are listed.")

    expect(outcome).toBe("stored")
    expect(listWakeUpTurns(services)).toEqual([])
    expect(listWakeUpEvents(services)).toEqual([])
  })

  it("waits while the lead's reply streams, and starts the wake-up when that reply completes", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(job.replyId, "completed")
    const wakeUpCountWhileStreaming = listWakeUpTurns(services).length

    await services.resolveReply(lead.turn.assistantMessage.id, "completed")

    const { options } = findOnlyWakeUpTurn(services)
    expect(wakeUpCountWhileStreaming).toBe(0)
    expect(options.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "result" }
    ])
    expect(listWakeUpEvents(services)).toEqual([
      { kind: "wake-up-skipped", conversationId, reason: "reply-streaming" },
      {
        kind: "wake-up-started",
        conversationId,
        assistantMessageId: options.turn.assistantMessage.id,
        reportCount: 1
      }
    ])
  })

  it("starts the wake-up when the lead's streaming reply fails", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(job.replyId, "completed")

    await services.resolveReply(
      lead.turn.assistantMessage.id,
      "failed",
      "The model stopped answering."
    )

    const { options } = findOnlyWakeUpTurn(services)
    expect(options.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "result" }
    ])
  })

  it("starts nothing when the person stopped the lead's reply, and delivers the report with the person's next message", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(job.replyId, "completed")
    const leadTurn = services.findStartedTurn(lead.turn.assistantMessage.id)

    await leadTurn.generation.stopReply()

    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(listWakeUpTurns(services)).toEqual([])
    expect(listWakeUpEvents(services)).toEqual([
      { kind: "wake-up-skipped", conversationId, reason: "reply-streaming" }
    ])
    expect(next.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "result" }
    ])
  })

  it("delivers two results that arrived during one lead reply with one wake-up turn", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const first = sendJobMessage(services, lead, MOTHS_REQUEST)
    const second = sendJobMessage(services, lead, ARCHIVE_REQUEST)
    await services.resolveReply(first.replyId, "completed")
    await services.resolveReply(second.replyId, "completed")

    await services.resolveReply(lead.turn.assistantMessage.id, "completed")

    const { options } = findOnlyWakeUpTurn(services)
    expect(options.turn.userMessage.reports).toMatchObject([
      { jobId: first.id, jobNumber: 1, kind: "result" },
      { jobId: second.id, jobNumber: 2, kind: "result" }
    ])
    expect(services.reportEvent).toHaveBeenLastCalledWith({
      kind: "wake-up-started",
      conversationId,
      assistantMessageId: options.turn.assistantMessage.id,
      reportCount: 2
    })
  })

  it("names the jobs that are still working in the wake-up message", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const first = sendJobMessage(services, lead, MOTHS_REQUEST)
    sendJobMessage(services, lead, ARCHIVE_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")

    await services.resolveReply(first.replyId, "completed")

    const { options } = findOnlyWakeUpTurn(services)
    expect(options.turn.userMessage.content).toBe(
      "Reports from your jobs arrived. Still working: job 2 (archivist)."
    )
  })

  it("starts no wake-up without wake settings and reports no-wake-settings", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    services.runtime.wakeSettings.removeWakeSettings(conversationId)

    await services.resolveReply(job.replyId, "completed")

    expect(listWakeUpTurns(services)).toEqual([])
    expect(listWakeUpEvents(services)).toEqual([
      { kind: "wake-up-skipped", conversationId, reason: "no-wake-settings" }
    ])
  })

  it("starts no wake-up after the wake settings were closed and reports shutting-down", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    services.runtime.wakeSettings.close()

    await services.resolveReply(job.replyId, "completed")

    expect(listWakeUpTurns(services)).toEqual([])
    expect(listWakeUpEvents(services)).toEqual([
      { kind: "wake-up-skipped", conversationId, reason: "shutting-down" }
    ])
  })

  it("starts no wake-up when the conversation's agent cannot be loaded and reports agent-missing", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(
      services.conversation.turns,
      createNewConversationTarget(DELETED_MEMBER)
    )
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    services.conversation.turns.updateAssistantMessageState(
      delegating.turn.assistantMessage.id,
      { status: "completed", finishReason: "stop" }
    )

    await services.resolveReply(job.replyId, "completed")

    expect(listWakeUpTurns(services)).toEqual([])
    expect(listWakeUpEvents(services)).toEqual([
      { kind: "wake-up-skipped", conversationId, reason: "agent-missing" }
    ])
  })

  it("takes the wake settings from the person's latest turn while a job works: the wake-up runs with the newer model", async () => {
    /**
     * Settings of a later turn of the person's, written with another model than
     * {@link DELEGATING_TURN_SETTINGS}.
     */
    const laterTurnSettings: TurnSettings = Object.freeze({
      ...DELEGATING_TURN_SETTINGS,
      model: "qwen/qwen3-14b"
    })

    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    const later = startPersonTurn(
      services,
      { kind: "existing", id: conversationId },
      laterTurnSettings
    )
    await services.resolveReply(later.turn.assistantMessage.id, "completed")

    await services.resolveReply(job.replyId, "completed")

    const { options } = findOnlyWakeUpTurn(services)
    expect(options.settings).toBe(laterTurnSettings)
    expect(options.turn.assistantMessage.model).toBe("qwen/qwen3-14b")
  })

  it("leaves the reports delivered and starts no further wake-up when the wake-up reply fails because its model is not loaded", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    await services.resolveReply(job.replyId, "completed")
    const wakeUp = findOnlyWakeUpTurn(services)
    const wakeUpReplyId = wakeUp.options.turn.assistantMessage.id

    await services.resolveReply(
      wakeUpReplyId,
      "failed",
      "The model qwen/qwen3-8b is not loaded."
    )

    expect(listWakeUpTurns(services)).toHaveLength(1)
    expect(listWakeUpEvents(services)).toEqual([
      {
        kind: "wake-up-started",
        conversationId,
        assistantMessageId: wakeUpReplyId,
        reportCount: 1
      }
    ])
    expect(
      services.conversation.history.getConversation(conversationId)?.messages
    ).toMatchObject([
      { role: "user", origin: "person" },
      { role: "assistant", status: "completed" },
      {
        role: "user",
        origin: "wake-up",
        reports: [{ jobId: job.id, kind: "result" }]
      },
      { id: wakeUpReplyId, role: "assistant", status: "failed" }
    ])
  })

  it("starts at most as many wake-up turns as job messages were sent since the person's last message", async () => {
    const services = openDelegationTestServices({ agentJobMessageLimit: 2 })
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const first = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    await services.resolveReply(first.replyId, "completed")
    const firstWakeUp = findLatestWakeUpTurn(services).context
    const second = sendJobMessage(services, firstWakeUp, ARCHIVE_REQUEST)
    await services.resolveReply(
      firstWakeUp.turn.assistantMessage.id,
      "completed"
    )
    await services.resolveReply(second.replyId, "completed")
    const secondWakeUp = findLatestWakeUpTurn(services).context
    const thirdDraft = createJobMessageDraft(
      services.conversation.replyParts,
      secondWakeUp,
      MOTHS_REQUEST
    )

    const thirdOutcome = createJobMessage(
      services.runtime,
      secondWakeUp,
      thirdDraft
    )
    await services.resolveReply(
      secondWakeUp.turn.assistantMessage.id,
      "completed"
    )

    expect(thirdOutcome).toEqual({
      status: "refused",
      refusal: { kind: "limit-reached", limit: 2 }
    })
    expect(listWakeUpTurns(services)).toHaveLength(2)
    expect(
      services.runtime.jobs.getJobMessageCountSincePersonMessage(conversationId)
    ).toBe(2)
  })

  it("delivers a report exactly once: with the wake-up turn, and not again with the person's next message", async () => {
    const services = openDelegationTestServices()
    const lead = startPersonTurn(services)
    const conversationId = lead.turn.conversation.id
    const job = sendJobMessage(services, lead, MOTHS_REQUEST)
    await services.resolveReply(lead.turn.assistantMessage.id, "completed")
    await services.resolveReply(job.replyId, "completed")
    const wakeUp = findOnlyWakeUpTurn(services)
    await services.resolveReply(
      wakeUp.options.turn.assistantMessage.id,
      "completed"
    )

    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })

    expect(wakeUp.options.turn.userMessage.reports).toMatchObject([
      { jobId: job.id, kind: "result" }
    ])
    expect(next.turn.userMessage.reports).toEqual([])
  })

  it("keeps the wake-up turn and the reports it delivered stored with an interrupted reply whose end was handled, and throws, when the wake-up reply cannot start", async () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    await services.resolveReply(job.replyId, "completed")
    services.conversation.turns.updateAssistantMessageState(
      delegating.turn.assistantMessage.id,
      { status: "completed", finishReason: "stop" }
    )
    await services.generations[Symbol.asyncDispose]()

    expect(() => startDueWakeUpTurn(services.runtime, conversationId)).toThrow(
      ReplyGenerationRegistryClosedError
    )

    const messages =
      services.conversation.history.getConversation(conversationId)?.messages
    expect(messages).toMatchObject([
      { role: "user", origin: "person" },
      { role: "assistant", status: "completed" },
      {
        role: "user",
        origin: "wake-up",
        reports: [{ jobId: job.id, kind: "result" }]
      },
      { role: "assistant", status: "interrupted" }
    ])
    const wakeUpReplyId = messages?.at(-1)?.id
    const next = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    expect(next.turn.userMessage.reports).toEqual([])
    expect(services.hub.addReply).toHaveBeenCalledOnce()
    expect(services.hub.removeReply).toHaveBeenLastCalledWith(
      wakeUpReplyId,
      "interrupted"
    )
    expect(
      services.runtime.wakeSettings.findWakeSettings(conversationId)
    ).toEqual({ status: "none" })
    expect(listWakeUpEvents(services)).toEqual([
      { kind: "wake-up-skipped", conversationId, reason: "reply-streaming" }
    ])
  })
})
