import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import type { ReplyPart, ToolCallReplyPart } from "@lys/share"
import type { ToolCallDecisionRecord } from "../../../../../src/modules/toolApproval/toolCallDecisionRecord"
import {
  openSqliteConversationRecords,
  readToolCallDecisionRows
} from "../../../support/conversationDatabase"
import {
  ASK_ME_TOOL_CALL_DECISION,
  createFixtureUuidV7,
  createTextPart,
  createToolCallPart
} from "../../../support/conversationFixtures"
import { registerReplyPartRecordWriterContractSuite } from "../../../support/conversationRecordsContract"

/** Conversation the cases store. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Streaming reply the cases append to. */
const REPLY_ID = createFixtureUuidV7(11)

/** Time a call's change is stored at. */
const CHANGED_AT = "2026-01-03T00:00:00.000Z"

/**
 * Opens records holding conversation {@link CONVERSATION_ID} of agent `lys`
 * with its reply {@link REPLY_ID}.
 *
 * @param status - The reply's status.
 * @param parts - Parts stored with the reply, row by row, without decision
 * records.
 * @returns The records over their own in-memory database.
 */
function openRecordsWithReply(
  status: "streaming" | "interrupted" = "streaming",
  parts: readonly ReplyPart[] = []
) {
  const records = openSqliteConversationRecords()
  records.saveConversation({
    id: CONVERSATION_ID,
    title: null,
    agentCode: "lys",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  records.saveAssistantMessage({
    id: REPLY_ID,
    conversationId: CONVERSATION_ID,
    model: "qwen/qwen3-8b",
    parts,
    status,
    finishReason: null,
    createdAt: "2025-01-01T00:00:01.000Z",
    updatedAt: "2025-01-01T00:00:01.000Z"
  })
  return records
}

/**
 * Creates a delete_file call of the reply in one state.
 *
 * @param state - Its status and, when it ended, its result.
 * @returns The call, created at the fixture time.
 */
function createDeleteCall(
  state: Parameters<typeof createToolCallPart>[1]
): ToolCallReplyPart {
  return createToolCallPart(
    { sequence: 12, round: 0, toolName: "delete_file", argumentText: "{}" },
    state
  )
}

/**
 * Creates a database file location in a directory owned by the current test.
 *
 * @returns An absolute path whose directory is removed when the test finishes.
 */
function createOwnedDatabaseFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lys-reply-part-records-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, "lys_db.sqlite")
}

