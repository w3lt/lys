import { MAXIMUM_CONVERSATION_LIST_PAGE_SIZE } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type {
  ConversationRecordEditor,
  ConversationRecordReader,
  ConversationTurnRecordWriter,
  ConversationTurnTransaction,
  ListConversationsInput
} from "../../../src/modules/conversation/records"
import { createFixtureUuidV7 } from "./conversationFixtures"
import { getThrownFailure } from "./databaseTransactionsContract"

/** Stored conversation columns a harness writes exactly as given. */
export type ConversationRowFixture = Readonly<{
  /** Conversation identity. */
  id: string
  /** Stored title, or null while untitled. */
  title: string | null
  /** Stored agent code. */
  agentCode: string
  /** Creation time; also the initial activity time. */
  createdAt: string
}>

/** Stored user-message columns a harness writes exactly as given. */
export type UserMessageRowFixture = Readonly<{
  /** Message identity. */
  id: string
  /** Owning conversation identity. */
  conversationId: string
  /** Non-empty authored content. */
  content: string
  /**
   * Creation time; becomes the conversation's activity time when it is later
   * than the stored one.
   */
  createdAt: string
}>

/** Stored assistant-message columns a harness writes exactly as given. */
export type AssistantMessageRowFixture = Readonly<{
  /** Message identity. */
  id: string
  /** Owning conversation identity. */
  conversationId: string
  /** Generating model. */
  model: string
  /** Stored reply text. */
  content: string
  /** Stored lifecycle status. */
  status: "streaming" | "completed" | "interrupted" | "failed"
  /** Stored finish reason, non-null only for completed replies. */
  finishReason: "stop" | "length" | null
  /**
   * Creation time; becomes the conversation's activity time when it is later
   * than the stored one.
   */
  createdAt: string
  /** Last modification time. */
  updatedAt: string
}>

/** Records providers over one empty store, with the controls a case needs. */
export type ConversationRecordsHarness = Readonly<{
  /** Read snapshots of the store. */
  recordReader: ConversationRecordReader
  /** User edits of the store. */
  recordEditor: ConversationRecordEditor
  /** Turn persistence over the store. */
  turnRecordWriter: ConversationTurnRecordWriter
  /** Stores one conversation exactly as given, valid or not. */
  saveConversation: (row: ConversationRowFixture) => void
  /**
   * Stores one user message exactly as given. Messages are saved in time order
   * after the conversation's creation, so each one's time becomes the
   * conversation's activity time; an earlier time lets the store choose it.
   */
  saveUserMessage: (row: UserMessageRowFixture) => void
  /** Stores one assistant message exactly as given, in the same time order. */
  saveAssistantMessage: (row: AssistantMessageRowFixture) => void
  /** Closes the store as its owner does; a repeated call changes nothing. */
  closeRecords: () => void
}>

/**
 * Creates the records over one empty store owned by the current test, which
 * closes the store when it finishes.
 */
export type ConversationRecordsHarnessFactory = () => ConversationRecordsHarness

/** Conversation most cases store and address. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Second conversation, used to prove a change stays in its conversation. */
const OTHER_CONVERSATION_ID = createFixtureUuidV7(2)

/** Creation time of stored fixtures. */
const CREATED_AT = "2025-01-01T00:00:00.000Z"

/** Time a case passes as the moment of its change. */
const CHANGED_AT = "2026-03-04T05:06:07.890Z"

/** First page of every stored conversation at the default page size. */
const FIRST_PAGE: ListConversationsInput = {
  query: "",
  after: undefined,
  limit: 30
}

/** Values that distinguish one stored conversation in list cases. */
type ListedConversationFixture = Readonly<{
  /** Identity sequence of the conversation. */
  sequence: number
  /** Stored title. */
  title: string | null
  /** User message contents, stored one second apart after creation. */
  userMessages: readonly string[]
  /** Minute of 2025-01-01 at which the conversation was created. */
  createdAtMinute: number
}>

/**
 * Creates a fixture timestamp in the first hour of 2025-01-01.
 *
 * @param minute - Minute offset from midnight.
 * @param second - Second offset within the minute.
 * @returns An ISO timestamp with millisecond precision.
 */
function createFixtureTimestamp(minute: number, second = 0): string {
  return new Date(Date.UTC(2025, 0, 1, 0, minute, second)).toISOString()
}

/**
 * Stores one conversation whose activity time is its last message time.
 *
 * @param harness - Store under test.
 * @param fixture - Conversation values.
 * @returns The stored conversation identity.
 */
function saveListedConversation(
  harness: ConversationRecordsHarness,
  fixture: ListedConversationFixture
): string {
  const id = createFixtureUuidV7(fixture.sequence)
  harness.saveConversation({
    id,
    title: fixture.title,
    agentCode: "stored-agent",
    createdAt: createFixtureTimestamp(fixture.createdAtMinute)
  })
  fixture.userMessages.forEach((content, index) => {
    harness.saveUserMessage({
      id: createFixtureUuidV7(fixture.sequence * 100 + index),
      conversationId: id,
      content,
      createdAt: createFixtureTimestamp(fixture.createdAtMinute, index + 1)
    })
  })
  return id
}

/**
 * Stores a conversation whose only message is an assistant reply.
 *
 * @param harness - Store under test.
 * @param conversationId - Identity of the conversation.
 * @param reply - Identity sequence, text, and state of the reply.
 */
