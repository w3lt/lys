import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { Job, JobReportKind } from "@lys/share"
import type {
  JobActivityReader,
  JobReader,
  JobReportWriter,
  NewEndReport,
  NewProgressNote
} from "../../../src/modules/delegation/records"
import {
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart
} from "./conversationFixtures"
import {
  buildExpectedJob,
  createFixtureTimestamp,
  createJobFixture,
  saveFollowUpMessage,
  saveJob,
  saveJobMessage,
  saveMainConversation,
  saveReport,
  type ConversationRecordsHarness,
  type JobFixture,
  type JobReportRowFixture,
  type JobSeedingHarness,
  type StoredJobFixture
} from "./conversationRecordsContract"

/** Job records over one empty store, with the controls a case needs. */
export type DelegationRecordsHarness = Pick<
  ConversationRecordsHarness,
  | "saveConversation"
  | "saveUserMessage"
  | "saveAssistantMessage"
  | "saveJobReport"
  | "closeRecords"
> &
  Readonly<{
    /** Reads of the jobs of conversations. */
    jobReader: JobReader
    /** Reads of what replies and reports wait for. */
    jobActivityReader: JobActivityReader
    /** Report persistence over the store. */
    jobReportWriter: JobReportWriter
    /** Lists every stored report, oldest first and then by identity. */
    listJobReports: () => readonly JobReportRowFixture[]
  }>

/**
 * Creates the job records over one empty store owned by the current test,
 * which closes the store when it finishes.
 */
export type DelegationRecordsHarnessFactory = () => DelegationRecordsHarness

/** Identity no case stores. */
const UNKNOWN_ID = createFixtureUuidV7(999)

/** Time a case passes as the moment a report is written. */
const REPORTED_AT = "2026-03-04T05:06:07.890Z"

/**
 * Stores a streaming reply without parts in a stored conversation.
 *
 * @param harness - Store under test.
 * @param conversationId - Stored conversation that gets the reply.
 * @param sequence - Identity sequence of the reply.
 * @returns The reply's identity.
 * @remarks Stored at 00:50 of 2025-01-01, after every job fixture, so it is
 * the conversation's newest reply.
 */
function saveStreamingReply(
  harness: JobSeedingHarness,
  conversationId: string,
  sequence: number
): string {
  const id = createFixtureUuidV7(sequence)
  harness.saveAssistantMessage({
    id,
    conversationId,
    model: "qwen/qwen3-8b",
    provider: "lmStudio",
    parts: [],
    status: "streaming",
    finishReason: null,
    createdAt: createFixtureTimestamp(50),
    updatedAt: createFixtureTimestamp(50)
  })
  return id
}

/**
 * Builds the row a store holds for a report it was given.
 *
 * @param report - The report as it was passed to the store.
 * @param kind - What the report says.
 * @returns The row: the report's own values, no cited source, and no
 * delivering message.
 */
function buildStoredReportRow(
  report: NewProgressNote,
  kind: JobReportKind
): JobReportRowFixture {
  return {
    id: report.id,
    jobId: report.jobId,
    replyId: report.replyId,
    kind,
    title: report.title,
    content: report.content,
    sourceNumbers: [],
    createdAt: report.createdAt,
    deliveredMessageId: null
  }
}

