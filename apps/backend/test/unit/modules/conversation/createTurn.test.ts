import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { ConversationSource } from "@lys/share"
import SourceCatalog from "../../../../src/modules/agent/sourceCatalog"
import { createConversationTurn } from "../../../../src/modules/conversation/createTurn"
import type {
  ConversationTurn,
  ConversationTurnTarget,
  CreateConversationTurnOptions
} from "../../../../src/modules/chat/persistence"
import { ConversationNotFoundError } from "../../../../src/utils/errors"
import { openSqliteConversationRecords } from "../../support/conversationDatabase"
import {
  createFixtureUuidV7,
  createNewConversationTarget,
  createNewJobTarget,
  createTextPart,
  createTurnUserMessage,
  formatMessageText
} from "../../support/conversationFixtures"
import {
  buildExpectedReport,
  createFixtureTimestamp,
  createJobFixture,
  listUserMessageReports,
  saveJob,
  saveJobCall,
  saveMainConversation,
  saveReport,
  type ConversationRecordsHarness,
  type JobReportFixture
} from "../../support/conversationRecordsContract"

/** Time of every turn a case creates. */
const NOW = "2026-03-04T05:06:07.890Z"

/** Existing conversation used by continuation cases. */
const EXISTING_CONVERSATION_ID = createFixtureUuidV7(1)

/** A result report the delivery cases store undelivered. */
const RESULT_REPORT: JobReportFixture = Object.freeze({
  sequence: 200,
  kind: "result",
  title: "Find what moths eat",
  content: "They eat wool.",
  createdAt: createFixtureTimestamp(30)
})

/** A page the source cases store for a parent conversation as its first. */
const MOTHS_PAGE: ConversationSource = Object.freeze({
  number: 1,
  url: "https://example.com/moths",
  title: "Moths"
})

/** Address of a page about what moths eat, which jobs read in the source cases. */
const DIET_URL = "https://example.com/moths/diet"

/** Address of a page about silk moths, which jobs read in the source cases. */
const SILK_URL = "https://example.com/moths/silk"

/**
 * Creates a turn at {@link NOW} inside a turn write, as the turn service does.
 *
 * @param records - Records under test.
 * @param options - Turn selection and content.
 * @returns The created turn after the transaction commits.
 */
function createCommittedTurn(
  records: ConversationRecordsHarness,
  options: CreateConversationTurnOptions
) {
  return records.turnRecordWriter.handleConversationTurnWriteRequest(
    (transaction, jobs) =>
      createConversationTurn({ turn: transaction, jobs }, options, NOW)
  )
}

/**
 * Creates a turn of the person in a stored conversation.
 *
 * @param records - Records under test.
 * @param conversationId - Stored conversation the person writes in.
 * @param content - What the person writes.
 * @returns The created turn after the transaction commits.
 */
function createPersonTurn(
  records: ConversationRecordsHarness,
  conversationId: string,
  content: string
): ConversationTurn {
  const conversation: ConversationTurnTarget = {
    kind: "existing",
    id: conversationId
  }
  return createCommittedTurn(records, {
    conversation,
    userMessage: createTurnUserMessage(content),
    model: "qwen/qwen3-8b"
  })
}

/**
 * Starts a job of the agent `researcher` from a stored conversation, as a
 * `delegate_work` call of that conversation's agent does.
 *
 * @param records - Records under test.
 * @param parentId - Stored conversation the job is started from.
 * @param sequence - Identity sequence of the reply that holds the call; the
 * next one identifies the call.
 * @returns The created turn of the job after the transaction commits.
 */
function createJobTurn(
  records: ConversationRecordsHarness,
  parentId: string,
  sequence: number
): ConversationTurn {
  const call = saveJobCall(records, {
    sequence,
    parentId,
    createdAt: createFixtureTimestamp(1)
  })
  return createCommittedTurn(records, {
    conversation: createNewJobTarget(parentId, call.callId),
    userMessage: createTurnUserMessage("Find out what moths eat."),
    model: "qwen/qwen3-8b"
  })
}

