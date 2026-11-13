import { describe, expect, it } from "vitest"
import type { ToolCallReplyPart } from "@lys/share"
import SqliteToolSearchCallRecordWriter from "../../../../../src/infrastructure/database/conversations/sqliteToolSearchCallRecordWriter"
import type { ToolCallDecisionRecord } from "../../../../../src/modules/toolApproval/toolCallDecisionRecord"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import {
  createFixtureUuidV7,
  createToolCallPart
} from "../../../support/conversationFixtures"

/** Conversation the cases store. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Streaming reply holding the search's `find_tools` call. */
const REPLY_ID = createFixtureUuidV7(11)

/** The search's `find_tools` call. */
const FIND_TOOLS_CALL = createToolCallPart(
  {
    sequence: 21,
    round: 0,
    toolName: "find_tools",
    argumentText: '{"task":"read a web page"}'
  },
  { status: "running" }
)

/** A call of the search's reply, as kept running. */
const SEARCH_CALL = createToolCallPart(
  {
    sequence: 31,
    round: 0,
    toolName: "search_tools",
    argumentText: '{"query":"web page"}'
  },
  { status: "running" }
)

/** Decision of a call the policy allowed. */
const ALLOWED: ToolCallDecisionRecord = Object.freeze({
  policyDecision: Object.freeze({ effect: "allow" }),
  approvalMode: undefined
})

/** Time a call's change is stored at. */
const CHANGED_AT = "2026-01-03T00:00:00.000Z"

/**
 * Opens records holding conversation {@link CONVERSATION_ID} of agent
 * `caliginia`, whose reply {@link REPLY_ID} holds the `find_tools` call in
 * the given state, and a writer over the same database.
 *
 * @param findToolsCall - The `find_tools` call as stored.
 * @returns The records, their database, and the writer.
 */
function openWriter(findToolsCall: ToolCallReplyPart = FIND_TOOLS_CALL) {
  const records = openSqliteConversationRecords()
  records.saveConversation({
    id: CONVERSATION_ID,
    title: null,
    agentCode: "caliginia",
    createdAt: "2025-01-01T00:00:00.000Z"
  })
  records.saveAssistantMessage({
    id: REPLY_ID,
    conversationId: CONVERSATION_ID,
    model: "qwen/qwen3-8b",
    parts: [findToolsCall],
    status: "streaming",
    finishReason: null,
    createdAt: "2025-01-01T00:00:01.000Z",
    updatedAt: "2025-01-01T00:00:01.000Z"
  })
  const writer = new SqliteToolSearchCallRecordWriter(records.database)
  /**
   * Reads every stored search call record.
   *
   * @returns Each record's columns by name, ordered by call.
   */
  const readRows = (): Record<string, unknown>[] =>
    records.database.handleDatabaseReadRequest((statements) =>
      statements
        .getStatement(
          `SELECT call_id AS callId, search_call_id AS searchCallId,
          conversation_id AS conversationId, agent_code AS agentCode,
          tool_name AS toolName, argument_text AS argumentText,
          policy_effect AS policyEffect, policy_reason AS policyReason,
          outcome, created_at AS createdAt, updated_at AS updatedAt
          FROM tool_search_call_decisions ORDER BY call_id`
        )
        .all()
    )
  return { records, writer, readRows }
}

/**
 * Builds the input recording {@link SEARCH_CALL} or another call.
 *
 * @param call - The kept call.
 * @param decision - How it was decided.
 * @returns The input under the search's `find_tools` call and Armitage.
 */
function buildInput(
  call: ToolCallReplyPart = SEARCH_CALL,
  decision: ToolCallDecisionRecord = ALLOWED
) {
  return {
    searchCallId: FIND_TOOLS_CALL.id,
    agentCode: "armitage",
    call,
    decision
  }
}