describe("SqliteReplyPartRecordWriter", () => {
  registerReplyPartRecordWriterContractSuite(() =>
    openSqliteConversationRecords()
  )

  it("commits each fragment before returning, visible to another connection", () => {
    const databaseFilePath = createOwnedDatabaseFilePath()
    const records = openSqliteConversationRecords(databaseFilePath)
    records.saveConversation({
      id: CONVERSATION_ID,
      title: null,
      agentCode: "lys",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
    const part = createTextPart({ sequence: 12, round: 0, content: "Hel" })
    records.saveAssistantMessage({
      id: REPLY_ID,
      conversationId: CONVERSATION_ID,
      model: "qwen/qwen3-8b",
      parts: [part],
      status: "streaming",
      finishReason: null,
      createdAt: "2025-01-01T00:00:01.000Z",
      updatedAt: "2025-01-01T00:00:01.000Z"
    })
    const observer = new DatabaseSync(databaseFilePath)
    onTestFinished(() => {
      observer.close()
    })
    const getStoredContent = () =>
      observer
        .prepare("SELECT content FROM conversation_messages WHERE id = ?")
        .get(part.id)

    records.replyPartRecordWriter.updateReplyPartContent({
      assistantMessageId: REPLY_ID,
      partId: part.id,
      content: "lo",
      updatedAt: "2026-01-03T00:00:00.000Z"
    })
    expect(getStoredContent()).toEqual({ content: "Hello" })

    records.replyPartRecordWriter.updateReplyPartContent({
      assistantMessageId: REPLY_ID,
      partId: part.id,
      content: "!",
      updatedAt: "2026-01-03T00:00:01.000Z"
    })
    expect(getStoredContent()).toEqual({ content: "Hello!" })
  })

  it.each(
    Object.entries({
      "failed by Lys's own checks": {
        decision: { policyDecision: undefined, approvalMode: undefined },
        state: { status: "failed", result: "No tool is named delete_file." },
        columns: { policyEffect: null, policyReason: null, approvalMode: null }
      },
      "denied by the policy": {
        decision: {
          policyDecision: { effect: "deny", reason: "credential-file" },
          approvalMode: undefined
        },
        state: { status: "failed", result: "Denied." },
        columns: {
          policyEffect: "deny",
          policyReason: "credential-file",
          approvalMode: null
        }
      },
      "the policy requires approval for": {
        decision: {
          policyDecision: {
            effect: "require-approval",
            reason: "destructive-tool"
          },
          approvalMode: "just-run"
        },
        state: { status: "awaiting-approval" },
        columns: {
          policyEffect: "require-approval",
          policyReason: "destructive-tool",
          approvalMode: "just-run"
        }
      },
      "allowed without the gate": {
        decision: {
          policyDecision: { effect: "allow" },
          approvalMode: undefined
        },
        state: { status: "running" },
        columns: {
          policyEffect: "allow",
          policyReason: null,
          approvalMode: null
        }
      }
    } satisfies Record<
      string,
      {
        decision: ToolCallDecisionRecord
        state: Parameters<typeof createToolCallPart>[1]
        columns: Record<string, unknown>
      }
    >)
  )(
    "stores the decision record of a call %s with the call, under its conversation's agent",
    (_label, { decision, state, columns }) => {
      const records = openRecordsWithReply()
      const call = createDeleteCall(state)

      records.replyPartRecordWriter.createReplyPart({
        assistantMessageId: REPLY_ID,
        part: call,
        toolCallDecision: decision
      })

      expect(readToolCallDecisionRows(records.database)).toEqual([
        {
          callId: call.id,
          conversationId: CONVERSATION_ID,
          agentCode: "lys",
          toolName: "delete_file",
          ...columns,
          answer: null,
          outcome: state.status,
          createdAt: call.createdAt,
          updatedAt: call.updatedAt
        }
      ])
    }
  )

  it("records the person's allowing a waiting call, then each outcome of the call", () => {
    const records = openRecordsWithReply()
    const call = createDeleteCall({ status: "awaiting-approval" })
    records.replyPartRecordWriter.createReplyPart({
      assistantMessageId: REPLY_ID,
      part: call,
      toolCallDecision: ASK_ME_TOOL_CALL_DECISION
    })
    const update = (
      change: Parameters<
        typeof records.replyPartRecordWriter.updateReplyToolCall
      >[0]["change"]
    ) =>
      records.replyPartRecordWriter.updateReplyToolCall({
        assistantMessageId: REPLY_ID,
        toolCallId: call.id,
        change,
        updatedAt: CHANGED_AT
      })

    update({ status: "running" })
    expect(readToolCallDecisionRows(records.database)).toMatchObject([
      { answer: "allowed", outcome: "running", updatedAt: CHANGED_AT }
    ])

    update({ status: "succeeded", result: "Deleted.", sources: [] })
    expect(readToolCallDecisionRows(records.database)).toMatchObject([
      { answer: "allowed", outcome: "succeeded", updatedAt: CHANGED_AT }
    ])
  })

  it.each(["declined", "showFailed"] as const)(
    "records a waiting call's rejection with its reason %s",
    (reason) => {
      const records = openRecordsWithReply()
      const call = createDeleteCall({ status: "awaiting-approval" })
      records.replyPartRecordWriter.createReplyPart({
        assistantMessageId: REPLY_ID,
        part: call,
        toolCallDecision: ASK_ME_TOOL_CALL_DECISION
      })

      records.replyPartRecordWriter.updateReplyToolCall({
        assistantMessageId: REPLY_ID,
        toolCallId: call.id,
        change: { status: "rejected", result: "Not allowed.", reason },
        updatedAt: CHANGED_AT
      })

      expect(readToolCallDecisionRows(records.database)).toMatchObject([
        { answer: reason, outcome: "rejected", updatedAt: CHANGED_AT }
      ])
    }
  )

  it("changes a call stored without a decision record and records nothing for it", () => {
    const call = createDeleteCall({ status: "awaiting-approval" })
    const records = openRecordsWithReply("streaming", [call])

    expect(
      records.replyPartRecordWriter.updateReplyToolCall({
        assistantMessageId: REPLY_ID,
        toolCallId: call.id,
        change: { status: "running" },
        updatedAt: CHANGED_AT
      })
    ).toMatchObject({ status: "running" })
    expect(readToolCallDecisionRows(records.database)).toEqual([])
  })

  it.each(
    Object.entries({
      "a tool call without its decision": {
        part: createDeleteCall({ status: "running" }),
        toolCallDecision: undefined
      },
      "a text part with a decision": {
        part: createTextPart({ sequence: 12, round: 0, content: "Hi" }),
        toolCallDecision: ASK_ME_TOOL_CALL_DECISION
      }
    })
  )("refuses %s and stores nothing", (_label, input) => {
    const records = openRecordsWithReply()

    expect(() =>
      records.replyPartRecordWriter.createReplyPart({
        assistantMessageId: REPLY_ID,
        ...input
      })
    ).toThrow("A tool call is stored with its decision")
    expect(
      records.recordReader.findConversation(CONVERSATION_ID)?.messages
    ).toMatchObject([{ id: REPLY_ID, parts: [] }])
    expect(readToolCallDecisionRows(records.database)).toEqual([])
  })

  it("stores no decision record for a call the finalized reply refuses", () => {
    const records = openRecordsWithReply("interrupted")

    expect(
      records.replyPartRecordWriter.createReplyPart({
        assistantMessageId: REPLY_ID,
        part: createDeleteCall({ status: "running" }),
        toolCallDecision: ASK_ME_TOOL_CALL_DECISION
      })
    ).toBe(false)
    expect(readToolCallDecisionRows(records.database)).toEqual([])
  })
})
