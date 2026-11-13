import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { ConversationSource, JobReport } from "@lys/share"
import type {
  JobReportDelivery,
  JobTurnTransaction
} from "../../../src/modules/conversation/records"
import { createFixtureUuidV7 } from "./conversationFixtures"
import {
  buildExpectedJob,
  buildExpectedReport,
  createFixtureTimestamp,
  createJobFixture,
  listUserMessageReports,
  saveFollowUpMessage,
  saveJob,
  saveMainConversation,
  saveReport,
  type ConversationRecordsHarness,
  type JobFixture,
  type JobReportRowFixture,
  type StoredJobFixture
} from "./conversationRecordsContract"
import { getThrownFailure } from "./databaseTransactionsContract"

/**
 * Turn persistence and reads over one empty store, with the controls a case
 * needs.
 */
export type JobTurnTransactionHarness = Pick<
  ConversationRecordsHarness,
  | "recordReader"
  | "turnRecordWriter"
  | "saveConversation"
  | "saveUserMessage"
  | "saveAssistantMessage"
  | "saveSource"
  | "saveJobReport"
  | "closeRecords"
>

/**
 * Creates the records over one empty store owned by the current test, which
 * closes the store when it finishes.
 */
export type JobTurnTransactionHarnessFactory = () => JobTurnTransactionHarness

/** Identity no case stores. */
const UNKNOWN_ID = createFixtureUuidV7(999)

/** Source the source cases store before their write. */
const STORED_SOURCE: ConversationSource = Object.freeze({
  number: 1,
  url: "https://example.com/moths",
  title: "Moths"
})

/** Source a write stores after {@link STORED_SOURCE}. */
const NEW_SOURCE: ConversationSource = Object.freeze({
  number: 2,
  url: "https://example.com/moths/diet",
  title: "What moths eat"
})

/** What a case stores to have one report waiting for its delegator. */
type WaitingReportFixture = Readonly<{
  /** The delegator's main conversation, which Caliginia answers. */
  mainId: string
  /** Values its job, number 1, was stored with; its reply completed. */
  jobFixture: JobFixture
  /** Identities of that job. */
  job: StoredJobFixture
  /** The job's undelivered result report, as it is stored. */
  row: JobReportRowFixture
  /**
   * A later message of the person in the main conversation, which can
   * deliver the report.
   */
  messageId: string
  /**
   * Delivery of the report with that message, its text unchanged and
   * without sources.
   */
  delivery: JobReportDelivery
}>

/**
 * Stores a main conversation, its job number 1 with one undelivered result
 * report, and a later message of the person.
 *
 * @param harness - Store under test.
 * @returns What was stored, and the delivery of the report with the message.
 * @remarks The report has identity sequence 200 and the message 300.
 */
function saveWaitingReport(
  harness: JobTurnTransactionHarness
): WaitingReportFixture {
  const mainId = saveMainConversation(harness, 1)
  const jobFixture = createJobFixture(mainId, 1, "completed")
  const job = saveJob(harness, jobFixture)
  const row = saveReport(harness, job, {
    sequence: 200,
    kind: "result",
    title: "Find what moths eat",
    content: "They eat wool [1].",
    createdAt: createFixtureTimestamp(30)
  })
  const messageId = saveFollowUpMessage(harness, mainId, 300)
  const delivery: JobReportDelivery = {
    reportId: row.id,
    messageId,
    content: row.content,
    sourceNumbers: []
  }
  return { mainId, jobFixture, job, row, messageId, delivery }
}

/**
 * Lists the undelivered reports of a conversation's jobs in a turn write of
 * its own.
 *
 * @param harness - Store under test.
 * @param parentConversationId - Conversation whose jobs' reports are listed.
 * @returns What {@link JobTurnTransaction.listUndeliveredJobReports} returns.
 */
function listUndeliveredReports(
  harness: JobTurnTransactionHarness,
  parentConversationId: string
): readonly JobReport[] {
  return harness.turnRecordWriter.handleConversationTurnWriteRequest(
    (_transaction, jobs) => jobs.listUndeliveredJobReports(parentConversationId)
  )
}

