import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { DatabaseWriter } from "../../../../../src/infrastructure/database/databaseTransactions"
import { openSqliteAgentRecordStore } from "../../../support/agentDatabase"
import { registerAgentRecordStoreContractSuite } from "../../../support/agentRecordStoreContract"

/**
 * Inserts one agent row as given, bypassing the agent schemas, with fixed
 * name, bio, and system prompt.
 *
 * @param database - Write access to a migrated test database.
 * @param code - Stored code.
 * @param createdAt - Stored creation and change time.
 */
function saveAgentRow(
  database: DatabaseWriter,
  code: string,
  createdAt: string
): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
        VALUES (?, 'Lys', 'Personal assistant.', 'You are Lys.', ?, ?)`
      )
      .run(code, createdAt, createdAt)
  })
}

describe("SqliteAgentRecordStore", () => {
  registerAgentRecordStoreContractSuite(() => openSqliteAgentRecordStore())

  it("rejects a stored row that violates the agent contract", () => {
    const records = openSqliteAgentRecordStore()
    saveAgentRow(records.database, "Not A Slug", "2026-01-02T03:04:05.678Z")

    expect(() => records.recordStore.findAgent("Not A Slug")).toThrow(
      z.ZodError
    )
  })

  it("rolls an update back when the updated row violates the agent contract", () => {
    const records = openSqliteAgentRecordStore()
    saveAgentRow(records.database, "lys", "yesterday")

    expect(() =>
      records.recordStore.updateAgent(
        { code: "lys", name: "Renamed" },
        "2026-02-03T04:05:06.789Z"
      )
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
