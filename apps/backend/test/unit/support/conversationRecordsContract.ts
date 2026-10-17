import { MAXIMUM_CONVERSATION_LIST_PAGE_SIZE } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type { ConversationSource, ReplyPart } from "@lys/share"
import type {
  ConversationRecordEditor,
  ConversationRecordReader,
  ConversationTurnRecordWriter,
  ConversationTurnTransaction,
  ListConversationsInput,
  ReplyPartRecordWriter
} from "../../../src/modules/conversation/records"
import {
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart
} from "./conversationFixtures"
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
  /**
   * Stored parts in order, each one row under the reply, valid or not; empty
   * for a reply without any.
   */
  parts: readonly ReplyPart[]
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
  /** Reply-part persistence over the store. */
  replyPartRecordWriter: ReplyPartRecordWriter
  /** Stores one conversation exactly as given, valid or not. */
  saveConversation: (row: ConversationRowFixture) => void
  /**
   * Stores one user message exactly as given. Messages are saved in time order
   * after the conversation's creation, so each one's time becomes the
   * conversation's activity time; an earlier time lets the store choose it.
   */
  saveUserMessage: (row: UserMessageRowFixture) => void
  /**
   * Stores one assistant message and its parts exactly as given, in the same
   * time order.
   */
  saveAssistantMessage: (row: AssistantMessageRowFixture) => void
  /** Stores one source of a stored conversation exactly as given. */
  saveSource: (conversationId: string, source: ConversationSource) => void
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
 * @param reply - Identity sequence, parts, and state of the reply.
 */