/**
 * Stores one source of a conversation in a turn write of its own.
 *
 * @param harness - Store under test.
 * @param conversationId - Conversation the source is stored for.
 * @param source - The source to store.
 * @throws What {@link JobTurnTransaction.createConversationSource} throws.
 */
function createSourceInTurnWrite(
  harness: JobTurnTransactionHarness,
  conversationId: string,
  source: ConversationSource
): void {
  harness.turnRecordWriter.handleConversationTurnWriteRequest(
    (_transaction, jobs) => {
      jobs.createConversationSource(conversationId, source)
    }
  )
}

/**
 * Gets the job records lent to a turn write that has ended.
 *
 * @param harness - Store under test.
 * @returns The records, whose write has committed by the time they are
 * returned.
 */
function getEndedJobTurnTransaction(
  harness: JobTurnTransactionHarness
): JobTurnTransaction {
  return harness.turnRecordWriter.handleConversationTurnWriteRequest(
    (_transaction, jobs) => jobs
  )
}

/**
 * Registers the {@link JobTurnTransaction.updateJobTitle} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerJobTitleCases(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  it("replaces a job's title and changes nothing else of the job", () => {
    const harness = createHarness()
    const { job } = saveWaitingReport(harness)
    const jobBefore = harness.recordReader.findConversation(job.id)

    harness.turnRecordWriter.handleConversationTurnWriteRequest(
      (_transaction, jobs) => {
        jobs.updateJobTitle(job.id, "Now look at butterflies")
      }
    )

    expect(jobBefore?.title).toBe("Job 1")
    expect(harness.recordReader.findConversation(job.id)).toEqual({
      ...jobBefore,
      title: "Now look at butterflies"
    })
  })

  it("changes nothing for a main conversation and for an identity that is not stored", () => {
    const harness = createHarness()
    const { mainId } = saveWaitingReport(harness)

    harness.turnRecordWriter.handleConversationTurnWriteRequest(
      (_transaction, jobs) => {
        jobs.updateJobTitle(mainId, "Not a job")
        jobs.updateJobTitle(UNKNOWN_ID, "Not stored")
      }
    )

    expect(harness.recordReader.findConversation(mainId)?.title).toBeNull()
    expect(harness.recordReader.findConversation(UNKNOWN_ID)).toBeUndefined()
  })

  it("refuses an empty title and keeps the stored one", () => {
    const harness = createHarness()
    const { job } = saveWaitingReport(harness)

    expect(() =>
      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.updateJobTitle(job.id, "")
        }
      )
    ).toThrow()

    expect(harness.recordReader.findConversation(job.id)?.title).toBe("Job 1")
  })
}

/**
 * Registers the {@link JobTurnTransaction.listUndeliveredJobReports} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerUndeliveredReportListCases(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  it("lists the undelivered reports of a conversation's jobs oldest first and then by identity, each with its job's number and agent and its own title", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    const first = saveJob(harness, createJobFixture(mainId, 1, "completed"))
    const second = saveJob(harness, createJobFixture(mainId, 2, "failed"))
    const failure = saveReport(harness, second, {
      sequence: 201,
      kind: "failed",
      title: "Find what butterflies eat",
      content: "The model stopped answering.",
      createdAt: createFixtureTimestamp(30, 5)
    })
    const result = saveReport(harness, first, {
      sequence: 200,
      kind: "result",
      title: "Find what moths eat",
      content: "They eat wool.",
      createdAt: createFixtureTimestamp(30, 5)
    })
    const note = saveReport(harness, first, {
      sequence: 202,
      kind: "note",
      title: "Find what moths eat",
      content: "Looking",
      createdAt: createFixtureTimestamp(30, 4)
    })

    expect(listUndeliveredReports(harness, mainId)).toEqual([
      buildExpectedReport(note, 1),
      buildExpectedReport(result, 1),
      buildExpectedReport(failure, 2)
    ])
  })

  it.each(["note", "result", "failed", "stopped", "interrupted"] as const)(
    "lists an undelivered %s report",
    (kind) => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      const job = saveJob(harness, createJobFixture(mainId, 1, "interrupted"))
      const row = saveReport(harness, job, {
        sequence: 200,
        kind,
        title: "Find what moths eat",
        content: "Report text",
        createdAt: createFixtureTimestamp(30)
      })

      expect(listUndeliveredReports(harness, mainId)).toEqual([
        buildExpectedReport(row, 1)
      ])
    }
  )

  it("lists no delivered report and no report of another conversation's jobs", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    saveReport(harness, waiting.job, {
      sequence: 201,
      kind: "note",
      title: "Find what moths eat",
      content: "Looking",
      createdAt: createFixtureTimestamp(30, 1),
      deliveredMessageId: waiting.messageId
    })
    const otherId = saveMainConversation(harness, 100)
    const otherJob = saveJob(harness, createJobFixture(otherId, 2, "completed"))
    const otherRow = saveReport(harness, otherJob, {
      sequence: 202,
      kind: "result",
      title: "Find what butterflies eat",
      content: "They drink nectar.",
      createdAt: createFixtureTimestamp(30, 2)
    })

    expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
      buildExpectedReport(waiting.row, 1)
    ])
    expect(listUndeliveredReports(harness, otherId)).toEqual([
      buildExpectedReport(otherRow, 2)
    ])
  })

  it("lists no report for a job itself, a conversation without jobs, or an identity that is not stored", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const otherId = saveMainConversation(harness, 100)

    expect(listUndeliveredReports(harness, waiting.job.id)).toEqual([])
    expect(listUndeliveredReports(harness, otherId)).toEqual([])
    expect(listUndeliveredReports(harness, UNKNOWN_ID)).toEqual([])
  })

  it("rejects an undelivered report that violates the report contract", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    harness.saveJobReport({ ...waiting.row, id: "not-a-uuid", kind: "note" })

    expect(() => listUndeliveredReports(harness, waiting.mainId)).toThrow(
      z.ZodError
    )
  })
}

/**
 * Registers the {@link JobTurnTransaction.updateJobReportToDelivered} cases
 * that deliver a report.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerReportDeliveryCases(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  it("marks a report delivered with the message, its text, and its source numbers, so the message reads it back", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const delivery: JobReportDelivery = {
      ...waiting.delivery,
      content: "They eat wool [3].",
      sourceNumbers: [3, 5]
    }
    const delivered: JobReport = {
      ...buildExpectedReport(waiting.row, 1),
      content: "They eat wool [3].",
      sourceNumbers: [3, 5]
    }

    const remaining =
      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.updateJobReportToDelivered(delivery)
          return jobs.listUndeliveredJobReports(waiting.mainId)
        }
      )

    expect(remaining).toEqual([])
    expect(listUserMessageReports(harness, waiting.mainId)).toEqual([
      [],
      [delivered]
    ])
  })

  it("keeps the job as it is and the activity time of its parent when a report is delivered", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const parentBefore = harness.recordReader.findConversation(waiting.mainId)

    harness.turnRecordWriter.handleConversationTurnWriteRequest(
      (_transaction, jobs) => {
        jobs.updateJobReportToDelivered(waiting.delivery)
      }
    )

    const parent = harness.recordReader.findConversation(waiting.mainId)
    expect(parent?.jobs).toEqual([
      buildExpectedJob(waiting.job, waiting.jobFixture, "replied")
    ])
    expect(parent?.updatedAt).toBe(parentBefore?.updatedAt)
  })

  it.each(["result", "stopped", "interrupted"] as const)(
    "delivers a %s report whose text is empty",
    (kind) => {
      const harness = createHarness()
      const waiting = saveWaitingReport(harness)
      const fixture = createJobFixture(waiting.mainId, 2, "interrupted")
      const row = saveReport(harness, saveJob(harness, fixture), {
        sequence: 201,
        kind,
        title: "Find what butterflies eat",
        content: "",
        createdAt: createFixtureTimestamp(30, 1)
      })
      const delivery = { ...waiting.delivery, reportId: row.id, content: "" }

      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.updateJobReportToDelivered(delivery)
        }
      )

      expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
        buildExpectedReport(waiting.row, 1)
      ])
      expect(listUserMessageReports(harness, waiting.mainId).at(-1)).toEqual([
        buildExpectedReport(row, 2)
      ])
    }
  )
}

/**
 * Registers the {@link JobTurnTransaction.updateJobReportToDelivered} cases
 * that refuse a delivery.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerReportDeliveryRefusalCases(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  it("delivers a report once: a second delivery is refused and the first one is kept", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const secondMessageId = saveFollowUpMessage(harness, waiting.mainId, 301)
    const second: JobReportDelivery = {
      ...waiting.delivery,
      messageId: secondMessageId,
      content: "Changed"
    }
    harness.turnRecordWriter.handleConversationTurnWriteRequest(
      (_transaction, jobs) => {
        jobs.updateJobReportToDelivered(waiting.delivery)
      }
    )

    expect(() =>
      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.updateJobReportToDelivered(second)
        }
      )
    ).toThrow("Job report is not waiting for delivery")

    expect(listUserMessageReports(harness, waiting.mainId)).toEqual([
      [],
      [buildExpectedReport(waiting.row, 1)],
      []
    ])
  })

  it("refuses a report that is not stored", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const delivery = { ...waiting.delivery, reportId: UNKNOWN_ID }

    expect(() =>
      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.updateJobReportToDelivered(delivery)
        }
      )
    ).toThrow("Job report is not waiting for delivery")

    expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
      buildExpectedReport(waiting.row, 1)
    ])
  })

  it("refuses a delivering message that is not stored and keeps the report undelivered", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const delivery = { ...waiting.delivery, messageId: UNKNOWN_ID }

    expect(() =>
      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (_transaction, jobs) => {
          jobs.updateJobReportToDelivered(delivery)
        }
      )
    ).toThrow()

    expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
      buildExpectedReport(waiting.row, 1)
    ])
  })

  it.each(["note", "failed"] as const)(
    "refuses an empty text for a %s report and keeps the report as it is",
    (kind) => {
      const harness = createHarness()
      const waiting = saveWaitingReport(harness)
      const fixture = createJobFixture(waiting.mainId, 2, "failed")
      const row = saveReport(harness, saveJob(harness, fixture), {
        sequence: 201,
        kind,
        title: "Find what butterflies eat",
        content: "The model stopped answering.",
        createdAt: createFixtureTimestamp(30, 1)
      })
      const delivery = { ...waiting.delivery, reportId: row.id, content: "" }

      expect(() =>
        harness.turnRecordWriter.handleConversationTurnWriteRequest(
          (_transaction, jobs) => {
            jobs.updateJobReportToDelivered(delivery)
          }
        )
      ).toThrow()

      expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
        buildExpectedReport(waiting.row, 1),
        buildExpectedReport(row, 2)
      ])
    }
  )
}

/**
 * Registers the {@link JobTurnTransaction.createConversationSource} cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerConversationSourceCases(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  it("stores a source of a conversation, which the conversation then reads back", () => {
    const harness = createHarness()
    const mainId = saveMainConversation(harness, 1)
    harness.saveSource(mainId, STORED_SOURCE)
    const before = harness.recordReader.findConversation(mainId)

    createSourceInTurnWrite(harness, mainId, NEW_SOURCE)

    expect(harness.recordReader.findConversation(mainId)).toEqual({
      ...before,
      sources: [STORED_SOURCE, NEW_SOURCE]
    })
  })

  it.each([
    [
      "whose number the conversation stores for another URL",
      { ...NEW_SOURCE, number: STORED_SOURCE.number }
    ],
    [
      "whose URL the conversation stores under another number",
      { ...NEW_SOURCE, url: STORED_SOURCE.url }
    ]
  ] as const)(
    "refuses a source %s and keeps the conversation's sources as they are",
    (_label, source) => {
      const harness = createHarness()
      const mainId = saveMainConversation(harness, 1)
      harness.saveSource(mainId, STORED_SOURCE)

      expect(() => createSourceInTurnWrite(harness, mainId, source)).toThrow()

      expect(harness.recordReader.findConversation(mainId)?.sources).toEqual([
        STORED_SOURCE
      ])
    }
  )

  it("refuses a source of a conversation that is not stored", () => {
    const harness = createHarness()

    expect(() =>
      createSourceInTurnWrite(harness, UNKNOWN_ID, NEW_SOURCE)
    ).toThrow()
  })
}

/**
 * Registers the cases about how long the job records lent to a turn write
 * are valid, and about what a failed write leaves.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
function registerJobTurnLifetimeCases(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  it("rolls every change back when the turn's operation throws", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const failure = new Error("Turn rejected")

    expect(
      getThrownFailure(() =>
        harness.turnRecordWriter.handleConversationTurnWriteRequest(
          (_transaction, jobs) => {
            jobs.updateJobTitle(waiting.job.id, "Now look at butterflies")
            jobs.createConversationSource(waiting.mainId, NEW_SOURCE)
            jobs.updateJobReportToDelivered(waiting.delivery)
            throw failure
          }
        )
      )
    ).toBe(failure)

    expect(harness.recordReader.findConversation(waiting.job.id)?.title).toBe(
      "Job 1"
    )
    expect(
      harness.recordReader.findConversation(waiting.mainId)?.sources
    ).toEqual([])
    expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
      buildExpectedReport(waiting.row, 1)
    ])
  })

  it("refuses every call on job records kept after their operation returned, and changes nothing", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const jobs = getEndedJobTurnTransaction(harness)

    expect(() => jobs.updateJobTitle(waiting.job.id, "Late")).toThrow(
      "Database operation has ended"
    )
    expect(() => jobs.listUndeliveredJobReports(waiting.mainId)).toThrow(
      "Database operation has ended"
    )
    expect(() =>
      jobs.createConversationSource(waiting.mainId, NEW_SOURCE)
    ).toThrow("Database operation has ended")
    expect(() => jobs.updateJobReportToDelivered(waiting.delivery)).toThrow(
      "Database operation has ended"
    )

    expect(harness.recordReader.findConversation(waiting.job.id)?.title).toBe(
      "Job 1"
    )
    expect(
      harness.recordReader.findConversation(waiting.mainId)?.sources
    ).toEqual([])
    expect(listUndeliveredReports(harness, waiting.mainId)).toEqual([
      buildExpectedReport(waiting.row, 1)
    ])
  })

  it("refuses every call on job records kept after the store closes", () => {
    const harness = createHarness()
    const waiting = saveWaitingReport(harness)
    const jobs = getEndedJobTurnTransaction(harness)
    harness.closeRecords()

    expect(() => jobs.updateJobTitle(waiting.job.id, "Late")).toThrow(
      "Database is closed"
    )
    expect(() => jobs.listUndeliveredJobReports(waiting.mainId)).toThrow(
      "Database is closed"
    )
    expect(() =>
      jobs.createConversationSource(waiting.mainId, NEW_SOURCE)
    ).toThrow("Database is closed")
    expect(() => jobs.updateJobReportToDelivered(waiting.delivery)).toThrow(
      "Database is closed"
    )
  })
}

/**
 * Registers the provider-independent {@link JobTurnTransaction} contract
 * cases, each run inside one turn write.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerJobTurnTransactionContractSuite(
  createHarness: JobTurnTransactionHarnessFactory
): void {
  describe("JobTurnTransaction contract", () => {
    describe("updateJobTitle", () => {
      registerJobTitleCases(createHarness)
    })

    describe("listUndeliveredJobReports", () => {
      registerUndeliveredReportListCases(createHarness)
    })

    describe("updateJobReportToDelivered", () => {
      registerReportDeliveryCases(createHarness)
      registerReportDeliveryRefusalCases(createHarness)
    })

    describe("createConversationSource", () => {
      registerConversationSourceCases(createHarness)
    })

    registerJobTurnLifetimeCases(createHarness)
  })
}
