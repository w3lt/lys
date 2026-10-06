import { describe, expect, it } from "vitest"
import * as z from "zod"
import type {
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../../../../../src/infrastructure/database/databaseTransactions"
import { openSqliteAgentRecordStore } from "../../../support/agentDatabase"
import { registerAgentRecordStoreContractSuite } from "../../../support/agentRecordStoreContract"

/** Column values of one stored agent row, unchecked by the agent schemas. */
type AgentRow = Readonly<{
  /** Stored code. */
  code: string
  /** Stored name. */
  name: string
  /** Stored bio. */
  bio: string
  /** Stored system prompt. */
  systemPrompt: string
  /** Stored creation time, also stored as the change time. */
  createdAt: string
}>

/** Valid column values of a stored agent row; each case varies one field. */
const VALID_AGENT_ROW: AgentRow = Object.freeze({
  code: "lys",
  name: "Lys",
  bio: "Personal assistant.",
  systemPrompt: "You are Lys.",
  createdAt: "2026-01-02T03:04:05.678Z"
})

/**
 * Inserts one agent row as given inside the caller's write transaction,
 * bypassing the agent schemas.
 *
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param row - Stored column values.
 */
function insertAgentRow(
  statements: DatabaseStatementCompiler,
  row: AgentRow
): void {
  statements
    .getStatement(
      `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.code,
      row.name,
      row.bio,
      row.systemPrompt,
      row.createdAt,
      row.createdAt
    )
}

/**
 * Inserts one agent row as given in its own write transaction, bypassing the
 * agent schemas.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values.
 */
function saveAgentRow(database: DatabaseWriter, row: AgentRow): void {
  database.handleDatabaseWriteRequest((statements) => {
    insertAgentRow(statements, row)
  })
}

describe("SqliteAgentRecordStore", () => {
  registerAgentRecordStoreContractSuite(() => openSqliteAgentRecordStore())

  it("rejects a stored row that violates the agent contract and stays usable", () => {
    const records = openSqliteAgentRecordStore()
    saveAgentRow(records.database, { ...VALID_AGENT_ROW, code: "Not A Slug" })
    saveAgentRow(records.database, VALID_AGENT_ROW)

    expect(() => records.recordStore.findAgent("Not A Slug")).toThrow(
      z.ZodError
    )

    expect(records.recordStore.findAgent("lys")).toMatchObject({ name: "Lys" })
  })

  it.each([
    ["name", { name: " Lys " }],
    ["bio", { bio: "Personal assistant. " }],
    ["system prompt", { systemPrompt: "\nYou are Lys." }]
  ])(
    "rejects a stored %s with surrounding whitespace instead of trimming it",
    (_label, change) => {
      const records = openSqliteAgentRecordStore()
      saveAgentRow(records.database, { ...VALID_AGENT_ROW, ...change })

      expect(() => records.recordStore.findAgent("lys")).toThrow(z.ZodError)
    }
  )

  it.each([
    ["without milliseconds", "2026-01-02T03:04:05Z"],
    ["in another format", "2026-01-02 03:04:05.678"]
  ])("rejects a stored timestamp %s", (_label, createdAt) => {
    const records = openSqliteAgentRecordStore()
    saveAgentRow(records.database, { ...VALID_AGENT_ROW, createdAt })

    expect(() => records.recordStore.findAgent("lys")).toThrow(z.ZodError)
  })

  it("rejects a listed row that violates the agent contract and stays usable", () => {
    const records = openSqliteAgentRecordStore()
    saveAgentRow(records.database, { ...VALID_AGENT_ROW, name: " Lys " })

    expect(() =>
      records.recordStore.listAgents({ after: undefined, limit: 1 })
    ).toThrow(z.ZodError)

    expect(records.recordStore.deleteAgent("lys")).toBe(true)
    expect(
      records.recordStore.listAgents({ after: undefined, limit: 1 })
    ).toEqual({ agents: [], storedCount: 0, hasMore: false })
  })

  it("refuses record calls nested in another database operation and keeps its writes", () => {
    const records = openSqliteAgentRecordStore()
    const { recordStore } = records

    records.database.handleDatabaseWriteRequest((statements) => {
      insertAgentRow(statements, VALID_AGENT_ROW)
      expect(() =>
        recordStore.listAgents({ after: undefined, limit: 1 })
      ).toThrow("Database transactions cannot be nested")
      expect(() => recordStore.findAgent("lys")).toThrow(
        "Database transactions cannot be nested"
      )
      expect(() =>
        recordStore.createAgent({
          ...VALID_AGENT_ROW,
          code: "web-researcher",
          updatedAt: VALID_AGENT_ROW.createdAt
        })
      ).toThrow("Database transactions cannot be nested")
      expect(() =>
        recordStore.updateAgent({
          code: "lys",
          changes: { name: "Renamed" },
          updatedAt: "2026-02-03T04:05:06.789Z"
        })
      ).toThrow("Database transactions cannot be nested")
      expect(() => recordStore.deleteAgent("lys")).toThrow(
        "Database transactions cannot be nested"
      )
    })

    expect(recordStore.listAgents({ after: undefined, limit: 2 })).toEqual({
      agents: [
        {
          code: "lys",
          name: "Lys",
          bio: "Personal assistant.",
          createdAt: VALID_AGENT_ROW.createdAt,
          updatedAt: VALID_AGENT_ROW.createdAt
        }
      ],
      storedCount: 1,
      hasMore: false
    })
  })

  it("rolls an update back when the updated row violates the agent contract", () => {
    const records = openSqliteAgentRecordStore()
    saveAgentRow(records.database, {
      ...VALID_AGENT_ROW,
      createdAt: "yesterday"
    })

    expect(() =>
      records.recordStore.updateAgent({
        code: "lys",
        changes: { name: "Renamed" },
        updatedAt: "2026-02-03T04:05:06.789Z"
      })
    ).toThrow(z.ZodError)

    expect(
      records.database.handleDatabaseReadRequest((statements) =>
        statements
          .getStatement("SELECT name, updated_at FROM agents WHERE code = ?")
          .get("lys")
      )
    ).toEqual({ name: "Lys", updated_at: "yesterday" })
  })
})