describe("SqliteToolSearchCallRecordWriter", () => {
  it("records a kept call under its search's find_tools call, with the conversation of that call, the tool, the argument text, and the policy's decision", () => {
    const { writer, readRows } = openWriter()
    const denied = createToolCallPart(
      {
        sequence: 32,
        round: 1,
        toolName: "recommend_tool",
        argumentText: '{"name":"read_page"}'
      },
      { status: "failed", result: "Denied." }
    )
    const unchecked = createToolCallPart(
      { sequence: 33, round: 1, toolName: "nope", argumentText: "{}" },
      { status: "failed", result: "Unknown tool." }
    )

    expect(writer.createToolSearchCallRecord(buildInput())).toBe(true)
    expect(
      writer.createToolSearchCallRecord(
        buildInput(denied, {
          policyDecision: { effect: "deny", reason: "credential-file" },
          approvalMode: undefined
        })
      )
    ).toBe(true)
    expect(
      writer.createToolSearchCallRecord(
        buildInput(unchecked, {
          policyDecision: undefined,
          approvalMode: undefined
        })
      )
    ).toBe(true)

    expect(readRows()).toEqual([
      {
        callId: SEARCH_CALL.id,
        searchCallId: FIND_TOOLS_CALL.id,
        conversationId: CONVERSATION_ID,
        agentCode: "armitage",
        toolName: "search_tools",
        argumentText: '{"query":"web page"}',
        policyEffect: "allow",
        policyReason: null,
        outcome: "running",
        createdAt: SEARCH_CALL.createdAt,
        updatedAt: SEARCH_CALL.updatedAt
      },
      expect.objectContaining({
        callId: denied.id,
        toolName: "recommend_tool",
        policyEffect: "deny",
        policyReason: "credential-file",
        outcome: "failed"
      }),
      expect.objectContaining({
        callId: unchecked.id,
        policyEffect: null,
        policyReason: null,
        outcome: "failed"
      })
    ])
  })

  it("refuses a record, changing nothing, when the find_tools call is not stored or no longer runs", () => {
    const ended = openWriter({
      ...FIND_TOOLS_CALL,
      status: "succeeded",
      result: "Found.",
      sourceNumbers: []
    })
    const missing = openWriter()

    expect(ended.writer.createToolSearchCallRecord(buildInput())).toBe(false)
    expect(
      missing.writer.createToolSearchCallRecord({
        ...buildInput(),
        searchCallId: createFixtureUuidV7(99)
      })
    ).toBe(false)
    expect(ended.readRows()).toEqual([])
    expect(missing.readRows()).toEqual([])
  })

  it("throws, changing nothing, for a call or decision a search's call cannot have", () => {
    const { writer, readRows } = openWriter()
    const waiting: ToolCallReplyPart = {
      ...SEARCH_CALL,
      status: "awaiting-approval"
    }
    const failures = {
      approvalMode: () =>
        writer.createToolSearchCallRecord(
          buildInput(SEARCH_CALL, {
            policyDecision: { effect: "allow" },
            approvalMode: "just-run"
          })
        ),
      waiting: () => writer.createToolSearchCallRecord(buildInput(waiting)),
      requireApproval: () =>
        writer.createToolSearchCallRecord(
          buildInput(SEARCH_CALL, {
            policyDecision: {
              effect: "require-approval",
              reason: "destructive-tool"
            },
            approvalMode: undefined
          })
        )
    }

    expect(failures.approvalMode).toThrow("never reaches the approval gate")
    expect(failures.waiting).toThrow("cannot be kept awaiting-approval")
    expect(failures.requireApproval).toThrow(/constraint failed/)
    expect(readRows()).toEqual([])
    writer.createToolSearchCallRecord(buildInput())
    expect(() => writer.createToolSearchCallRecord(buildInput())).toThrow(
      /constraint failed/
    )
  })

  it("stores how a recorded running call ended, once", () => {
    const { writer, readRows } = openWriter()
    writer.createToolSearchCallRecord(buildInput())
    const succeeded: ToolCallReplyPart = {
      ...SEARCH_CALL,
      status: "succeeded",
      result: "read_page reads a web page.",
      sourceNumbers: [],
      updatedAt: CHANGED_AT
    }

    expect(writer.updateToolSearchCallOutcome(succeeded)).toBe(true)
    expect(
      writer.updateToolSearchCallOutcome({
        ...SEARCH_CALL,
        status: "failed",
        result: "Late."
      })
    ).toBe(false)

    expect(readRows()).toMatchObject([
      { outcome: "succeeded", updatedAt: CHANGED_AT }
    ])
  })

  it("refuses an outcome for a call that is not recorded or was interrupted, and throws for a status no run ends with", () => {
    const { records, writer, readRows } = openWriter()
    writer.createToolSearchCallRecord(buildInput())
    const failed: ToolCallReplyPart = {
      ...SEARCH_CALL,
      status: "failed",
      result: "Stopped.",
      updatedAt: CHANGED_AT
    }
    records.database.handleDatabaseWriteRequest((statements) =>
      statements
        .getStatement(
          "UPDATE conversation_messages SET status = 'interrupted' WHERE id = ?"
        )
        .run(FIND_TOOLS_CALL.id)
    )

    expect(writer.updateToolSearchCallOutcome(failed)).toBe(false)
    expect(
      writer.updateToolSearchCallOutcome({
        ...failed,
        id: createFixtureUuidV7(98)
      })
    ).toBe(false)
    expect(() => writer.updateToolSearchCallOutcome(SEARCH_CALL)).toThrow(
      "cannot end running"
    )
    expect(readRows()).toMatchObject([{ outcome: "interrupted" }])
  })

  it("fails every write once the database is closed", () => {
    const { records, writer } = openWriter()
    records.closeRecords()

    expect(() => writer.createToolSearchCallRecord(buildInput())).toThrow(
      "Database is closed"
    )
    expect(() =>
      writer.updateToolSearchCallOutcome({
        ...SEARCH_CALL,
        status: "failed",
        result: "Closed."
      })
    ).toThrow("Database is closed")
  })
})