/**
 * Registers the {@link JobReader.listJobs} cases that read which jobs a
 * conversation has and what each one holds.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerJobListCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("lists a conversation's jobs in number order with agent, title, reply, call ids, and times", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const secondFixture: JobFixture = {
      sequence: 10,
      parentId: mainId,
      number: 2,
      createdAtMinute: 1,
      replyStatus: "streaming"
    }
    const firstFixture: JobFixture = {
      sequence: 20,
      parentId: mainId,
      number: 1,
      createdAtMinute: 2,
      replyStatus: "completed"
    }
    const second = saveJob(harness, secondFixture)
    const first = saveJob(harness, firstFixture)

    expect(harness.jobReader.listJobs(mainId)).toEqual([
      buildExpectedJob(first, firstFixture, "replied"),
      buildExpectedJob(second, secondFixture, "working")
    ])
  })

  it("lists only the addressed conversation's jobs, and none for a job or an unknown conversation", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const otherFixture: JobFixture = {
      ...createJobFixture(otherId, 1, "completed"),
      sequence: 110
    }
    const otherJob = saveJob(harness, otherFixture)

    expect(harness.jobReader.listJobs(otherId)).toEqual([
      buildExpectedJob(otherJob, otherFixture, "replied")
    ])
    expect(harness.jobReader.listJobs(job.id)).toEqual([])
    expect(harness.jobReader.listJobs(UNKNOWN_ID)).toEqual([])
  })

  it("lists the call ids of every job message, oldest first and not in identity order", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const continuation = saveJobMessage(harness, {
      sequence: 5,
      parentId: mainId,
      jobId: job.id,
      createdAt: createFixtureTimestamp(3)
    })

    expect(
      harness.jobReader.listJobs(mainId).map(({ jobCallIds }) => jobCallIds)
    ).toEqual([[job.callId, continuation.callId]])
  })

  it("rejects a stored job that has no message or reply, and stays usable", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    harness.saveConversation({
      id: createFixtureUuidV7(10),
      title: "Find what moths eat",
      agentCode: "researcher",
      createdAt: createFixtureTimestamp(1),
      parentConversationId: mainId,
      jobNumber: 1
    })

    expect(() => harness.jobReader.listJobs(mainId)).toThrow(z.ZodError)
    expect(() => harness.jobReader.findJob(createFixtureUuidV7(10))).toThrow(
      z.ZodError
    )
    expect(() => harness.jobReader.findJobByNumber(mainId, 1)).toThrow(
      z.ZodError
    )

    expect(harness.jobReader.listJobs(otherId)).toEqual([])
  })
}

/**
 * Registers the {@link JobReader.listJobs} cases that read a job's state,
 * reply, and latest note from its newest reply.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerJobStateCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it.each([
    ["streaming as working", "streaming", "working"],
    ["completed as replied", "completed", "replied"],
    ["failed as failed", "failed", "failed"],
    ["interrupted, without an end report, as stopped", "interrupted", "stopped"]
  ] as const)(
    "reads a job whose latest reply is %s",
    (_label, replyStatus, state) => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      saveJob(harness, createJobFixture(mainId, 1, replyStatus))

      expect(
        harness.jobReader.listJobs(mainId).map((job) => job.state)
      ).toEqual([state])
    }
  )

  it.each([
    [
      "completed, with a result report, as replied",
      {
        replyStatus: "completed",
        report: { kind: "result", content: "They eat wool." },
        state: "replied"
      }
    ],
    [
      "failed, with a failed report, as failed",
      {
        replyStatus: "failed",
        report: { kind: "failed", content: "The feed was down." },
        state: "failed"
      }
    ],
    [
      "interrupted, with a stopped report, as stopped",
      {
        replyStatus: "interrupted",
        report: { kind: "stopped", content: "" },
        state: "stopped"
      }
    ],
    [
      "interrupted, with an interrupted report, as interrupted",
      {
        replyStatus: "interrupted",
        report: { kind: "interrupted", content: "" },
        state: "interrupted"
      }
    ]
  ] as const)(
    "reads a job whose latest reply is %s",
    (_label, { replyStatus, report, state }) => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      const job = saveJob(harness, createJobFixture(mainId, 1, replyStatus))
      saveReport(harness, job, {
        ...report,
        sequence: 200,
        title: "Job 1",
        createdAt: createFixtureTimestamp(1, 3)
      })

      expect(
        harness.jobReader.listJobs(mainId).map((listed) => listed.state)
      ).toEqual([state])
    }
  )

  it("reads a job's state, reply, and note from its newest reply, not from an earlier one", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "interrupted"))
    saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Note of the earlier reply",
      createdAt: createFixtureTimestamp(1, 3)
    })
    saveReport(harness, job, {
      sequence: 201,
      kind: "interrupted",
      title: "Job 1",
      content: "",
      createdAt: createFixtureTimestamp(1, 4)
    })
    const newestReplyId = saveStreamingReply(harness, job.id, 300)

    expect(harness.jobReader.listJobs(mainId)).toMatchObject([
      { state: "working", replyId: newestReplyId, latestNote: null }
    ])
  })

  it("takes the reply with the later identity as the newest of two created at the same time", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const laterReplyId = createFixtureUuidV7(300)
    harness.saveAssistantMessage({
      id: laterReplyId,
      conversationId: job.id,
      model: "qwen/qwen3-8b",
      provider: "lmStudio",
      parts: [],
      status: "failed",
      finishReason: null,
      createdAt: createFixtureTimestamp(1, 2),
      updatedAt: createFixtureTimestamp(1, 2)
    })

    expect(harness.jobReader.listJobs(mainId)).toMatchObject([
      { state: "failed", replyId: laterReplyId }
    ])
  })

  it("reads the newest note of the job's latest reply as its latest note, delivered or not", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))
    const deliveringId = saveFollowUpMessage(harness, mainId, 300)
    saveReport(harness, job, {
      sequence: 201,
      kind: "note",
      title: "Job 1",
      content: "First note",
      createdAt: createFixtureTimestamp(1, 3)
    })
    saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Second note",
      createdAt: createFixtureTimestamp(1, 4),
      deliveredMessageId: deliveringId
    })

    expect(
      harness.jobReader.listJobs(mainId).map((listed) => listed.latestNote)
    ).toEqual(["Second note"])
  })
}

/**
 * Registers the {@link JobReader.findJob} and
 * {@link JobReader.findJobByNumber} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerJobLookupCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("finds a job by its id with its parent, and nothing for a main conversation or an unknown id", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const fixture = createJobFixture(mainId, 2, "failed")
    const job = saveJob(harness, fixture)

    expect(harness.jobReader.findJob(job.id)).toEqual({
      parentConversationId: mainId,
      job: buildExpectedJob(job, fixture, "failed")
    })
    expect(harness.jobReader.findJob(mainId)).toBeUndefined()
    expect(harness.jobReader.findJob(UNKNOWN_ID)).toBeUndefined()
  })

  it("finds a job by its number only inside its parent", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    const fixture = createJobFixture(mainId, 2, "completed")
    const job = saveJob(harness, fixture)
    saveJob(harness, createJobFixture(otherId, 3, "completed"))

    expect(harness.jobReader.findJobByNumber(mainId, 2)).toEqual(
      buildExpectedJob(job, fixture, "replied")
    )
    expect(harness.jobReader.findJobByNumber(mainId, 3)).toBeUndefined()
    expect(harness.jobReader.findJobByNumber(otherId, 2)).toBeUndefined()
    expect(harness.jobReader.findJobByNumber(UNKNOWN_ID, 2)).toBeUndefined()
  })
}

/**
 * Registers the {@link JobReader.getJobMessageCountSincePersonMessage} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerJobMessageCountCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("counts the job messages created at or after the person's latest message and ignores earlier ones", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      1
    )

    saveFollowUpMessage(harness, mainId, 300)
    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      0
    )

    saveJobMessage(harness, {
      sequence: 310,
      parentId: mainId,
      jobId: job.id,
      createdAt: createFixtureTimestamp(40)
    })
    saveJob(harness, {
      ...createJobFixture(mainId, 2, "streaming"),
      createdAtMinute: 41
    })
    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      2
    )
  })

  it("does not count a wake-up message as the person's message", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    saveJob(harness, createJobFixture(mainId, 1, "completed"))
    harness.saveUserMessage({
      id: createFixtureUuidV7(300),
      conversationId: mainId,
      content: "Reports from your jobs arrived.",
      createdAt: createFixtureTimestamp(40),
      origin: "wake-up"
    })
    saveJob(harness, {
      ...createJobFixture(mainId, 2, "streaming"),
      createdAtMinute: 41
    })

    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      2
    )
  })

  it("counts job messages only, not a wake-up message one of the jobs received", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    harness.saveUserMessage({
      id: createFixtureUuidV7(300),
      conversationId: job.id,
      content: "Reports from your jobs arrived.",
      createdAt: createFixtureTimestamp(40),
      origin: "wake-up"
    })

    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      1
    )
  })

  it("starts the count again only in the conversation the person wrote in", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    saveJob(harness, createJobFixture(mainId, 1, "completed"))
    saveJob(harness, createJobFixture(otherId, 2, "completed"))
    saveFollowUpMessage(harness, otherId, 300)

    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      1
    )
    expect(
      harness.jobReader.getJobMessageCountSincePersonMessage(otherId)
    ).toBe(0)
  })

  it("counts every job message of a conversation in which the person wrote no message", () => {
    const harness = createHarness()
    const mainId = createFixtureUuidV7(1)
    harness.saveConversation({
      id: mainId,
      title: null,
      agentCode: "caliginia",
      createdAt: createFixtureTimestamp(0)
    })
    saveJob(harness, createJobFixture(mainId, 1, "completed"))
    saveJob(harness, createJobFixture(mainId, 2, "streaming"))

    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      2
    )
  })

  it("counts only the job messages of the addressed conversation's jobs, and none for a job or an unknown conversation", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    saveJob(harness, createJobFixture(otherId, 2, "completed"))
    saveJob(harness, createJobFixture(otherId, 3, "completed"))

    expect(harness.jobReader.getJobMessageCountSincePersonMessage(mainId)).toBe(
      1
    )
    expect(harness.jobReader.getJobMessageCountSincePersonMessage(job.id)).toBe(
      0
    )
    expect(
      harness.jobReader.getJobMessageCountSincePersonMessage(UNKNOWN_ID)
    ).toBe(0)
  })
}

/**
 * Registers the provider-independent {@link JobReader} contract cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerJobReaderContractSuite(
  createHarness: DelegationRecordsHarnessFactory
): void {
  describe("JobReader contract", () => {
    describe("listJobs", () => {
      registerJobListCases(createHarness)
      registerJobStateCases(createHarness)
    })

    describe("findJob and findJobByNumber", () => {
      registerJobLookupCases(createHarness)
    })

    describe("getJobMessageCountSincePersonMessage", () => {
      registerJobMessageCountCases(createHarness)
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      harness.closeRecords()

      expect(() => harness.jobReader.listJobs(UNKNOWN_ID)).toThrow(
        "Database is closed"
      )
      expect(() => harness.jobReader.findJob(UNKNOWN_ID)).toThrow(
        "Database is closed"
      )
      expect(() => harness.jobReader.findJobByNumber(UNKNOWN_ID, 1)).toThrow(
        "Database is closed"
      )
      expect(() =>
        harness.jobReader.getJobMessageCountSincePersonMessage(UNKNOWN_ID)
      ).toThrow("Database is closed")
    })
  })
}

/**
 * Registers the {@link JobActivityReader.hasUndeliveredWakingReport} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerWakingReportCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it.each([
    ["result report waits", { kind: "result", content: "Wool." }, true],
    ["failed report waits", { kind: "failed", content: "It failed." }, true],
    ["note does not wait", { kind: "note", content: "Looking." }, false],
    ["stopped report does not wait", { kind: "stopped", content: "" }, false],
    [
      "interrupted report does not wait",
      { kind: "interrupted", content: "" },
      false
    ]
  ] as const)("says that an undelivered %s", (_label, report, isWaiting) => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    saveReport(harness, job, {
      ...report,
      sequence: 200,
      title: "Job 1",
      createdAt: createFixtureTimestamp(1, 3)
    })

    expect(harness.jobActivityReader.hasUndeliveredWakingReport(mainId)).toBe(
      isWaiting
    )
  })

  it("says that no report waits once it is delivered, or for a job or another conversation", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const otherJob = saveJob(harness, createJobFixture(otherId, 2, "failed"))
    const deliveringId = saveFollowUpMessage(harness, mainId, 300)
    saveReport(harness, job, {
      sequence: 200,
      kind: "result",
      title: "Job 1",
      content: "They eat wool.",
      createdAt: createFixtureTimestamp(1, 3),
      deliveredMessageId: deliveringId
    })
    saveReport(harness, otherJob, {
      sequence: 201,
      kind: "failed",
      title: "Job 2",
      content: "The agent's reply failed.",
      createdAt: createFixtureTimestamp(2, 3)
    })

    expect(harness.jobActivityReader.hasUndeliveredWakingReport(mainId)).toBe(
      false
    )
    expect(harness.jobActivityReader.hasUndeliveredWakingReport(job.id)).toBe(
      false
    )
    expect(harness.jobActivityReader.hasUndeliveredWakingReport(otherId)).toBe(
      true
    )
  })
}

/**
 * Registers the {@link JobActivityReader.hasStreamingReply} and
 * {@link JobActivityReader.listStreamingReplies} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerStreamingReplyCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("says a conversation has a streaming reply only while one of its own replies streams", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))

    expect(harness.jobActivityReader.hasStreamingReply(mainId)).toBe(false)
    expect(harness.jobActivityReader.hasStreamingReply(job.id)).toBe(true)
    expect(harness.jobActivityReader.hasStreamingReply(UNKNOWN_ID)).toBe(false)

    saveStreamingReply(harness, mainId, 300)
    expect(harness.jobActivityReader.hasStreamingReply(mainId)).toBe(true)
  })

  it("lists the conversation's own streaming reply, then those of its jobs in the order the jobs were created, not the replies, and none of another conversation", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const otherId = saveMainConversation(harness, 100)
    const newer = saveJob(harness, {
      ...createJobFixture(mainId, 1, "streaming"),
      createdAtMinute: 2
    })
    const older = saveJob(harness, {
      ...createJobFixture(mainId, 2, "interrupted"),
      createdAtMinute: 1
    })
    const olderReplyId = saveStreamingReply(harness, older.id, 310)
    saveJob(harness, createJobFixture(mainId, 3, "completed"))
    saveJob(harness, createJobFixture(otherId, 4, "streaming"))
    const ownReplyId = saveStreamingReply(harness, mainId, 300)

    expect(harness.jobActivityReader.listStreamingReplies(mainId)).toEqual([
      { conversationId: mainId, assistantMessageId: ownReplyId },
      { conversationId: older.id, assistantMessageId: olderReplyId },
      { conversationId: newer.id, assistantMessageId: newer.replyId }
    ])
  })

  it("lists the conversation's own streaming reply first, also when a job sorts before the conversation by creation time and identity", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 500)
    const job = saveJob(harness, {
      ...createJobFixture(mainId, 1, "streaming"),
      createdAtMinute: 0
    })
    const ownReplyId = saveStreamingReply(harness, mainId, 300)

    expect(harness.jobActivityReader.listStreamingReplies(mainId)).toEqual([
      { conversationId: mainId, assistantMessageId: ownReplyId },
      { conversationId: job.id, assistantMessageId: job.replyId }
    ])
  })

  it("lists the streaming replies of the jobs below a job, and none of its parent", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))
    const jobOfJob = saveJob(harness, createJobFixture(job.id, 2, "streaming"))
    saveStreamingReply(harness, mainId, 300)

    expect(harness.jobActivityReader.listStreamingReplies(job.id)).toEqual([
      { conversationId: job.id, assistantMessageId: job.replyId },
      { conversationId: jobOfJob.id, assistantMessageId: jobOfJob.replyId }
    ])
    expect(
      harness.jobActivityReader
        .listStreamingReplies(mainId)
        .map((reply) => reply.conversationId)
    ).toEqual([mainId, job.id, jobOfJob.id])
  })

  it("lists no reply for a conversation without a streaming reply or an unknown one", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    saveJob(harness, createJobFixture(mainId, 1, "interrupted"))

    expect(harness.jobActivityReader.listStreamingReplies(mainId)).toEqual([])
    expect(harness.jobActivityReader.listStreamingReplies(UNKNOWN_ID)).toEqual(
      []
    )
  })
}

/**
 * Registers the {@link JobActivityReader.findEndedReply} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerEndedReplyCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("reads an ended reply's status, finish reason, parent, and the text of its last round only", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const firstRoundText = createTextPart({
      sequence: 31,
      round: 0,
      content: "Let me look. "
    })
    const call = createToolCallPart(
      { sequence: 32, round: 0, toolName: "web_search", argumentText: "{}" },
      { status: "succeeded", result: "Tool output", sourceNumbers: [] }
    )
    const answer = createTextPart({ sequence: 33, round: 1, content: "Moths " })
    const afterthought = createReasoningPart(34, 1, "Afterthought")
    const ending = createTextPart({ sequence: 35, round: 1, content: "eat." })
    const job = saveJob(harness, {
      ...createJobFixture(mainId, 1, "completed"),
      replyParts: [firstRoundText, call, answer, afterthought, ending]
    })

    expect(harness.jobActivityReader.findEndedReply(job.replyId)).toEqual({
      conversationId: job.id,
      parentConversationId: mainId,
      status: "completed",
      finishReason: "stop",
      lastRoundText: "Moths eat."
    })
  })

  it("reads no text for a reply whose last round wrote none, and for a reply without parts", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const text = createTextPart({ sequence: 31, round: 0, content: "Look" })
    const call = createToolCallPart(
      { sequence: 32, round: 1, toolName: "web_search", argumentText: "{}" },
      { status: "interrupted" }
    )
    const cutOff = saveJob(harness, {
      ...createJobFixture(mainId, 1, "interrupted"),
      replyParts: [text, call]
    })
    const empty = saveJob(harness, createJobFixture(mainId, 2, "failed"))

    expect(
      harness.jobActivityReader.findEndedReply(cutOff.replyId)
    ).toMatchObject({ status: "interrupted", lastRoundText: "" })
    expect(harness.jobActivityReader.findEndedReply(empty.replyId)).toEqual({
      conversationId: empty.id,
      parentConversationId: mainId,
      status: "failed",
      finishReason: null,
      lastRoundText: ""
    })
  })

  it("reads a main conversation's reply without a parent, and a reply that still streams", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))

    expect(
      harness.jobActivityReader.findEndedReply(job.delegatorReplyId)
    ).toEqual({
      conversationId: mainId,
      parentConversationId: null,
      status: "completed",
      finishReason: "stop",
      lastRoundText: ""
    })
    expect(harness.jobActivityReader.findEndedReply(job.replyId)).toMatchObject(
      { status: "streaming", finishReason: null }
    )
  })

  it("finds nothing for an unknown reply id, a user message, or a part of a reply", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))

    expect(harness.jobActivityReader.findEndedReply(UNKNOWN_ID)).toBeUndefined()
    expect(
      harness.jobActivityReader.findEndedReply(job.messageId)
    ).toBeUndefined()
    expect(harness.jobActivityReader.findEndedReply(job.callId)).toBeUndefined()
  })
}

/**
 * Registers the provider-independent {@link JobActivityReader} contract
 * cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerJobActivityReaderContractSuite(
  createHarness: DelegationRecordsHarnessFactory
): void {
  describe("JobActivityReader contract", () => {
    describe("hasUndeliveredWakingReport", () => {
      registerWakingReportCases(createHarness)
    })

    describe("hasStreamingReply and listStreamingReplies", () => {
      registerStreamingReplyCases(createHarness)
    })

    describe("findEndedReply", () => {
      registerEndedReplyCases(createHarness)
    })

    it("rejects a stored reply or conversation whose identity violates the contract", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      harness.saveConversation({
        id: "not-a-uuid",
        title: null,
        agentCode: "caliginia",
        createdAt: createFixtureTimestamp(1)
      })
      const replyId = saveStreamingReply(harness, "not-a-uuid", 300)

      expect(() => harness.jobActivityReader.findEndedReply(replyId)).toThrow(
        z.ZodError
      )
      expect(() =>
        harness.jobActivityReader.listStreamingReplies("not-a-uuid")
      ).toThrow(z.ZodError)

      expect(harness.jobActivityReader.hasStreamingReply(mainId)).toBe(false)
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      harness.closeRecords()

      expect(() =>
        harness.jobActivityReader.hasUndeliveredWakingReport(UNKNOWN_ID)
      ).toThrow("Database is closed")
      expect(() =>
        harness.jobActivityReader.hasStreamingReply(UNKNOWN_ID)
      ).toThrow("Database is closed")
      expect(() =>
        harness.jobActivityReader.listStreamingReplies(UNKNOWN_ID)
      ).toThrow("Database is closed")
      expect(() =>
        harness.jobActivityReader.findEndedReply(UNKNOWN_ID)
      ).toThrow("Database is closed")
    })
  })
}

/**
 * Creates a result report for a stored job's reply, written at
 * {@link REPORTED_AT} under the title `Find what moths eat`.
 *
 * @param job - The job, whose reply the report belongs to.
 * @param sequence - Identity sequence of the report.
 * @returns A report the store accepts once for that reply.
 */