function saveConversationWithReply(
  harness: ConversationRecordsHarness,
  conversationId: string,
  reply: Pick<
    AssistantMessageRowFixture,
    "content" | "status" | "finishReason"
  > & { sequence: number }
): void {
  harness.saveConversation({
    id: conversationId,
    title: null,
    agentCode: "stored-agent",
    createdAt: CREATED_AT
  })
  harness.saveAssistantMessage({
    id: createFixtureUuidV7(reply.sequence),
    conversationId,
    model: "qwen/qwen3-8b",
    content: reply.content,
    status: reply.status,
    finishReason: reply.finishReason,
    createdAt: "2025-01-01T00:00:01.000Z",
    updatedAt: "2025-01-01T00:00:01.000Z"
  })
}

/**
 * Creates the metadata of a new, untitled conversation.
 *
 * @param id - Conversation identity.
 * @returns Valid metadata created at {@link CHANGED_AT}.
 */
function createNewConversationMetadata(id: string) {
  return {
    id,
    title: null,
    agentCode: "lys",
    createdAt: CHANGED_AT,
    updatedAt: CHANGED_AT
  }
}

/**
 * Reads the activity time of the conversation most cases address.
 *
 * @param harness - Store under test.
 * @returns The activity time of {@link CONVERSATION_ID} in epoch milliseconds.
 * @throws If that conversation is not stored.
 */
function getActivityTime(harness: ConversationRecordsHarness): number {
  const conversation = harness.recordReader.findConversation(CONVERSATION_ID)
  if (conversation === undefined)
    throw new Error("Expected the addressed conversation to be stored")
  return Date.parse(conversation.updatedAt)
}