/**
 * Continues a stored job with a job message titled `Now look at
 * butterflies`, as a `delegate_work` call of its parent's agent does.
 *
 * @param records - Records under test.
 * @param parentId - Stored conversation whose agent sends the message.
 * @param jobId - Conversation the message names as the job to continue.
 * @returns The created turn of the job after the transaction commits.
 * @remarks The call has identity sequence 101, in a reply of the parent with
 * sequence 100.
 */
function createJobContinuationTurn(
  records: ConversationRecordsHarness,
  parentId: string,
  jobId: string
): ConversationTurn {
  const call = saveJobCall(records, {
    sequence: 100,
    parentId,
    createdAt: createFixtureTimestamp(30)
  })
  const conversation: ConversationTurnTarget = {
    kind: "existing-job",
    id: jobId,
    title: "Now look at butterflies",
    jobCallId: call.callId
  }
  return createCommittedTurn(records, {
    conversation,
    userMessage: createTurnUserMessage("Look at butterflies too."),
    model: "qwen/qwen3-8b"
  })
}

/**
 * Stores a titled conversation with one completed exchange before {@link NOW}.
 *
 * @param records - Records under test.
 */
function saveExistingConversation(records: ConversationRecordsHarness): void {
  records.saveConversation({
    id: EXISTING_CONVERSATION_ID,
    title: "Trip plan",
    agentCode: "stored-agent",
    createdAt: "2026-01-01T00:00:00.000Z"
  })
  records.saveUserMessage({
    id: createFixtureUuidV7(10),
    conversationId: EXISTING_CONVERSATION_ID,
    content: "Earlier question",
    createdAt: "2026-01-01T00:00:01.000Z"
  })
  records.saveAssistantMessage({
    id: createFixtureUuidV7(11),
    conversationId: EXISTING_CONVERSATION_ID,
    model: "qwen/qwen3-8b",
    parts: [
      createTextPart({
        sequence: 511,
        round: 0,
        content: "Earlier answer",
        times: {
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z"
        }
      })
    ],
    status: "completed",
    finishReason: "stop",
    createdAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z"
  })
}