function createResultReport(
  job: StoredJobFixture,
  sequence: number
): NewEndReport {
  return {
    id: createFixtureUuidV7(sequence),
    jobId: job.id,
    replyId: job.replyId,
    kind: "result",
    title: "Find what moths eat",
    content: "They eat wool.",
    createdAt: REPORTED_AT
  }
}

/**
 * Creates a progress note for a stored job's reply, written at
 * {@link REPORTED_AT} under the title `Find what moths eat`.
 *
 * @param job - The job, whose reply the note belongs to.
 * @param sequence - Identity sequence of the note.
 * @returns A note the store accepts for that reply.
 */
function createProgressNote(
  job: StoredJobFixture,
  sequence: number
): NewProgressNote {
  return {
    id: createFixtureUuidV7(sequence),
    jobId: job.id,
    replyId: job.replyId,
    title: "Find what moths eat",
    content: "Reading about moths",
    createdAt: REPORTED_AT
  }
}

/**
 * Registers the {@link JobReportWriter.createEndReport} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerEndReportCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("stores an end report once per reply and answers false the second time", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const report = createResultReport(job, 200)
    const second: NewEndReport = {
      ...createResultReport(job, 201),
      kind: "stopped",
      content: ""
    }

    expect(harness.jobReportWriter.createEndReport(report)).toBe(true)
    expect(harness.jobReportWriter.createEndReport(second)).toBe(false)

    expect(harness.listJobReports()).toEqual([
      buildStoredReportRow(report, "result")
    ])
    expect(harness.jobActivityReader.hasUndeliveredWakingReport(mainId)).toBe(
      true
    )
  })

  it.each([
    ["a result without text", { kind: "result", content: "" }],
    [
      "a failed report",
      { kind: "failed", content: "The agent's reply failed." }
    ],
    ["a stopped report", { kind: "stopped", content: "" }],
    ["an interrupted report", { kind: "interrupted", content: "" }]
  ] as const)("stores %s as given", (_label, endReport) => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "interrupted"))
    const report: NewEndReport = {
      ...createResultReport(job, 200),
      ...endReport
    }

    expect(harness.jobReportWriter.createEndReport(report)).toBe(true)

    expect(harness.listJobReports()).toEqual([
      buildStoredReportRow(report, endReport.kind)
    ])
  })

  it("stores an end report for each reply of a job, and beside the reply's notes", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const note = saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Looking",
      createdAt: createFixtureTimestamp(1, 3)
    })
    const laterReplyId = saveStreamingReply(harness, job.id, 300)
    const first = createResultReport(job, 201)
    const later: NewEndReport = {
      ...createResultReport(job, 202),
      replyId: laterReplyId
    }

    expect(harness.jobReportWriter.createEndReport(first)).toBe(true)
    expect(harness.jobReportWriter.createEndReport(later)).toBe(true)

    expect(harness.listJobReports()).toEqual([
      note,
      buildStoredReportRow(first, "result"),
      buildStoredReportRow(later, "result")
    ])
  })

  it("answers false and stores nothing when the reply does not belong to the job", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const otherJob = saveJob(harness, createJobFixture(mainId, 2, "completed"))
    const report = createResultReport(job, 200)
    const refused: readonly NewEndReport[] = [
      { ...report, replyId: otherJob.replyId },
      { ...report, replyId: UNKNOWN_ID },
      { ...report, replyId: job.messageId },
      { ...report, jobId: UNKNOWN_ID },
      { ...report, jobId: mainId, replyId: job.delegatorReplyId }
    ]

    expect(
      refused.map((each) => harness.jobReportWriter.createEndReport(each))
    ).toEqual([false, false, false, false, false])

    expect(harness.listJobReports()).toEqual([])
  })

  it("refuses a report whose identity is already stored and keeps the stored one", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const otherJob = saveJob(harness, createJobFixture(mainId, 2, "completed"))
    const stored = createResultReport(job, 200)
    harness.jobReportWriter.createEndReport(stored)

    expect(() =>
      harness.jobReportWriter.createEndReport(createResultReport(otherJob, 200))
    ).toThrow()

    expect(harness.listJobReports()).toEqual([
      buildStoredReportRow(stored, "result")
    ])
  })
}

/**
 * Registers the {@link JobReportWriter.createProgressNote} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerProgressNoteCases(
  createHarness: DelegationRecordsHarnessFactory
): void {
  it("replaces the job's undelivered note and keeps a delivered one", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))
    const deliveringId = saveFollowUpMessage(harness, mainId, 300)
    const delivered = saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Delivered note",
      createdAt: createFixtureTimestamp(1, 3),
      deliveredMessageId: deliveringId
    })
    saveReport(harness, job, {
      sequence: 201,
      kind: "note",
      title: "Job 1",
      content: "Undelivered note",
      createdAt: createFixtureTimestamp(1, 4)
    })
    const note = createProgressNote(job, 202)

    expect(harness.jobReportWriter.createProgressNote(note)).toBe(true)

    expect(harness.listJobReports()).toEqual([
      delivered,
      buildStoredReportRow(note, "note")
    ])
  })

  it("replaces a note an earlier reply of the job sent, and keeps the job's undelivered end report and another job's undelivered note", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const otherJob = saveJob(harness, createJobFixture(mainId, 2, "streaming"))
    saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Note of the earlier reply",
      createdAt: createFixtureTimestamp(1, 3)
    })
    const result = saveReport(harness, job, {
      sequence: 201,
      kind: "result",
      title: "Job 1",
      content: "They eat wool.",
      createdAt: createFixtureTimestamp(1, 4)
    })
    const otherNote = saveReport(harness, otherJob, {
      sequence: 202,
      kind: "note",
      title: "Job 2",
      content: "Counting moths",
      createdAt: createFixtureTimestamp(2, 3)
    })
    const note: NewProgressNote = {
      ...createProgressNote(job, 203),
      replyId: saveStreamingReply(harness, job.id, 300)
    }

    expect(harness.jobReportWriter.createProgressNote(note)).toBe(true)

    expect(harness.listJobReports()).toEqual([
      result,
      otherNote,
      buildStoredReportRow(note, "note")
    ])
  })

  it("answers false, stores nothing, and keeps the job's undelivered note when the reply does not belong to the job", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))
    const otherJob = saveJob(harness, createJobFixture(mainId, 2, "streaming"))
    const kept = saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Undelivered note",
      createdAt: createFixtureTimestamp(1, 3)
    })
    const note = createProgressNote(job, 201)
    const refused: readonly NewProgressNote[] = [
      { ...note, replyId: otherJob.replyId },
      { ...note, replyId: UNKNOWN_ID },
      { ...note, replyId: job.messageId },
      { ...note, jobId: UNKNOWN_ID },
      { ...note, jobId: mainId, replyId: job.delegatorReplyId }
    ]

    expect(
      refused.map((each) => harness.jobReportWriter.createProgressNote(each))
    ).toEqual([false, false, false, false, false])

    expect(harness.listJobReports()).toEqual([kept])
  })

  it("refuses a note whose identity is already stored and keeps the job's undelivered note", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))
    const kept = saveReport(harness, job, {
      sequence: 200,
      kind: "note",
      title: "Job 1",
      content: "Undelivered note",
      createdAt: createFixtureTimestamp(1, 3)
    })

    expect(() =>
      harness.jobReportWriter.createProgressNote(createProgressNote(job, 200))
    ).toThrow()

    expect(harness.listJobReports()).toEqual([kept])
  })
}

/**
 * Registers the provider-independent {@link JobReportWriter} contract cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerJobReportWriterContractSuite(
  createHarness: DelegationRecordsHarnessFactory
): void {
  describe("JobReportWriter contract", () => {
    describe("createEndReport", () => {
      registerEndReportCases(createHarness)
    })

    describe("createProgressNote", () => {
      registerProgressNoteCases(createHarness)
    })

    it("stores a note and an end report without changing the job's activity time, and the job reads the note as its latest", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      const fixture = createJobFixture(mainId, 1, "completed")
      const job = saveJob(harness, fixture)
      const expectedJob: Job = {
        ...buildExpectedJob(job, fixture, "replied"),
        latestNote: "Reading about moths"
      }

      harness.jobReportWriter.createProgressNote(createProgressNote(job, 200))
      harness.jobReportWriter.createEndReport(createResultReport(job, 201))

      expect(harness.jobReader.listJobs(mainId)).toEqual([expectedJob])
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      const job = saveJob(harness, createJobFixture(mainId, 1, "streaming"))
      harness.closeRecords()

      expect(() =>
        harness.jobReportWriter.createEndReport(createResultReport(job, 200))
      ).toThrow("Database is closed")
      expect(() =>
        harness.jobReportWriter.createProgressNote(createProgressNote(job, 201))
      ).toThrow("Database is closed")
    })
  })
}