function saveConversationWithReply(
  harness: ConversationRecordsHarness,
  conversationId: string,
  reply: Pick<
    AssistantMessageRowFixture,
    "parts" | "status" | "finishReason"
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
    parts: reply.parts,
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
          messages: [],
          sources: []
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
        const parts = [
          createReasoningPart(12, 0, "They ask about moths"),
          createTextPart(13, 0, "Let me look"),
          createToolCallPart(
            {
              sequence: 14,
              round: 0,
              toolName: "web_search",
              argumentText: '{"query":"moth"}'
            },
            {
              status: "succeeded",
              result: "Source [1]\nMoths",
              sourceNumbers: [1, 2]
            }
          ),
          createToolCallPart(
            {
              sequence: 15,
              round: 0,
              toolName: "read_page",
              argumentText: "{"
            },
            { status: "failed", result: "Invalid arguments" }
          ),
          createToolCallPart(
            {
              sequence: 16,
              round: 0,
              toolName: "read_text_file",
              argumentText: "{}"
            },
            { status: "rejected", result: "Declined" }
          ),
          createToolCallPart(
            { sequence: 17, round: 0, toolName: "", argumentText: "" },
            { status: "interrupted" }
          ),
          createTextPart(18, 1, "Moths are insects [1].")
        ]
        harness.saveAssistantMessage({
          id: createFixtureUuidV7(11),
          conversationId: CONVERSATION_ID,
          model: "qwen/qwen3-8b",
          parts,
          status: "completed",
          finishReason: "stop",
          createdAt: "2025-01-01T00:00:02.000Z",
          updatedAt: "2025-01-01T00:00:03.000Z"
        })
        const sources = [
          { number: 1, url: "https://example.com/moth", title: "Moth" },
          { number: 2, url: "https://example.org/", title: "Insects" }
        ]
        harness.saveSource(CONVERSATION_ID, sources[1]!)
        harness.saveSource(CONVERSATION_ID, sources[0]!)

        const conversation =
          harness.recordReader.findConversation(CONVERSATION_ID)

        expect(conversation?.messages).toEqual([
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
            parts,
            status: "completed",
            finishReason: "stop",
            createdAt: "2025-01-01T00:00:02.000Z",
            updatedAt: "2025-01-01T00:00:03.000Z"
          }
        ])
        expect(conversation?.sources).toEqual(sources)
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
            ?.messages.map((message) =>
              message.role === "user" ? message.content : message.id
            )
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

      it("rejects a stored part that violates the part contract", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [
            createTextPart(12, 0, "Kept"),
            { ...createTextPart(13, 0, "Bad"), id: "not-a-uuid" }
          ],
          status: "completed",
          finishReason: "stop"
        })

        expect(() =>
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toThrow(z.ZodError)
      })

      it("rejects a stored source that violates the source contract", () => {
        const harness = createHarness()
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: null,
          agentCode: "lys",
          createdAt: CREATED_AT
        })
        harness.saveSource(CONVERSATION_ID, {
          number: 1,
          url: "ftp://example.com/",
          title: "Not a web page"
        })

        expect(() =>
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toThrow(z.ZodError)
      })

      it("reads only the addressed conversation's sources", () => {
        const harness = createHarness()
        for (const id of [CONVERSATION_ID, OTHER_CONVERSATION_ID])
          harness.saveConversation({
            id,
            title: null,
            agentCode: "lys",
            createdAt: CREATED_AT
          })
        const source = { number: 1, url: "https://example.com/", title: "A" }
        harness.saveSource(OTHER_CONVERSATION_ID, source)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.sources
        ).toEqual([])
        expect(
          harness.recordReader.findConversation(OTHER_CONVERSATION_ID)?.sources
        ).toEqual([source])
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

      it("summarizes each conversation without its agent code", () => {
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

      it("previews a reply's latest text as the reply's, never its reasoning or a tool result", () => {
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
          parts: [
            createReasoningPart(151, 0, "Thinking"),
            createTextPart(152, 0, "First"),
            createToolCallPart(
              {
                sequence: 153,
                round: 0,
                toolName: "web_search",
                argumentText: "{}"
              },
              { status: "succeeded", result: "Tool output", sourceNumbers: [] }
            ),
            createTextPart(154, 1, "Final answer"),
            createReasoningPart(155, 1, "Afterthought")
          ],
          status: "completed",
          finishReason: "stop",
          createdAt: createFixtureTimestamp(1, 30),
          updatedAt: createFixtureTimestamp(1, 30)
        })

        expect(
          harness.recordReader.listConversations(FIRST_PAGE).conversations[0]
            ?.preview
        ).toEqual({ role: "assistant", content: "Final answer" })
      })

      it("previews the latest message with text, skipping a reply that has none", () => {
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
          parts: [createReasoningPart(151, 0, "Thinking")],
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

      it.each([
        ["reply text", "textword", 1],
        ["reasoning", "thinkword", 0],
        ["a tool result", "toolword", 0]
      ])("matches %s: %s", (_label, query, matchCount) => {
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
          parts: [
            createReasoningPart(151, 0, "A thinkword"),
            createToolCallPart(
              {
                sequence: 152,
                round: 0,
                toolName: "web_search",
                argumentText: "{}"
              },
              { status: "succeeded", result: "A toolword", sourceNumbers: [] }
            ),
            createTextPart(153, 1, "A textword")
          ],
          status: "completed",
          finishReason: "stop",
          createdAt: createFixtureTimestamp(1, 30),
          updatedAt: createFixtureTimestamp(1, 30)
        })

        expect(
          harness.recordReader.listConversations({ ...FIRST_PAGE, query })
            .matchCount
        ).toBe(matchCount)
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

      it("removes the transcript, its replies' parts, and its sources with the conversation", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [createTextPart(1011, 0, "Partial")],
          status: "streaming",
          finishReason: null
        })
        harness.saveSource(CONVERSATION_ID, {
          number: 1,
          url: "https://example.com/",
          title: "Example"
        })

        harness.recordEditor.deleteConversation(CONVERSATION_ID)

        expect(
          harness.replyPartRecordWriter.updateReplyPartContent({
            assistantMessageId: createFixtureUuidV7(11),
            partId: createFixtureUuidV7(1011),
            content: " late",
            updatedAt: CHANGED_AT
          })
        ).toBe(false)
        harness.saveConversation({
          id: CONVERSATION_ID,
          title: null,
          agentCode: "lys",
          createdAt: CREATED_AT
        })
        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toMatchObject({ messages: [], sources: [] })
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
          messages: [],
          sources: []
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
            (transaction: ConversationTurnTransaction) =>
              new Promise<void>((resolve) => {
                transaction.createConversation(
                  createNewConversationMetadata(CONVERSATION_ID)
                )
                resolve()
              })
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
          messages: [],
          sources: []
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
            parts: [],
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
      it("interrupts every streaming reply and its waiting and running calls, keeping its parts and the activity time", () => {
        const harness = createHarness()
        const waitingCall = createToolCallPart(
          {
            sequence: 1012,
            round: 0,
            toolName: "web_search",
            argumentText: "{}"
          },
          { status: "awaiting-approval" }
        )
        const runningCall = createToolCallPart(
          {
            sequence: 1013,
            round: 0,
            toolName: "read_page",
            argumentText: "{}"
          },
          { status: "running" }
        )
        const finishedCall = createToolCallPart(
          {
            sequence: 1014,
            round: 0,
            toolName: "read_page",
            argumentText: "{}"
          },
          { status: "failed", result: "Could not read" }
        )
        const text = createTextPart(1011, 0, "Partial")
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [text, waitingCall, runningCall, finishedCall],
          status: "streaming",
          finishReason: null
        })
        saveConversationWithReply(harness, OTHER_CONVERSATION_ID, {
          sequence: 21,
          parts: [],
          status: "streaming",
          finishReason: null
        })
        const activityTime = getActivityTime(harness)

        harness.turnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted(
          CHANGED_AT
        )

        expect(getActivityTime(harness)).toBe(activityTime)
        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages
        ).toMatchObject([
          {
            parts: [
              text,
              { ...waitingCall, status: "interrupted", updatedAt: CHANGED_AT },
              { ...runningCall, status: "interrupted", updatedAt: CHANGED_AT },
              finishedCall
            ],
            status: "interrupted",
            finishReason: null,
            updatedAt: CHANGED_AT
          }
        ])
        expect(
          harness.recordReader.findConversation(OTHER_CONVERSATION_ID)
        ).toMatchObject({
          updatedAt: "2025-01-01T00:00:01.000Z",
          messages: [
            {
              parts: [],
              status: "interrupted",
              finishReason: null,
              updatedAt: CHANGED_AT
            }
          ]
        })
      })

      it("changes nothing more when repeated", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [createTextPart(1011, 0, "Partial")],
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
          parts: [createTextPart(1011, 0, "Done")],
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

    describe("updateAssistantMessageState", () => {
      it("completes a streaming reply with its finish reason", () => {
        const harness = createHarness()
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [createTextPart(1011, 0, "Hi")],
          status: "streaming",
          finishReason: null
        })

        const activityTime = getActivityTime(harness)

        expect(
          harness.turnRecordWriter.updateAssistantMessageState({
            assistantMessageId: createFixtureUuidV7(11),
            completion: { status: "completed", finishReason: "length" },
            updatedAt: CHANGED_AT
          })
        ).toBe(true)

        expect(getActivityTime(harness)).toBe(activityTime)
        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)
        ).toMatchObject({
          messages: [
            {
              parts: [createTextPart(1011, 0, "Hi")],
              status: "completed",
              finishReason: "length",
              updatedAt: CHANGED_AT
            }
          ]
        })
      })

      it("interrupts the finalized reply's waiting and running calls in the same write", () => {
        const harness = createHarness()
        const waitingCall = createToolCallPart(
          {
            sequence: 1012,
            round: 0,
            toolName: "web_search",
            argumentText: "{}"
          },
          { status: "awaiting-approval" }
        )
        const runningCall = createToolCallPart(
          {
            sequence: 1013,
            round: 0,
            toolName: "read_page",
            argumentText: "{}"
          },
          { status: "running" }
        )
        const finishedCall = createToolCallPart(
          {
            sequence: 1014,
            round: 0,
            toolName: "read_page",
            argumentText: "{}"
          },
          { status: "succeeded", result: "Page", sourceNumbers: [] }
        )
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [waitingCall, runningCall, finishedCall],
          status: "streaming",
          finishReason: null
        })

        harness.turnRecordWriter.updateAssistantMessageState({
          assistantMessageId: createFixtureUuidV7(11),
          completion: { status: "interrupted" },
          updatedAt: CHANGED_AT
        })

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
        ).toMatchObject({
          status: "interrupted",
          parts: [
            { ...waitingCall, status: "interrupted", updatedAt: CHANGED_AT },
            { ...runningCall, status: "interrupted", updatedAt: CHANGED_AT },
            finishedCall
          ]
        })
      })

      it("leaves the calls of a reply that was already final unchanged", () => {
        const harness = createHarness()
        const runningCall = createToolCallPart(
          {
            sequence: 1012,
            round: 0,
            toolName: "read_page",
            argumentText: "{}"
          },
          { status: "running" }
        )
        saveConversationWithReply(harness, CONVERSATION_ID, {
          sequence: 11,
          parts: [runningCall],
          status: "failed",
          finishReason: null
        })

        expect(
          harness.turnRecordWriter.updateAssistantMessageState({
            assistantMessageId: createFixtureUuidV7(11),
            completion: { status: "interrupted" },
            updatedAt: CHANGED_AT
          })
        ).toBe(false)

        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.messages[0]
        ).toMatchObject({ status: "failed", parts: [runningCall] })
      })

      it.each(["interrupted", "failed"] as const)(
        "stores %s without a finish reason",
        (status) => {
          const harness = createHarness()
          saveConversationWithReply(harness, CONVERSATION_ID, {
            sequence: 11,
            parts: [createTextPart(1011, 0, "Hi")],
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
          parts: [createTextPart(1011, 0, "Done")],
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

      expect(observed).toEqual({ ...metadata, messages: [], sources: [] })
      expect(recordReader.findConversation(CONVERSATION_ID)).toEqual({
        ...metadata,
        messages: [],
        sources: []
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
        messages: [],
        sources: []
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
            parts: [],
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
            parts: [],
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
        parts: [],
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

    it("interrupts only the addressed conversation's streaming replies and their open calls", () => {
      const harness = createHarness()
      const text = createTextPart(1011, 0, "Partial")
      const runningCall = createToolCallPart(
        { sequence: 1012, round: 0, toolName: "read_page", argumentText: "{}" },
        { status: "running" }
      )
      const otherWaitingCall = createToolCallPart(
        {
          sequence: 1022,
          round: 0,
          toolName: "web_search",
          argumentText: "{}"
        },
        { status: "awaiting-approval" }
      )
      saveConversationWithReply(harness, CONVERSATION_ID, {
        sequence: 11,
        parts: [text, runningCall],
        status: "streaming",
        finishReason: null
      })
      saveConversationWithReply(harness, OTHER_CONVERSATION_ID, {
        sequence: 21,
        parts: [otherWaitingCall],
        status: "streaming",
        finishReason: null
      })
      const activityTime = getActivityTime(harness)

      harness.turnRecordWriter.handleConversationTurnWriteRequest(
        (transaction) => {
          transaction.updateStreamingAssistantMessagesToInterrupted(
            CONVERSATION_ID,
            CHANGED_AT
          )
        }
      )

      expect(getActivityTime(harness)).toBe(activityTime)
      expect(
        harness.recordReader.findConversation(CONVERSATION_ID)?.messages
      ).toMatchObject([
        {
          parts: [
            text,
            { ...runningCall, status: "interrupted", updatedAt: CHANGED_AT }
          ],
          status: "interrupted",
          finishReason: null,
          updatedAt: CHANGED_AT
        }
      ])
      expect(
        harness.recordReader.findConversation(OTHER_CONVERSATION_ID)
          ?.messages[0]
      ).toMatchObject({ parts: [otherWaitingCall], status: "streaming" })
    })

    it("leaves a finalized reply unchanged when interrupting its conversation", () => {
      const harness = createHarness()
      saveConversationWithReply(harness, CONVERSATION_ID, {
        sequence: 11,
        parts: [createTextPart(1011, 0, "Done")],
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

/** Reply most reply-part cases address. */
const REPLY_ID = createFixtureUuidV7(11)

/**
 * Stores the conversation most cases address with one reply.
 *
 * @param harness - Store under test.
 * @param parts - The reply's stored parts.
 * @param status - The reply's state; streaming unless a case finalized it.
 */
function saveReplyWithParts(
  harness: ConversationRecordsHarness,
  parts: readonly ReplyPart[],
  status: "streaming" | "interrupted" = "streaming"
): void {
  saveConversationWithReply(harness, CONVERSATION_ID, {
    sequence: 11,
    parts,
    status,
    finishReason: null
  })
}

/**
 * Reads the parts of the reply most cases address.
 *
 * @param harness - Store under test.
 * @returns Its stored parts, or undefined when it is not stored.
 */
function readReplyParts(
  harness: ConversationRecordsHarness
): readonly ReplyPart[] | undefined {
  const reply = harness.recordReader
    .findConversation(CONVERSATION_ID)
    ?.messages.find((message) => message.id === REPLY_ID)
  return reply?.role === "assistant" ? reply.parts : undefined
}

/**
 * Creates a stored web search call in one state.
 *
 * @param sequence - Identity sequence of the call.
 * @param status - Its state, without a result.
 * @returns The call.
 */
function createSearchCall(
  sequence: number,
  status: "awaiting-approval" | "running"
) {
  return createToolCallPart(
    {
      sequence,
      round: 0,
      toolName: "web_search",
      argumentText: '{"query":"moth"}'
    },
    { status }
  )
}

/**
 * Registers the provider-independent {@link ReplyPartRecordWriter} contract
 * cases.
 *
 * @param createHarness - Creates the records over an empty store per case.
 */
export function registerReplyPartRecordWriterContractSuite(
  createHarness: ConversationRecordsHarnessFactory
): void {
  describe("ReplyPartRecordWriter contract", () => {
    describe("createReplyPart", () => {
      it("stores each part after the reply's earlier ones, exactly as given", () => {
        const harness = createHarness()
        const earlier = createTextPart(1001, 0, "Earlier")
        saveReplyWithParts(harness, [earlier])
        const created = [
          createReasoningPart(1002, 1, "Thinking"),
          createTextPart(1003, 1, "Looking"),
          createSearchCall(1004, "awaiting-approval"),
          createToolCallPart(
            { sequence: 1005, round: 1, toolName: "nope", argumentText: "x" },
            { status: "failed", result: "No tool is named nope" }
          )
        ]

        for (const part of created)
          expect(
            harness.replyPartRecordWriter.createReplyPart({
              assistantMessageId: REPLY_ID,
              part
            })
          ).toBe(true)

        expect(readReplyParts(harness)).toEqual([earlier, ...created])
      })

      it("moves the conversation's activity time to a later part's time", () => {
        const harness = createHarness()
        saveReplyWithParts(harness, [])

        harness.replyPartRecordWriter.createReplyPart({
          assistantMessageId: REPLY_ID,
          part: {
            ...createTextPart(1001, 0, "Text"),
            createdAt: CHANGED_AT,
            updatedAt: CHANGED_AT
          }
        })

        expect(getActivityTime(harness)).toBe(Date.parse(CHANGED_AT))
      })

      it("returns false for a finalized reply and stores nothing", () => {
        const harness = createHarness()
        saveReplyWithParts(harness, [], "interrupted")

        expect(
          harness.replyPartRecordWriter.createReplyPart({
            assistantMessageId: REPLY_ID,
            part: createTextPart(1001, 0, "Late")
          })
        ).toBe(false)
        expect(readReplyParts(harness)).toEqual([])
      })

      it("returns false for a reply that is not stored", () => {
        const { replyPartRecordWriter } = createHarness()

        expect(
          replyPartRecordWriter.createReplyPart({
            assistantMessageId: REPLY_ID,
            part: createTextPart(1001, 0, "Text")
          })
        ).toBe(false)
      })

      it("refuses a part whose identity is already stored and keeps the stored one", () => {
        const harness = createHarness()
        const stored = createTextPart(1001, 0, "Stored")
        saveReplyWithParts(harness, [stored])

        expect(() =>
          harness.replyPartRecordWriter.createReplyPart({
            assistantMessageId: REPLY_ID,
            part: createTextPart(1001, 0, "Again")
          })
        ).toThrow()
        expect(readReplyParts(harness)).toEqual([stored])
      })
    })

    describe("updateReplyPartContent", () => {
      it.each([
        ["reasoning", createReasoningPart(1001, 0, "Think")],
        ["text", createTextPart(1001, 0, "Hi")]
      ])("appends fragments to a %s part in call order", (_label, part) => {
        const harness = createHarness()
        saveReplyWithParts(harness, [part])

        for (const content of [" a", " b"])
          expect(
            harness.replyPartRecordWriter.updateReplyPartContent({
              assistantMessageId: REPLY_ID,
              partId: part.id,
              content,
              updatedAt: CHANGED_AT
            })
          ).toBe(true)

        expect(readReplyParts(harness)).toEqual([
          {
            ...part,
            content: `${part.kind === "tool-call" ? "" : part.content} a b`,
            updatedAt: CHANGED_AT
          }
        ])
      })

      it("moves the conversation's activity time forward with each fragment", () => {
        const harness = createHarness()
        const part = createTextPart(1001, 0, "Hi")
        saveReplyWithParts(harness, [part])
        const beforeFragments = getActivityTime(harness)

        harness.replyPartRecordWriter.updateReplyPartContent({
          assistantMessageId: REPLY_ID,
          partId: part.id,
          content: " there",
          updatedAt: CHANGED_AT
        })

        expect(getActivityTime(harness)).toBeGreaterThan(beforeFragments)
      })

      it("returns false for a finalized reply and keeps the part", () => {
        const harness = createHarness()
        const part = createTextPart(1001, 0, "Done")
        saveReplyWithParts(harness, [part], "interrupted")

        expect(
          harness.replyPartRecordWriter.updateReplyPartContent({
            assistantMessageId: REPLY_ID,
            partId: part.id,
            content: " late",
            updatedAt: CHANGED_AT
          })
        ).toBe(false)
        expect(readReplyParts(harness)).toEqual([part])
      })

      it("returns false for a tool call and for another reply's part", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "running")
        saveReplyWithParts(harness, [call])
        saveConversationWithReply(harness, OTHER_CONVERSATION_ID, {
          sequence: 21,
          parts: [createTextPart(1021, 0, "Other")],
          status: "streaming",
          finishReason: null
        })

        for (const partId of [call.id, createFixtureUuidV7(1021)])
          expect(
            harness.replyPartRecordWriter.updateReplyPartContent({
              assistantMessageId: REPLY_ID,
              partId,
              content: " late",
              updatedAt: CHANGED_AT
            })
          ).toBe(false)
        expect(readReplyParts(harness)).toEqual([call])
      })
    })

    describe("updateReplyToolCall", () => {
      it("moves a waiting call to running and returns it, keeping the activity time", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "awaiting-approval")
        saveReplyWithParts(harness, [call])
        const activityTime = getActivityTime(harness)

        const updated = harness.replyPartRecordWriter.updateReplyToolCall({
          assistantMessageId: REPLY_ID,
          toolCallId: call.id,
          change: { status: "running" },
          updatedAt: CHANGED_AT
        })

        const running = { ...call, status: "running", updatedAt: CHANGED_AT }
        expect(updated).toEqual(running)
        expect(readReplyParts(harness)).toEqual([running])
        expect(getActivityTime(harness)).toBe(activityTime)
      })

      it("stores a waiting call's rejection as its result", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "awaiting-approval")
        saveReplyWithParts(harness, [call])

        const updated = harness.replyPartRecordWriter.updateReplyToolCall({
          assistantMessageId: REPLY_ID,
          toolCallId: call.id,
          change: { status: "rejected", result: "The person declined." },
          updatedAt: CHANGED_AT
        })

        expect(updated).toEqual({
          ...call,
          status: "rejected",
          result: "The person declined.",
          updatedAt: CHANGED_AT
        })
      })

      it("stores a running call's failure as its result", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "running")
        saveReplyWithParts(harness, [call])

        expect(
          harness.replyPartRecordWriter.updateReplyToolCall({
            assistantMessageId: REPLY_ID,
            toolCallId: call.id,
            change: { status: "failed", result: "Tavily is down." },
            updatedAt: CHANGED_AT
          })
        ).toEqual({
          ...call,
          status: "failed",
          result: "Tavily is down.",
          updatedAt: CHANGED_AT
        })
      })

      it("stores a running call's success with the numbers of its sources and the sources in the call's conversation", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "running")
        saveReplyWithParts(harness, [call])
        const kept = { number: 1, url: "https://kept.example/", title: "Kept" }
        harness.saveSource(CONVERSATION_ID, kept)
        const sources = [
          { number: 2, url: "https://new.example/", title: "New" },
          { ...kept, title: "Retitled" }
        ]

        const updated = harness.replyPartRecordWriter.updateReplyToolCall({
          assistantMessageId: REPLY_ID,
          toolCallId: call.id,
          change: { status: "succeeded", result: "Results", sources },
          updatedAt: CHANGED_AT
        })

        expect(updated).toEqual({
          ...call,
          status: "succeeded",
          result: "Results",
          sourceNumbers: [2, 1],
          updatedAt: CHANGED_AT
        })
        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.sources
        ).toEqual([kept, sources[0]])
        expect(getActivityTime(harness)).toBeGreaterThan(
          Date.parse("2025-01-01T00:00:01.000Z")
        )
      })

      it("stores an empty success without sources", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "running")
        saveReplyWithParts(harness, [call])

        expect(
          harness.replyPartRecordWriter.updateReplyToolCall({
            assistantMessageId: REPLY_ID,
            toolCallId: call.id,
            change: { status: "succeeded", result: "", sources: [] },
            updatedAt: CHANGED_AT
          })
        ).toEqual({
          ...call,
          status: "succeeded",
          result: "",
          updatedAt: CHANGED_AT
        })
      })

      it.each([
        [
          "running",
          "awaiting-approval" as const,
          { status: "succeeded", result: "x", sources: [] } as const
        ],
        [
          "running",
          "awaiting-approval" as const,
          { status: "failed", result: "x" } as const
        ],
        ["running", "running" as const, { status: "running" } as const],
        [
          "awaiting-approval",
          "running" as const,
          { status: "rejected", result: "x" } as const
        ]
      ])(
        "returns undefined for a change that does not follow the call's state (%s from %s)",
        (_label, status, change) => {
          const harness = createHarness()
          const call = createSearchCall(1001, status)
          saveReplyWithParts(harness, [call])

          expect(
            harness.replyPartRecordWriter.updateReplyToolCall({
              assistantMessageId: REPLY_ID,
              toolCallId: call.id,
              change,
              updatedAt: CHANGED_AT
            })
          ).toBeUndefined()
          expect(readReplyParts(harness)).toEqual([call])
        }
      )

      it("returns undefined for a finished call, a finalized reply, and an unknown call", () => {
        const harness = createHarness()
        const finished = createToolCallPart(
          {
            sequence: 1001,
            round: 0,
            toolName: "read_page",
            argumentText: "{}"
          },
          { status: "failed", result: "No" }
        )
        saveReplyWithParts(harness, [finished])
        const finalizedHarness = createHarness()
        const running = createSearchCall(1002, "running")
        saveReplyWithParts(finalizedHarness, [running], "interrupted")

        for (const [records, toolCallId] of [
          [harness, finished.id],
          [finalizedHarness, running.id],
          [harness, createFixtureUuidV7(9999)]
        ] as const)
          expect(
            records.replyPartRecordWriter.updateReplyToolCall({
              assistantMessageId: REPLY_ID,
              toolCallId,
              change: { status: "failed", result: "Late" },
              updatedAt: CHANGED_AT
            })
          ).toBeUndefined()
        expect(readReplyParts(harness)).toEqual([finished])
        expect(readReplyParts(finalizedHarness)).toEqual([running])
      })

      it("refuses a source whose number the conversation stores for another URL and changes nothing", () => {
        const harness = createHarness()
        const call = createSearchCall(1001, "running")
        saveReplyWithParts(harness, [call])
        const stored = { number: 1, url: "https://stored.example/", title: "A" }
        harness.saveSource(CONVERSATION_ID, stored)

        expect(() =>
          harness.replyPartRecordWriter.updateReplyToolCall({
            assistantMessageId: REPLY_ID,
            toolCallId: call.id,
            change: {
              status: "succeeded",
              result: "Results",
              sources: [
                { number: 1, url: "https://other.example/", title: "B" }
              ]
            },
            updatedAt: CHANGED_AT
          })
        ).toThrow()
        expect(readReplyParts(harness)).toEqual([call])
        expect(
          harness.recordReader.findConversation(CONVERSATION_ID)?.sources
        ).toEqual([stored])
      })
    })

    it("rejects every operation after the store closes", () => {
      const harness = createHarness()
      harness.closeRecords()

      expect(() =>
        harness.replyPartRecordWriter.createReplyPart({
          assistantMessageId: REPLY_ID,
          part: createTextPart(1001, 0, "Text")
        })
      ).toThrow("Database is closed")
      expect(() =>
        harness.replyPartRecordWriter.updateReplyPartContent({
          assistantMessageId: REPLY_ID,
          partId: createFixtureUuidV7(1001),
          content: "Text",
          updatedAt: CHANGED_AT
        })
      ).toThrow("Database is closed")
      expect(() =>
        harness.replyPartRecordWriter.updateReplyToolCall({
          assistantMessageId: REPLY_ID,
          toolCallId: createFixtureUuidV7(1001),
          change: { status: "running" },
          updatedAt: CHANGED_AT
        })
      ).toThrow("Database is closed")
    })
  })
}