/**
 * Registers the provider-independent {@link ConversationRecordReader}
 * contract cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerConversationRecordReaderContractSuite(
  createHarness: ConversationRecordsHarnessFactory
): void {
  describe("ConversationRecordReader contract", () => {
    describe("findConversation", () => {
      it("returns undefined for an absent conversation", () => {
        const { recordReader } = createHarness()

        expect(recordReader.findConversation(CONVERSATION_ID)).toBeUndefined()
      })

      it("returns the stored metadata with an empty transcript", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: "Trip plan",
          agentCode: "lys",
          createdAt: CREATED_AT
        })

        expect(harness.recordReader.findConversation(CONVERSATION_ID)).toEqual({
          id: CONVERSATION_ID,
          title: "Trip plan",
          agentCode: "lys",
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          messages: []
        })
      })

      it("projects each role's stored values into the message contract", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: null,
          agentCode: "lys",
          createdAt: CREATED_AT
        })
        harness.saveUserMessage({
          id: createFixtureUuidV7(10),
          conversationId: CONVERSATION_ID,
          content: "Hello",
          createdAt: "2025-01-01T00:00:01.000Z"
        })
        harness.saveAssistantMessage({
          id: createFixtureUuidV7(11),
          conversationId: CONVERSATION_ID,
          model: "qwen/qwen3-8b",
          content: "Hi there",
          status: "completed",
          finishReason: "stop",
          createdAt: "2025-01-01T00:00:02.000Z",
          updatedAt: "2025-01-01T00:00:03.000Z"
        })

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages
        ).toEqual([
          {
            id: createFixtureUuidV7(10),
            role: "user",
            content: "Hello",
            createdAt: "2025-01-01T00:00:01.000Z"
          },
          {
            id: createFixtureUuidV7(11),
            role: "assistant",
            model: "qwen/qwen3-8b",
            content: "Hi there",
            status: "completed",
            finishReason: "stop",
            createdAt: "2025-01-01T00:00:02.000Z",
            updatedAt: "2025-01-01T00:00:03.000Z"
          }
        ])
      })

      it("orders the transcript by creation time and then by identity", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: null,
          agentCode: "lys",
          createdAt: CREATED_AT
        })
        for (const [sequence, content, createdAt] of [
          [30, "later identity, same time", "2025-01-01T00:00:01.000Z"],
          [20, "earlier identity, same time", "2025-01-01T00:00:01.000Z"],
          [10, "latest time", "2025-01-01T00:00:02.000Z"]
        ] as const) {
          harness.saveUserMessage({
            id: createFixtureUuidV7(sequence),
            conversationId: CONVERSATION_ID,
            content,
            createdAt
          })
        }

        expect(
          harness.recordReader
            .findConversation(CONVERSATION_ID)
            ?.messages.map(({ content }) => content)
        ).toEqual([
          "earlier identity, same time",
          "later identity, same time",
          "latest time"
        ])
      })

      it("reads only the addressed conversation's messages", () => {
        const harness = createHarness()
        for (const id of [CONVERSATION_ID, OTHER_CONVERSATION_ID]) {
          harness.saveConversation({
            id,
            title: null,
            agentCode: "lys",
            createdAt: CREATED_AT
          })
        }
        harness.saveUserMessage({
          id: createFixtureUuidV7(10),
          conversationId: OTHER_CONVERSATION_ID,
          content: "Other",
          createdAt: "2025-01-01T00:00:01.000Z"
        })

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages
        ).toEqual([])
      })

      it("returns an independent snapshot", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: null,
          agentCode: "lys",
          createdAt: CREATED_AT
        })
        const first = harness.recordReader.findConversation(CONVERSATION_ID)
        first?.messages.push({
          id: createFixtureUuidV7(99),
          role: "user",
          content: "local only",
          createdAt: "2025-01-01T00:00:09.000Z"
        })

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages
        ).toEqual([])
      })

      it("rejects stored metadata that violates the conversation contract and stays usable", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: "",
          agentCode: "lys",
          createdAt: CREATED_AT
        })

        expect(() =>
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toThrow(z.ZodError)

        expect(harness.recordEditor.deleteConversation(CONVERSATION_ID)).toBe(
          true
        )
      })

      it("rejects a stored message that violates the message contract", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: null,
          agentCode: "lys",
          createdAt: CREATED_AT
        })
        harness.saveUserMessage({
          id: "not-a-uuid",
          conversationId: CONVERSATION_ID,
          content: "Hello",
          createdAt: "2025-01-01T00:00:01.000Z"
        })

        expect(() =>
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toThrow(z.ZodError)
      })
    })

    describe("listConversations", () => {
      it("returns an empty final page for an empty store", () => {
        const { recordReader } = createHarness()

        expect(recordReader.listConversations(FIRST_PAGE)).toEqual({
          conversations: [],
          storedCount: 0,
          matchCount: 0,
          hasMore: false
        })
      })

      it("orders conversations by latest activity and then by descending identity", () => {
        const harness = createHarness()
        const older = saveListedConversation(harness, {
          sequence: 3,
          title: "Older",
          userMessages: ["a"],
          createdAtMinute: 1
        })
        const tieLow = saveListedConversation(harness, {
          sequence: 1,
          title: "Tie low",
          userMessages: ["b"],
          createdAtMinute: 2
        })
        const tieHigh = saveListedConversation(harness, {
          sequence: 2,
          title: "Tie high",
          userMessages: ["c"],
          createdAtMinute: 2
        })

        expect(
          harness.recordReader
            .listConversations(FIRST_PAGE)
            .conversations.map(({ id }) => id)
        ).toEqual([tieHigh, tieLow, older])
      })

      it("summarizes each conversation without its system prompt", () => {
        const harness = createHarness()
        const id = saveListedConversation(harness, {
          sequence: 1,
          title: "Trip plan",
          userMessages: ["First", "Latest"],
          createdAtMinute: 1
        })

        expect(
          harness.recordReader.listConversations(FIRST_PAGE).conversations
        ).toEqual([
          {
            id,
            title: "Trip plan",
            createdAt: createFixtureTimestamp(1),
            updatedAt: createFixtureTimestamp(1, 2),
            preview: { role: "user", content: "Latest" }
          }
        ])
      })

      it("previews the latest message with content, skipping an empty reply", () => {
        const harness = createHarness()
        const id = saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: ["Question"],
          createdAtMinute: 1
        })
        harness.saveAssistantMessage({
          id: createFixtureUuidV7(150),
          conversationId: id,
          model: "qwen/qwen3-8b",
          content: "",
          status: "streaming",
          finishReason: null,
          createdAt: createFixtureTimestamp(1, 30),
          updatedAt: createFixtureTimestamp(1, 30)
        })

        expect(
          harness.recordReader.listConversations(FIRST_PAGE).conversations[0]
            ?.preview
        ).toEqual({ role: "user", content: "Question" })
      })

      it("previews nothing for a conversation without messages", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: [],
          createdAtMinute: 1
        })

        expect(
          harness.recordReader.listConversations(FIRST_PAGE).conversations[0]
            ?.preview
        ).toBeNull()
      })

      it("lists only matching conversations and counts matches separately from stored conversations", () => {
        const harness = createHarness()
        const titleMatch = saveListedConversation(harness, {
          sequence: 1,
          title: "TRIP plan",
          userMessages: ["Unrelated"],
          createdAtMinute: 1
        })
        const messageMatch = saveListedConversation(harness, {
          sequence: 2,
          title: "Budget",
          userMessages: ["Book the trip"],
          createdAtMinute: 2
        })
        saveListedConversation(harness, {
          sequence: 3,
          title: "Groceries",
          userMessages: ["Milk"],
          createdAtMinute: 3
        })

        const page = harness.recordReader.listConversations({
          ...FIRST_PAGE,
          query: "trip"
        })

        expect(page.storedCount).toBe(3)
        expect(page.matchCount).toBe(2)
        expect(page.conversations.map(({ id }) => id)).toEqual([
          messageMatch,
          titleMatch
        ])
      })

      it("previews the latest matching message ahead of a newer non-matching message", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: ["Book the trip", "Anything else"],
          createdAtMinute: 1
        })

        expect(
          harness.recordReader.listConversations({
            ...FIRST_PAGE,
            query: "trip"
          }).conversations[0]?.preview
        ).toEqual({ role: "user", content: "Book the trip" })
      })

      it("previews the latest message when only the title matches", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: "Trip plan",
          userMessages: ["First", "Latest"],
          createdAtMinute: 1
        })

        expect(
          harness.recordReader.listConversations({
            ...FIRST_PAGE,
            query: "trip"
          }).conversations[0]?.preview
        ).toEqual({ role: "user", content: "Latest" })
      })

      it("reports more rows after a full page and continues after its boundary", () => {
        const harness = createHarness()
        const ids = [1, 2, 3].map((sequence) =>
          saveListedConversation(harness, {
            sequence,
            title: `Conversation ${sequence}`,
            userMessages: ["message"],
            createdAtMinute: 5
          })
        )

        const firstPage = harness.recordReader.listConversations({
          query: "",
          after: undefined,
          limit: 2
        })
        expect(firstPage.conversations.map(({ id }) => id)).toEqual([
          ids[2],
          ids[1]
        ])
        expect(firstPage.hasMore).toBe(true)

        const boundary = firstPage.conversations.at(-1)
        const secondPage = harness.recordReader.listConversations({
          query: "",
          after:
            boundary === undefined
              ? undefined
              : { updatedAt: boundary.updatedAt, id: boundary.id },
          limit: 2
        })
        expect(secondPage.conversations.map(({ id }) => id)).toEqual([ids[0]])
        expect(secondPage.hasMore).toBe(false)
        expect(secondPage.storedCount).toBe(3)
      })

      it("reports no more rows when the rows exactly fill the page", () => {
        const harness = createHarness()
        for (const sequence of [1, 2]) {
          saveListedConversation(harness, {
            sequence,
            title: null,
            userMessages: ["message"],
            createdAtMinute: sequence
          })
        }

        const page = harness.recordReader.listConversations({
          query: "",
          after: undefined,
          limit: 2
        })

        expect(page.conversations).toHaveLength(2)
        expect(page.hasMore).toBe(false)
      })

      it("accepts the maximum page size", () => {
        const harness = createHarness()
        const sequences = Array.from(
          { length: MAXIMUM_CONVERSATION_LIST_PAGE_SIZE + 1 },
          (_, index) => index + 1
        )
        for (const sequence of sequences) {
          saveListedConversation(harness, {
            sequence,
            title: null,
            userMessages: [],
            createdAtMinute: sequence
          })
        }

        const page = harness.recordReader.listConversations({
          ...FIRST_PAGE,
          limit: MAXIMUM_CONVERSATION_LIST_PAGE_SIZE
        })

        expect(page.conversations).toHaveLength(
          MAXIMUM_CONVERSATION_LIST_PAGE_SIZE
        )
        expect(page.hasMore).toBe(true)
      })

      it("rejects a stored row that violates the summary contract and stays usable", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: "",
          userMessages: [],
          createdAtMinute: 1
        })

        expect(() =>
          harness.recordReader.listConversations(FIRST_PAGE)
        ).toThrow(z.ZodError)

        expect(
          harness.recordEditor.deleteConversation(createFixtureUuidV7(1))
        ).toBe(true)
      })
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      harness.closeRecords()

      expect(() =>
        harness.recordReader.findConversation(CONVERSATION_ID)
      ).toThrow("Database is closed")
      expect(() => harness.recordReader.listConversations(FIRST_PAGE)).toThrow(
        "Database is closed"
      )
    })
  })
}

/**
 * Registers the provider-independent {@link ConversationRecordEditor}
 * contract cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerConversationRecordEditorContractSuite(
  createHarness: ConversationRecordsHarnessFactory
): void {
  describe("ConversationRecordEditor contract", () => {
    describe("updateConversationTitle", () => {
      it("replaces the title and returns metadata with unchanged activity time", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: ["Hello"],
          createdAtMinute: 1
        })
        const before = harness.recordReader.findConversation(CONVERSATION_ID)

        const metadata = harness.recordEditor.updateConversationTitle(
          CONVERSATION_ID,
          "Greeting"
        )

        expect(metadata).toEqual({
          id: CONVERSATION_ID,
          title: "Greeting",
          agentCode: "stored-agent",
          createdAt: createFixtureTimestamp(1),
          updatedAt: createFixtureTimestamp(1, 1)
        })
        expect(harness.recordReader.findConversation(CONVERSATION_ID)).toEqual({
          ...before,
          title: "Greeting"
        })
      })

      it("stores the same title when the rename repeats", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: ["Hello"],
          createdAtMinute: 1
        })
        const first = harness.recordEditor.updateConversationTitle(
          CONVERSATION_ID,
          "Greeting"
        )

        expect(
          harness.recordEditor.updateConversationTitle(
            CONVERSATION_ID,
            "Greeting"
          )
        ).toEqual(first)
        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.title
        ).toBe("Greeting")
      })

      it("returns undefined for an absent conversation and stores nothing", () => {
        const { recordEditor, recordReader } = createHarness()

        expect(
          recordEditor.updateConversationTitle(CONVERSATION_ID, "Greeting")
        ).toBeUndefined()

        expect(recordReader.listConversations(FIRST_PAGE).storedCount).toBe(0)
      })
    })

    describe("deleteConversation", () => {
      it("removes the conversation and reports whether it existed", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: ["Hello"],
          createdAtMinute: 1
        })

        expect(harness.recordEditor.deleteConversation(CONVERSATION_ID)).toBe(
          true
        )
        expect(harness.recordEditor.deleteConversation(CONVERSATION_ID)).toBe(
          false
        )

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toBeUndefined()
        expect(
          harness.recordReader.listConversations(FIRST_PAGE).storedCount
        ).toBe(0)
      })

      it("removes the transcript with the conversation", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Partial",
          status: "streaming",
          finishReason: null
        })

        harness.recordEditor.deleteConversation(CONVERSATION_ID)

        expect(
          harness.turnRecordWriter.updateAssistantMessageContent({
            assistantMessageId: createFixtureUuidV7(11),
            content: " late",
            updatedAt: CHANGED_AT
          })
        ).toBe(false)
      })
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      harness.closeRecords()

      expect(() =>
        harness.recordEditor.updateConversationTitle(CONVERSATION_ID, "Title")
      ).toThrow("Database is closed")
      expect(() =>
        harness.recordEditor.deleteConversation(CONVERSATION_ID)
      ).toThrow("Database is closed")
    })
  })
}

/**
 * Creates a conversation inside a turn write and keeps the lent transaction.
 *
 * @param turnRecordWriter - Turn persistence under test.
 * @returns The transaction, whose write has committed by the time it returns.
 */
