import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createProgressNote } from "../../../../src/modules/delegation/progressNotes"
import { listJobReportRows } from "../../support/conversationDatabase"
import {
  createPersonTurn,
  MOTHS_REQUEST,
  openDelegationTestServices,
  sendJobMessage
} from "../../support/delegationTestServices"

/** Time the clock reads while a case runs. */
const NOW = "2026-11-13T10:00:00.000Z"

describe("createProgressNote", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stores the note for the job's current reply with the job's title, sends the job update with latestNote, and reports it", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const jobTurn = services.findStartedTurn(job.replyId).context

    const outcome = createProgressNote(
      services.runtime,
      jobTurn,
      "Found three moths"
    )

    expect(outcome).toBe("stored")
    expect(listJobReportRows(services.conversation.database)).toEqual([
      {
        id: expect.any(String),
        jobId: job.id,
        replyId: job.replyId,
        kind: "note",
        title: "Moths",
        content: "Found three moths",
        sourceNumbers: [],
        createdAt: NOW,
        deliveredMessageId: null
      }
    ])
    const updatedJob = services.runtime.jobs.findJob(job.id)?.job
    expect(updatedJob).toMatchObject({ latestNote: "Found three moths" })
    expect(services.hub.sendJobUpdate).toHaveBeenLastCalledWith(
      conversationId,
      updatedJob
    )
    expect(services.reportEvent).toHaveBeenLastCalledWith({
      kind: "report-stored",
      conversationId,
      jobId: job.id,
      jobNumber: 1,
      reportKind: "note"
    })
  })

  it("replaces an undelivered note and keeps a delivered one", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const conversationId = delegating.turn.conversation.id
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const jobTurn = services.findStartedTurn(job.replyId).context
    createProgressNote(services.runtime, jobTurn, "Found three moths")
    const delivering = createPersonTurn(services.conversation.turns, {
      kind: "existing",
      id: conversationId
    })
    createProgressNote(services.runtime, jobTurn, "Found five moths")

    createProgressNote(services.runtime, jobTurn, "Found eight moths")

    expect(listJobReportRows(services.conversation.database)).toMatchObject([
      {
        content: "Found three moths",
        deliveredMessageId: delivering.turn.userMessage.id
      },
      { content: "Found eight moths", deliveredMessageId: null }
    ])
  })

  it("answers job-missing when the job was deleted", () => {
    const services = openDelegationTestServices()
    const delegating = createPersonTurn(services.conversation.turns)
    const job = sendJobMessage(services, delegating, MOTHS_REQUEST)
    const jobTurn = services.findStartedTurn(job.replyId).context
    services.conversation.editor.deleteConversation(
      delegating.turn.conversation.id
    )
    const updateCount = services.hub.sendJobUpdate.mock.calls.length
    const eventCount = services.reportEvent.mock.calls.length

    const outcome = createProgressNote(
      services.runtime,
      jobTurn,
      "Found three moths"
    )

    expect(outcome).toBe("job-missing")
    expect(listJobReportRows(services.conversation.database)).toEqual([])
    expect(services.hub.sendJobUpdate).toHaveBeenCalledTimes(updateCount)
    expect(services.reportEvent).toHaveBeenCalledTimes(eventCount)
  })
})