describe("createConversationTurn", () => {
  it("creates an untitled conversation with the options agent at the turn time", () => {
    const records = openSqliteConversationRecords()

    const turn = createCommittedTurn(records, {
      conversation: createNewConversationTarget("options-agent"),
      userMessage: createTurnUserMessage("Hello"),
      model: "qwen/qwen3-8b"
    })

    expect(turn.isNewConversation).toBe(true)
    expect(turn.conversation).toEqual({
      id: expect.any(String),
      title: null,
      agentCode: "options-agent",
      parentConversationId: null,
      jobNumber: null,
      delegatorAgentCode: null,
      createdAt: NOW,
      updatedAt: NOW,
      messages: [],
      sources: [],
      jobs: []
    })
    expect(z.uuidv7().safeParse(turn.conversation.id).success).toBe(true)
    expect(
      records.recordReader.findConversation(turn.conversation.id)
    ).toMatchObject({ agentCode: "options-agent", createdAt: NOW })
  })

  it("appends a user message and a streaming reply without parts", () => {
    const records = openSqliteConversationRecords()

    const turn = createCommittedTurn(records, {
      conversation: createNewConversationTarget("lys"),
      userMessage: createTurnUserMessage("Hello"),
      model: "qwen/qwen3-8b"
    })

    expect(turn.userMessage).toEqual({
      id: expect.any(String),
      role: "user",
      content: "Hello",
      attachments: [],
      origin: "person",
      reports: [],
      createdAt: NOW
    })
    expect(turn.assistantMessage).toEqual({
      id: expect.any(String),
      role: "assistant",
      model: "qwen/qwen3-8b",
      parts: [],
      status: "streaming",
      finishReason: null,
      createdAt: NOW,
      updatedAt: NOW
    })
    expect(
      records.recordReader.findConversation(turn.conversation.id)?.messages
    ).toEqual([turn.userMessage, turn.assistantMessage])
  })

  it("continues an existing conversation with its stored agent and prior transcript", () => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)

    const turn = createCommittedTurn(records, {
      conversation: { kind: "existing", id: EXISTING_CONVERSATION_ID },
      userMessage: createTurnUserMessage("Next question"),
      model: "qwen/qwen3-8b"
    })

    expect(turn.isNewConversation).toBe(false)
    expect(turn.conversation).toMatchObject({
      id: EXISTING_CONVERSATION_ID,
      title: "Trip plan",
      agentCode: "stored-agent"
    })
    expect(turn.conversation.messages.map(formatMessageText)).toEqual([
      "Earlier question",
      "Earlier answer"
    ])
    expect(
      records.recordReader
        .findConversation(EXISTING_CONVERSATION_ID)
        ?.messages.map(formatMessageText)
    ).toEqual(["Earlier question", "Earlier answer", "Next question", ""])
  })

  it("interrupts a reply still streaming in the continued conversation and keeps its parts", () => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)
    records.saveAssistantMessage({
      id: createFixtureUuidV7(12),
      conversationId: EXISTING_CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      parts: [
        createTextPart({
          sequence: 512,
          round: 0,
          content: "Partial",
          times: {
            createdAt: "2026-01-01T00:00:04.000Z",
            updatedAt: "2026-01-01T00:00:04.000Z"
          }
        })
      ],
      status: "streaming",
      finishReason: null,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z"
    })

    const turn = createCommittedTurn(records, {
      conversation: { kind: "existing", id: EXISTING_CONVERSATION_ID },
      userMessage: createTurnUserMessage("Next question"),
      model: "qwen/qwen3-8b"
    })

    expect(turn.conversation.messages.at(-1)).toMatchObject({
      id: createFixtureUuidV7(12),
      parts: [{ kind: "text", content: "Partial" }],
      status: "interrupted",
      finishReason: null,
      updatedAt: NOW
    })
  })

  it("does not interrupt a streaming reply in another conversation", () => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)
    const otherConversationId = createFixtureUuidV7(2)
    records.saveConversation({
      id: otherConversationId,
      title: null,
      agentCode: "other-agent",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    records.saveAssistantMessage({
      id: createFixtureUuidV7(20),
      conversationId: otherConversationId,
      model: "qwen/qwen3-8b",
      parts: [
        createTextPart({
          sequence: 520,
          round: 0,
          content: "Other partial",
          times: {
            createdAt: "2026-01-01T00:00:05.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z"
          }
        })
      ],
      status: "streaming",
      finishReason: null,
      createdAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z"
    })

    createCommittedTurn(records, {
      conversation: { kind: "existing", id: EXISTING_CONVERSATION_ID },
      userMessage: createTurnUserMessage("Next question"),
      model: "qwen/qwen3-8b"
    })

    expect(
      records.recordReader.findConversation(otherConversationId)?.messages[0]
    ).toMatchObject({
      status: "streaming",
      parts: [{ kind: "text", content: "Other partial" }]
    })
  })

  it("rejects an absent conversation before appending messages", () => {
    const records = openSqliteConversationRecords()

    expect(() =>
      createCommittedTurn(records, {
        conversation: { kind: "existing", id: EXISTING_CONVERSATION_ID },
        userMessage: createTurnUserMessage("Hello"),
        model: "qwen/qwen3-8b"
      })
    ).toThrow(ConversationNotFoundError)

    expect(
      records.recordReader.listConversations({
        query: "",
        after: undefined,
        limit: 30
      }).storedCount
    ).toBe(0)
  })

  it.each([
    [
      "empty user content",
      { userMessage: createTurnUserMessage(""), model: "qwen/qwen3-8b" }
    ],
    [
      "an empty model",
      { userMessage: createTurnUserMessage("Hello"), model: "" }
    ]
  ])("rejects %s before any write", (_label, values) => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)
    records.saveAssistantMessage({
      id: createFixtureUuidV7(12),
      conversationId: EXISTING_CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      parts: [
        createTextPart({
          sequence: 512,
          round: 0,
          content: "Partial",
          times: {
            createdAt: "2026-01-01T00:00:04.000Z",
            updatedAt: "2026-01-01T00:00:04.000Z"
          }
        })
      ],
      status: "streaming",
      finishReason: null,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z"
    })
    const conversation: ConversationTurnTarget = {
      kind: "existing",
      id: EXISTING_CONVERSATION_ID
    }
    const options: CreateConversationTurnOptions = { conversation, ...values }

    const observed =
      records.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction, jobs) => {
          const turnRecords = { turn: transaction, jobs }
          expect(() =>
            createConversationTurn(turnRecords, options, NOW)
          ).toThrow(z.ZodError)
          return transaction.findConversation(EXISTING_CONVERSATION_ID)
        }
      )

    expect(observed?.messages).toHaveLength(3)
    expect(observed?.messages.at(-1)).toMatchObject({
      status: "streaming",
      updatedAt: "2026-01-01T00:00:04.000Z"
    })
  })

  it("creates a job with number 1 for its parent's first job and stores the instructions as a delegator's message with its call id", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)

    const turn = createJobTurn(records, mainId, 100)

    const expectedJob = {
      id: turn.conversation.id,
      number: 1,
      agentCode: "researcher",
      title: "Find what moths eat",
      state: "working",
      replyId: turn.assistantMessage.id,
      jobCallIds: [createFixtureUuidV7(101)]
    }
    expect(turn.isNewConversation).toBe(true)
    expect(turn.conversation).toMatchObject({
      title: "Find what moths eat",
      agentCode: "researcher",
      parentConversationId: mainId,
      jobNumber: 1,
      createdAt: NOW,
      messages: []
    })
    expect(turn.userMessage).toMatchObject({
      content: "Find out what moths eat.",
      origin: "delegator"
    })
    expect(
      records.recordReader.findConversation(turn.conversation.id)?.messages
    ).toEqual([turn.userMessage, turn.assistantMessage])
    expect(records.recordReader.findConversation(mainId)?.jobs).toMatchObject([
      expectedJob
    ])
  })

  it("numbers a parent's jobs 1, 2, 3 and starts again at 1 for another parent", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const otherId = saveMainConversation(records, 50)

    const turns = [
      createJobTurn(records, mainId, 100),
      createJobTurn(records, mainId, 110),
      createJobTurn(records, mainId, 120),
      createJobTurn(records, otherId, 130)
    ]

    expect(turns.map((turn) => turn.conversation.jobNumber)).toEqual([
      1, 2, 3, 1
    ])
    expect(
      records.recordReader
        .findConversation(mainId)
        ?.jobs.map((job) => job.number)
    ).toEqual([1, 2, 3])
  })

  it("numbers a new job one above the highest number its parent's jobs have", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    saveJob(records, createJobFixture(mainId, 3, "completed"))

    const turn = createJobTurn(records, mainId, 100)

    expect(turn.conversation.jobNumber).toBe(4)
  })

  it("gives a new job its parent's agent as delegatorAgentCode", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)

    const turn = createJobTurn(records, mainId, 100)

    expect(turn.conversation.delegatorAgentCode).toBe("caliginia")
    expect(
      records.recordReader.findConversation(turn.conversation.id)
        ?.delegatorAgentCode
    ).toBe("caliginia")
  })

  it("throws ConversationNotFoundError and stores nothing when a new job's parent is not stored", () => {
    /** A `delegate_work` call of the parent, which is not stored either. */
    const jobCallId = createFixtureUuidV7(12)

    const records = openSqliteConversationRecords()
    const conversation = createNewJobTarget(EXISTING_CONVERSATION_ID, jobCallId)

    expect(() =>
      createCommittedTurn(records, {
        conversation,
        userMessage: createTurnUserMessage("Find out what moths eat."),
        model: "qwen/qwen3-8b"
      })
    ).toThrow(ConversationNotFoundError)

    expect(
      records.recordReader.findConversation(conversation.id)
    ).toBeUndefined()
  })

  it("replaces the job's title when a job message continues it, and returns the conversation with the new title", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))

    const turn = createJobContinuationTurn(records, mainId, job.id)

    const expectedJob = {
      title: "Now look at butterflies",
      state: "working",
      replyId: turn.assistantMessage.id,
      jobCallIds: [job.callId, createFixtureUuidV7(101)]
    }
    expect(turn.isNewConversation).toBe(false)
    expect(turn.conversation).toMatchObject({
      id: job.id,
      title: "Now look at butterflies",
      jobNumber: 1
    })
    expect(turn.conversation.messages.map((message) => message.id)).toEqual([
      job.messageId,
      job.replyId
    ])
    expect(records.recordReader.findConversation(mainId)?.jobs).toMatchObject([
      expectedJob
    ])
  })

  it("interrupts a reply still streaming in the continued job", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "streaming"))

    const turn = createJobContinuationTurn(records, mainId, job.id)

    expect(turn.conversation.messages.at(-1)).toMatchObject({
      id: job.replyId,
      status: "interrupted",
      updatedAt: NOW
    })
  })

  it("refuses a job message that continues a main conversation and leaves it as it is, with its reply still streaming", () => {
    /** What a turn says when a job message continues a main conversation. */
    const jobMessageRefusal =
      "A job message is written by a delegator, and only into a job"

    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const otherId = saveMainConversation(records, 50)
    records.saveAssistantMessage({
      id: createFixtureUuidV7(52),
      conversationId: otherId,
      model: "qwen/qwen3-8b",
      parts: [],
      status: "streaming",
      finishReason: null,
      createdAt: createFixtureTimestamp(2),
      updatedAt: createFixtureTimestamp(2)
    })
    const before = records.recordReader.findConversation(otherId)

    expect(() => createJobContinuationTurn(records, mainId, otherId)).toThrow(
      jobMessageRefusal
    )

    expect(before?.messages.at(-1)).toMatchObject({ status: "streaming" })
    expect(records.recordReader.findConversation(otherId)).toEqual(before)
  })

  it("stores a wake-up message with origin wake-up", () => {
    const records = openSqliteConversationRecords()
    saveExistingConversation(records)
    const conversation: ConversationTurnTarget = {
      kind: "wake-up",
      id: EXISTING_CONVERSATION_ID
    }

    const turn = createCommittedTurn(records, {
      conversation,
      userMessage: createTurnUserMessage("Reports from your jobs arrived."),
      model: "qwen/qwen3-8b"
    })

    expect(turn.userMessage).toMatchObject({
      content: "Reports from your jobs arrived.",
      origin: "wake-up"
    })
    expect(
      records.recordReader
        .findConversation(EXISTING_CONVERSATION_ID)
        ?.messages.at(-2)
    ).toEqual(turn.userMessage)
  })

  it("delivers every undelivered report of the conversation's jobs with the turn's user message, oldest first", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const first = saveJob(records, createJobFixture(mainId, 1, "completed"))
    const second = saveJob(records, createJobFixture(mainId, 2, "failed"))
    const failure = saveReport(records, second, {
      sequence: 200,
      kind: "failed",
      title: "Find what butterflies eat",
      content: "The model stopped answering.",
      createdAt: createFixtureTimestamp(30, 5)
    })
    const note = saveReport(records, first, {
      sequence: 201,
      kind: "note",
      title: "Find what moths eat",
      content: "Looking",
      createdAt: createFixtureTimestamp(30, 3)
    })
    const result = saveReport(records, first, {
      ...RESULT_REPORT,
      sequence: 202,
      createdAt: createFixtureTimestamp(30, 4)
    })

    const turn = createPersonTurn(records, mainId, "Any news?")

    const delivered = [
      buildExpectedReport(note, 1),
      buildExpectedReport(result, 1),
      buildExpectedReport(failure, 2)
    ]
    expect(turn.userMessage.reports).toEqual(delivered)
    expect(listUserMessageReports(records, mainId).at(-1)).toEqual(delivered)
  })

  it.each([
    ["note", "Looking"],
    ["result", "They eat wool."],
    ["failed", "The page could not be read."],
    ["stopped", ""],
    ["interrupted", ""]
  ] as const)("delivers an undelivered %s report", (kind, content) => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "interrupted"))
    const row = saveReport(records, job, { ...RESULT_REPORT, kind, content })

    const turn = createPersonTurn(records, mainId, "Any news?")

    expect(turn.userMessage.reports).toEqual([buildExpectedReport(row, 1)])
  })

  it("delivers a report once: the next turn's user message carries none", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    const row = saveReport(records, job, RESULT_REPORT)

    const first = createPersonTurn(records, mainId, "Any news?")
    const second = createPersonTurn(records, mainId, "And now?")

    expect(first.userMessage.reports).toEqual([buildExpectedReport(row, 1)])
    expect(second.userMessage.reports).toEqual([])
    expect(listUserMessageReports(records, mainId)).toEqual([
      [],
      [buildExpectedReport(row, 1)],
      []
    ])
  })

  it("leaves the reports of another conversation's jobs undelivered", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const otherId = saveMainConversation(records, 50)
    const otherJob = saveJob(records, createJobFixture(otherId, 1, "completed"))
    const row = saveReport(records, otherJob, RESULT_REPORT)

    createPersonTurn(records, mainId, "Hello")
    const otherTurn = createPersonTurn(records, otherId, "Any news?")

    expect(listUserMessageReports(records, mainId)).toEqual([[], []])
    expect(otherTurn.userMessage.reports).toEqual([buildExpectedReport(row, 1)])
  })

  it("returns the delivered reports on the turn's user message and none for a conversation without jobs", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    saveReport(records, job, RESULT_REPORT)
    const otherId = saveMainConversation(records, 50)

    const turn = createPersonTurn(records, mainId, "Any news?")
    const otherTurn = createPersonTurn(records, otherId, "Hello")

    expect(turn.userMessage.reports).toHaveLength(1)
    expect(
      records.recordReader.findConversation(mainId)?.messages.at(-2)
    ).toEqual(turn.userMessage)
    expect(otherTurn.userMessage.reports).toEqual([])
  })

  it("gives a delivered report the parent's number for a source the parent already has, by URL", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    const dietPage = { number: 2, url: DIET_URL, title: "Moth diet" }
    records.saveSource(mainId, MOTHS_PAGE)
    records.saveSource(mainId, dietPage)
    records.saveSource(job.id, { number: 1, url: DIET_URL, title: "Diet" })
    const row = saveReport(records, job, {
      ...RESULT_REPORT,
      content: "They eat wool [1]."
    })

    const turn = createPersonTurn(records, mainId, "Any news?")

    const delivered = buildExpectedReport(
      { ...row, content: "They eat wool [2].", sourceNumbers: [2] },
      1
    )
    expect(turn.userMessage.reports).toEqual([delivered])
    expect(records.recordReader.findConversation(mainId)?.sources).toEqual([
      MOTHS_PAGE,
      dietPage
    ])
  })

  it("adds a source the parent lacks under the parent's next number, with the job's title for it", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    const silkPage = { number: 3, url: SILK_URL, title: "Silk moths" }
    records.saveSource(mainId, MOTHS_PAGE)
    records.saveSource(mainId, silkPage)
    records.saveSource(job.id, { number: 1, url: DIET_URL, title: "Diet" })
    saveReport(records, job, {
      ...RESULT_REPORT,
      content: "They eat wool [1]."
    })

    const turn = createPersonTurn(records, mainId, "Any news?")

    expect(records.recordReader.findConversation(mainId)?.sources).toEqual([
      MOTHS_PAGE,
      silkPage,
      { number: 4, url: DIET_URL, title: "Diet" }
    ])
    expect(turn.userMessage.reports).toMatchObject([
      { content: "They eat wool [4].", sourceNumbers: [4] }
    ])
  })

  it("rewrites the report's markers and stores the parent's numbers as its sourceNumbers", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    records.saveSource(mainId, { number: 1, url: DIET_URL, title: "Diet" })
    records.saveSource(mainId, { ...MOTHS_PAGE, number: 2 })
    records.saveSource(job.id, { number: 1, url: SILK_URL, title: "Silk" })
    records.saveSource(job.id, { number: 2, url: DIET_URL, title: "Food" })
    const row = saveReport(records, job, {
      ...RESULT_REPORT,
      content: "Wool [2], silk [1], and wool again [2]."
    })

    const turn = createPersonTurn(records, mainId, "Any news?")

    const delivered = buildExpectedReport(
      {
        ...row,
        content: "Wool [1], silk [3], and wool again [1].",
        sourceNumbers: [1, 3]
      },
      1
    )
    expect(listUserMessageReports(records, mainId).at(-1)).toEqual([delivered])
    expect(turn.userMessage.reports).toEqual([delivered])
  })

  it("numbers the sources of two reports that cite the same page once", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const first = saveJob(records, createJobFixture(mainId, 1, "completed"))
    const second = saveJob(records, createJobFixture(mainId, 2, "completed"))
    records.saveSource(first.id, { number: 1, url: DIET_URL, title: "Diet" })
    records.saveSource(second.id, { number: 1, url: SILK_URL, title: "Silk" })
    records.saveSource(second.id, { number: 2, url: DIET_URL, title: "Food" })
    saveReport(records, first, { ...RESULT_REPORT, content: "Wool [1]." })
    saveReport(records, second, {
      ...RESULT_REPORT,
      sequence: 201,
      content: "Mulberry leaves [1], or wool [2].",
      createdAt: createFixtureTimestamp(30, 1)
    })

    const turn = createPersonTurn(records, mainId, "Any news?")

    expect(turn.userMessage.reports).toMatchObject([
      { content: "Wool [1].", sourceNumbers: [1] },
      { content: "Mulberry leaves [2], or wool [1].", sourceNumbers: [1, 2] }
    ])
    expect(records.recordReader.findConversation(mainId)?.sources).toEqual([
      { number: 1, url: DIET_URL, title: "Diet" },
      { number: 2, url: SILK_URL, title: "Silk" }
    ])
  })

  it("leaves a marker whose number is not a source of the job as it is", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    records.saveSource(mainId, MOTHS_PAGE)
    records.saveSource(job.id, { number: 1, url: DIET_URL, title: "Diet" })
    saveReport(records, job, {
      ...RESULT_REPORT,
      content: "They eat wool [1], not steel [5]."
    })

    const turn = createPersonTurn(records, mainId, "Any news?")

    expect(turn.userMessage.reports).toMatchObject([
      { content: "They eat wool [2], not steel [5].", sourceNumbers: [2] }
    ])
  })

  it("returns the turn with the added sources, so the next web source gets the number after them", () => {
    const records = openSqliteConversationRecords()
    const mainId = saveMainConversation(records, 1)
    const job = saveJob(records, createJobFixture(mainId, 1, "completed"))
    records.saveSource(mainId, MOTHS_PAGE)
    records.saveSource(job.id, { number: 1, url: DIET_URL, title: "Diet" })
    saveReport(records, job, {
      ...RESULT_REPORT,
      content: "They eat wool [1]."
    })

    const turn = createPersonTurn(records, mainId, "Any news?")
    const catalog = new SourceCatalog(turn.conversation.sources)
    const webSources = catalog.addWebSources([{ url: SILK_URL, title: "Silk" }])

    expect(turn.conversation.sources).toEqual([
      MOTHS_PAGE,
      { number: 2, url: DIET_URL, title: "Diet" }
    ])
    expect(webSources).toEqual([{ number: 3, url: SILK_URL, title: "Silk" }])
  })
})