function retainTurnTransaction(
  turnRecordWriter: ConversationTurnRecordWriter
): ConversationTurnTransaction {
  return turnRecordWriter.handleConversationTurnWriteRequest((transaction) => {
    transaction.createConversation(
      createNewConversationMetadata(CONVERSATION_ID)
    )
    return transaction
  })
}

/**
 * Creates a conversation, waits for a microtask, then appends a message, as
 * an asynchronous operation would.
 *
 * @param transaction - Transaction lent to the operation.
 * @returns Settlement after the second write.
 * @throws What the second write throws once the transaction has ended.
 */
async function saveConversationAroundAwait(
  transaction: ConversationTurnTransaction
): Promise<void> {
  transaction.createConversation(createNewConversationMetadata(CONVERSATION_ID))
  await Promise.resolve()
  transaction.createUserMessage(CONVERSATION_ID, {
    id: createFixtureUuidV7(10),
    role: "user",
    content: "after await",
    createdAt: CHANGED_AT
  })
}

/**
 * Registers the provider-independent {@link ConversationTurnRecordWriter}
 * contract cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerConversationTurnRecordWriterContractSuite(
  createHarness: ConversationRecordsHarnessFactory
): void {
  describe("ConversationTurnRecordWriter contract", () => {
    describe("handleConversationTurnWriteRequest", () => {
      it("returns the operation's result after its writes commit", () => {
        const { turnRecordWriter, recordReader } = createHarness()

        const result = turnRecordWriter.handleConversationTurnWriteRequest(
          (transaction) => {
            transaction.createConversation(
              createNewConversationMetadata(CONVERSATION_ID)
            )
            return "created"
          }
        )

        expect(result).toBe("created")
        expect(recordReader.findConversation(CONVERSATION_ID)).toEqual({
          ...createNewConversationMetadata(CONVERSATION_ID),
          messages: []
        })
      })

      it("rolls back every write when the operation throws and rethrows its failure", () => {
        const { turnRecordWriter, recordReader } = createHarness()
        const failure = new Error("Turn rejected")

        expect(
          getThrownFailure(() =>
            turnRecordWriter.handleConversationTurnWriteRequest(
              (transaction) => {
                transaction.createConversation(
                  createNewConversationMetadata(CONVERSATION_ID)
                )
                throw failure
              }
            )
          )
        ).toBe(failure)

        expect(recordReader.findConversation(CONVERSATION_ID)).toBeUndefined()
      })

      it("rejects an operation that returns a promise and rolls back its writes", () => {
        const { turnRecordWriter, recordReader } = createHarness()

        expect(() =>
          turnRecordWriter.handleConversationTurnWriteRequest(
            // @ts-expect-error -- An operation's result type refuses a promise.
            async (transaction: ConversationTurnTransaction) => {
              transaction.createConversation(
                createNewConversationMetadata(CONVERSATION_ID)
              )
            }
          )
        ).toThrow("Database operations must be synchronous")

        expect(recordReader.findConversation(CONVERSATION_ID)).toBeUndefined()
      })

      it("keeps an asynchronous operation's writes after its first await out of the store", async () => {
        const { turnRecordWriter, recordReader } = createHarness()
        const startedOperations: Promise<void>[] = []

        expect(() =>
          turnRecordWriter.handleConversationTurnWriteRequest(
            // @ts-expect-error -- An operation's result type refuses a promise.
            (transaction: ConversationTurnTransaction) => {
              const operation = saveConversationAroundAwait(transaction)
              startedOperations.push(operation)
              return operation
            }
          )
        ).toThrow("Database operations must be synchronous")

        await expect(Promise.all(startedOperations)).rejects.toThrow(
          "Database operation has ended"
        )
        expect(recordReader.findConversation(CONVERSATION_ID)).toBeUndefined()
      })

      it("refuses records calls nested in a turn operation and keeps its writes", () => {
        const harness = createHarness()
        const metadata = createNewConversationMetadata(CONVERSATION_ID)
        const nestedOperation = vi.fn(() => "never run")

        harness.turnRecordWriter.handleConversationTurnWriteRequest(
          (transaction) => {
            transaction.createConversation(metadata)
            expect(() =>
              harness.turnRecordWriter.handleConversationTurnWriteRequest(
                nestedOperation
              )
            ).toThrow("Database transactions cannot be nested")
            expect(() =>
              harness.recordReader.findConversation(CONVERSATION_ID)
            ).toThrow("Database transactions cannot be nested")
            expect(() =>
              harness.recordEditor.deleteConversation(CONVERSATION_ID)
            ).toThrow("Database transactions cannot be nested")
          }
        )

        expect(nestedOperation).not.toHaveBeenCalled()
        expect(harness.recordReader.findConversation(CONVERSATION_ID)).toEqual({
          ...metadata,
          messages: []
        })
      })

      it("refuses every call on a transaction kept after its operation returned", () => {
        const { turnRecordWriter, recordReader } = createHarness()
        const transaction = retainTurnTransaction(turnRecordWriter)

        expect(() =>
          transaction.updateStreamingAssistantMessagesToInterrupted(
            CONVERSATION_ID,
            CHANGED_AT
          )
        ).toThrow("Database operation has ended")
        expect(() =>
          transaction.createConversation(
            createNewConversationMetadata(OTHER_CONVERSATION_ID)
          )
        ).toThrow("Database operation has ended")
        expect(() => transaction.findConversation(CONVERSATION_ID)).toThrow(
          "Database operation has ended"
        )
        expect(() =>
          transaction.createUserMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(10),
            role: "user",
            content: "late",
            createdAt: CHANGED_AT
          })
        ).toThrow("Database operation has ended")
        expect(() =>
          transaction.createAssistantMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(11),
            role: "assistant",
            model: "qwen/qwen3-8b",
            content: "",
            status: "streaming",
            finishReason: null,
            createdAt: CHANGED_AT,
            updatedAt: CHANGED_AT
          })
        ).toThrow("Database operation has ended")

        expect(
          recordReader.findConversation(OTHER_CONVERSATION_ID)
        ).toBeUndefined()
        expect(
          recordReader.findConversation(CONVERSATION_ID)?.messages
        ).toEqual([])
      })
    })

    describe("updateAllStreamingAssistantMessagesToInterrupted", () => {
      it("interrupts every streaming reply, keeping its text and the activity time", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Partial",
          status: "streaming",
          finishReason: null
        })
        saveConversationWithReply(harness, OTHER_CONVERSATION_ID, {
          sequence: 21,
          content: "",
          status: "streaming",
          finishReason: null
        })

        harness.turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
          CHANGED_AT
        )

        for (const [id, content] of [
          [CONVERSATION_ID, "Partial"],
          [OTHER_CONVERSATION_ID, ""]
        ] as const) {
          expect(harness.recordReader.findConversation(id)).toMatchObject({
            updatedAt: "2025-01-01T00:00:01.000Z",
            messages: [
              {
                content,
                status: "interrupted",
                finishReason: null,
                updatedAt: CHANGED_AT
              }
            ]
          })
        }
      })

      it("changes nothing more when repeated", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Partial",
          status: "streaming",
          finishReason: null
        })
        harness.turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
          CHANGED_AT
        )
        const afterFirstCall =
          harness.recordReader.findConversation(CONVERSATION_ID)

        harness.turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
          "2026-03-04T05:06:08.000Z"
        )

        expect(harness.recordReader.findConversation(CONVERSATION_ID)).toEqual(
          afterFirstCall
        )
      })

      it.each([
        { status: "completed", finishReason: "stop" } as const,
        { status: "failed", finishReason: null } as const
      ])("leaves a $status reply unchanged", (state) => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Done",
          ...state
        })

        harness.turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
          CHANGED_AT
        )

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
        ).toMatchObject({ ...state, updatedAt: "2025-01-01T00:00:01.000Z" })
      })
    })

    describe("updateAssistantMessageContent", () => {
      it("appends deltas to a streaming reply in call order", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "",
          status: "streaming",
          finishReason: null
        })
        const replyId = createFixtureUuidV7(11)

        expect(
          harness.turnRecordWriter.updateAssistantMessageContent({
            assistantMessageId: replyId,
            content: "Hi",
            updatedAt: "2026-03-04T05:06:07.000Z"
          })
        ).toBe(true)
        expect(
          harness.turnRecordWriter.updateAssistantMessageContent({
            assistantMessageId: replyId,
            content: " there",
            updatedAt: CHANGED_AT
          })
        ).toBe(true)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
        ).toMatchObject({
          content: "Hi there",
          status: "streaming",
          updatedAt: CHANGED_AT
        })
      })

      it("moves the conversation's activity time forward with each delta", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "",
          status: "streaming",
          finishReason: null
        })
        const replyId = createFixtureUuidV7(11)
        const beforeDeltas = getActivityTime(harness)

        harness.turnRecordWriter.updateAssistantMessageContent({
          assistantMessageId: replyId,
          content: "Hi",
          updatedAt: CHANGED_AT
        })
        const afterFirstDelta = getActivityTime(harness)
        harness.turnRecordWriter.updateAssistantMessageContent({
          assistantMessageId: replyId,
          content: " there",
          updatedAt: CHANGED_AT
        })

        expect(afterFirstDelta).toBeGreaterThan(beforeDeltas)
        expect(getActivityTime(harness)).toBeGreaterThan(afterFirstDelta)
      })

      it("returns false for a finalized reply and keeps its text", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Done",
          status: "interrupted",
          finishReason: null
        })

        expect(
          harness.turnRecordWriter.updateAssistantMessageContent({
            assistantMessageId: createFixtureUuidV7(11),
            content: " late",
            updatedAt: CHANGED_AT
          })
        ).toBe(false)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
        ).toMatchObject({
          content: "Done",
          updatedAt: "2025-01-01T00:00:01.000Z"
        })
      })

      it("returns false for a reply that is not stored", () => {
        const { turnRecordWriter } = createHarness()

        expect(
          turnRecordWriter.updateAssistantMessageContent({
            assistantMessageId: createFixtureUuidV7(11),
            content: "Hi",
            updatedAt: CHANGED_AT
          })
        ).toBe(false)
      })
    })

    describe("updateAssistantMessageState", () => {
      it("completes a streaming reply with its finish reason", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Hi",
          status: "streaming",
          finishReason: null
        })

        expect(
          harness.turnRecordWriter.updateAssistantMessageState({
            assistantMessageId: createFixtureUuidV7(11),
            completion: { status: "completed", finishReason: "length" },
            updatedAt: CHANGED_AT
          })
        ).toBe(true)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toMatchObject({
          updatedAt: "2025-01-01T00:00:01.000Z",
          messages: [
            {
              content: "Hi",
              status: "completed",
              finishReason: "length",
              updatedAt: CHANGED_AT
            }
          ]
        })
      })

      it.each(["interrupted", "failed"] as const)(
        "stores %s without a finish reason",
        (status) => {
          const harness = createHarness()
          saveConversationWithReply(harness, CONVERSATION_ID, {
            sequence: 11,
            content: "Hi",
            status: "streaming",
            finishReason: null
          })

          expect(
            harness.turnRecordWriter.updateAssistantMessageState({
              assistantMessageId: createFixtureUuidV7(11),
              completion: { status },
              updatedAt: CHANGED_AT
            })
          ).toBe(true)

          expect(
            harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
          ).toMatchObject({ status, finishReason: null, updatedAt: CHANGED_AT })
        }
      )

      it("finalizes a reply only once", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          content: "Done",
          status: "completed",
          finishReason: "stop"
        })

        expect(
          harness.turnRecordWriter.updateAssistantMessageState({
            assistantMessageId: createFixtureUuidV7(11),
            completion: { status: "failed" },
            updatedAt: CHANGED_AT
          })
        ).toBe(false)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
        ).toMatchObject({ status: "completed", finishReason: "stop" })
      })

      it("returns false for a reply that is not stored", () => {
        const { turnRecordWriter } = createHarness()

        expect(
          turnRecordWriter.updateAssistantMessageState({
            assistantMessageId: createFixtureUuidV7(11),
            completion: { status: "failed" },
            updatedAt: CHANGED_AT
          })
        ).toBe(false)
      })
    })

    describe("updateUntitledConversationTitle", () => {
      it("stores the title of an untitled conversation", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: null,
          userMessages: [],
          createdAtMinute: 1
        })

        expect(
          harness.turnRecordWriter.updateUntitledConversationTitle(
            CONVERSATION_ID,
            "Greeting"
          )
        ).toBe(true)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toMatchObject({
          title: "Greeting",
          updatedAt: createFixtureTimestamp(1)
        })
      })

      it("keeps an existing title and returns false", () => {
        const harness = createHarness()
        saveListedConversation(harness, {
          sequence: 1,
          title: "Renamed",
          userMessages: [],
          createdAtMinute: 1
        })

        expect(
          harness.turnRecordWriter.updateUntitledConversationTitle(
            CONVERSATION_ID,
            "Greeting"
          )
        ).toBe(false)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.title
        ).toBe("Renamed")
      })

      it("returns false for a conversation that is not stored", () => {
        const { turnRecordWriter } = createHarness()

        expect(
          turnRecordWriter.updateUntitledConversationTitle(
            CONVERSATION_ID,
            "Greeting"
          )
        ).toBe(false)
      })
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      harness.closeRecords()
      const replyId = createFixtureUuidV7(11)
      const operation = vi.fn(() => "never run")

      expect(() =>
        harness.turnRecordWriter.handleConversationTurnWriteRequest(operation)
      ).toThrow("Database is closed")
      expect(operation).not.toHaveBeenCalled()
      expect(() =>
        harness.turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
          CHANGED_AT
        )
      ).toThrow("Database is closed")
      expect(() =>
        harness.turnRecordWriter.updateAssistantMessageContent({
          assistantMessageId: replyId,
          content: "Hi",
          updatedAt: CHANGED_AT
        })
      ).toThrow("Database is closed")
      expect(() =>
        harness.turnRecordWriter.updateAssistantMessageState({
          assistantMessageId: replyId,
          completion: { status: "failed" },
          updatedAt: CHANGED_AT
        })
      ).toThrow("Database is closed")
      expect(() =>
        harness.turnRecordWriter.updateUntitledConversationTitle(
          CONVERSATION_ID,
          "Title"
        )
      ).toThrow("Database is closed")
    })
  })
}

/**
 * Registers the provider-independent {@link ConversationTurnTransaction}
 * contract cases, each run inside one turn write.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerConversationTurnTransactionContractSuite(
  createHarness: ConversationRecordsHarnessFactory
): void {
  describe("ConversationTurnTransaction contract", () => {
    it("creates a conversation that the same transaction and later reads observe", () => {
      const { turnRecordWriter, recordReader } = createHarness()
      const metadata = createNewConversationMetadata(CONVERSATION_ID)

      const observed = turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.createConversation(metadata)
          return transaction.findConversation(CONVERSATION_ID)
        }
      )

      expect(observed).toEqual({ ...metadata, messages: [] })
      expect(recordReader.findConversation(CONVERSATION_ID)).toEqual({
        ...metadata,
        messages: []
      })
    })

    it("finds no conversation that is not stored", () => {
      const { turnRecordWriter } = createHarness()

      expect(
        turnRecordWriter.handleConversationTurnWriteRequest((transaction) =>
          transaction.findConversation(CONVERSATION_ID)
        )
      ).toBeUndefined()
    })

    it("rejects a stored value that violates the conversation contract", () => {
      const harness = createHarness()
      harness.saveConversation({
        id: CONVERSATION_ID,
        title: "",
        agentCode: "lys",
        createdAt: CREATED_AT
      })

      expect(() =>
        harness.turnRecordWriter.handleConversationTurnWriteRequest(
          (transaction) => transaction.findConversation(CONVERSATION_ID)
        )
      ).toThrow(z.ZodError)
    })

    it("refuses a conversation whose identity is already stored and keeps the stored one", () => {
      const harness = createHarness()
      harness.saveConversation({
        id: CONVERSATION_ID,
        title: "Trip plan",
        agentCode: "stored-agent",
        createdAt: CREATED_AT
      })

      expect(() =>
        harness.turnRecordWriter.handleConversationTurnWriteRequest(
          (transaction) => {
            transaction.createConversation(
              createNewConversationMetadata(CONVERSATION_ID)
            )
          }
        )
      ).toThrow()

      expect(harness.recordReader.findConversation(CONVERSATION_ID)).toEqual({
        id: CONVERSATION_ID,
        title: "Trip plan",
        agentCode: "stored-agent",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        messages: []
      })
    })

    it.each([
      {
        role: "user",
        createMessage: (transaction: ConversationTurnTransaction) => {
          transaction.createUserMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(10),
            role: "user",
            content: "Hello",
            createdAt: CHANGED_AT
          })
        }
      },
      {
        role: "assistant",
        createMessage: (transaction: ConversationTurnTransaction) => {
          transaction.createAssistantMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(11),
            role: "assistant",
            model: "qwen/qwen3-8b",
            content: "",
            status: "streaming",
            finishReason: null,
            createdAt: CHANGED_AT,
            updatedAt: CHANGED_AT
          })
        }
      }
    ])(
      "refuses a $role message for a conversation that is not stored and keeps the turn's other writes out",
      ({ createMessage }) => {
        const harness = createHarness()

        expect(() =>
          harness.turnRecordWriter.handleConversationTurnWriteRequest(
            (transaction) => {
              transaction.createConversation(
                createNewConversationMetadata(OTHER_CONVERSATION_ID)
              )
              createMessage(transaction)
            }
          )
        ).toThrow()

        expect(
          harness.recordReader.findConversation(OTHER_CONVERSATION_ID)
        ).toBeUndefined()
      }
    )

    it("moves the activity time to the time of a later message", () => {
      const harness = createHarness()
      harness.saveConversation({
        id: CONVERSATION_ID,
        title: null,
        agentCode: "lys",
        createdAt: CREATED_AT
      })

      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.createUserMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(10),
            role: "user",
            content: "Hello",
            createdAt: CHANGED_AT
          })
        }
      )

      expect(
        harness.recordReader.findConversation(CONVERSATION_ID)?.updatedAt
      ).toBe(CHANGED_AT)
    })

    it("moves the activity time past a message that is not later than it", () => {
      const harness = createHarness()

      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.createConversation(
            createNewConversationMetadata(CONVERSATION_ID)
          )
          transaction.createAssistantMessage(CONVERSATION_ID, {
            id: createFixtureUuidV7(11),
            role: "assistant",
            model: "qwen/qwen3-8b",
            content: "",
            status: "streaming",
            finishReason: null,
            createdAt: CHANGED_AT,
            updatedAt: CHANGED_AT
          })
        }
      )

      expect(getActivityTime(harness)).toBeGreaterThan(Date.parse(CHANGED_AT))
    })

    it("appends user and assistant messages exactly as given, in order", () => {
      const { turnRecordWriter, recordReader } = createHarness()
      const userMessage = {
        id: createFixtureUuidV7(10),
        role: "user",
        content: "Hello",
        createdAt: CHANGED_AT
      } as const
      const assistantMessage = {
        id: createFixtureUuidV7(11),
        role: "assistant",
        model: "qwen/qwen3-8b",
        content: "Hi there",
        status: "completed",
        finishReason: "stop",
        createdAt: CHANGED_AT,
        updatedAt: CHANGED_AT
      } as const

      const observed = turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.createConversation(
            createNewConversationMetadata(CONVERSATION_ID)
          )
          transaction.createUserMessage(CONVERSATION_ID, userMessage)
          transaction.createAssistantMessage(CONVERSATION_ID, assistantMessage)
          return transaction.findConversation(CONVERSATION_ID)?.messages
        }
      )

      expect(observed).toEqual([userMessage, assistantMessage])
      expect(recordReader.findConversation(CONVERSATION_ID)?.messages).toEqual([
        userMessage,
        assistantMessage
      ])
    })

    it("interrupts only the addressed conversation's streaming replies", () => {
      const harness = createHarness()
      saveConversationWithReply(harness, CONVERSATION_ID, {
        sequence: 11,
        content: "Partial",
        status: "streaming",
        finishReason: null
      })
      saveConversationWithReply(harness, OTHER_CONVERSATION_ID, {
        sequence: 21,
        content: "Other partial",
        status: "streaming",
        finishReason: null
      })

      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.updateStreamingAssistantMessagesToInterrupted(
            CONVERSATION_ID,
            CHANGED_AT
          )
        }
      )

      expect(
        harness.recordReader.findConversation(CONVERSATION_ID)
      ).toMatchObject({
        updatedAt: "2025-01-01T00:00:01.000Z",
        messages: [
          {
            content: "Partial",
            status: "interrupted",
            finishReason: null,
            updatedAt: CHANGED_AT
          }
        ]
      })
      expect(
        harness.recordReader.findConversation(OTHER_CONVERSATION_ID)
          ?.messages[0]
      ).toMatchObject({ content: "Other partial", status: "streaming" })
    })

    it("leaves a finalized reply unchanged when interrupting its conversation", () => {
      const harness = createHarness()
      saveConversationWithReply(harness, CONVERSATION_ID, {
        sequence: 11,
        content: "Done",
        status: "completed",
        finishReason: "stop"
      })

      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.updateStreamingAssistantMessagesToInterrupted(
            CONVERSATION_ID,
            CHANGED_AT
          )
        }
      )

      expect(
        harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
      ).toMatchObject({
        status: "completed",
        finishReason: "stop",
        updatedAt: "2025-01-01T00:00:01.000Z"
      })
    })
  })
}
