import type { AgentRecordStore } from "../../../di/services/agentService/records"
import {
  agentSchema,
  type Agent,
  type AgentUpdate
} from "../../../modules/agent/agent"
import type {
  DatabaseReader,
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"

/**
 * Reads one agent inside the caller's transaction.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param code - Code to look up, compared exactly.
 * @returns The validated agent, or undefined when no agent has the code.
 * @throws If SQLite fails or the row violates the agent schema.
 */
function findAgent(
  statements: DatabaseStatementCompiler,
  code: string
): Agent | undefined {
  const row = statements
    .getStatement(
      `SELECT code, name, bio, system_prompt AS systemPrompt,
      created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE code = ?`
    )
    .get(code)
  return row === undefined ? undefined : agentSchema.parse(row)
}

/**
 * Applies one agent change inside the caller's write transaction.
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param update - Code and the fields to replace; an omitted field keeps its
 * stored value.
 * @param updatedAt - Time stored as the agent's last change.
 * @returns The changed agent, or undefined when no agent has the code.
 * @throws If SQLite fails or the changed row violates the agent schema; the
 * row is validated before the caller's transaction commits, so either failure
 * rolls the change back.
 */
function updateAgent(
  statements: DatabaseStatementCompiler,
  update: AgentUpdate,
  updatedAt: string
): Agent | undefined {
  const row = statements
    .getStatement(
      `UPDATE agents SET name = coalesce(?, name), bio = coalesce(?, bio),
      system_prompt = coalesce(?, system_prompt), updated_at = ?
      WHERE code = ?
      RETURNING code, name, bio, system_prompt AS systemPrompt,
      created_at AS createdAt, updated_at AS updatedAt`
    )
    .get(
      update.name ?? null,
      update.bio ?? null,
      update.systemPrompt ?? null,
      updatedAt,
      update.code
    )
  return row === undefined ? undefined : agentSchema.parse(row)
}

/**
 * Borrows the shared database's read snapshots and write transactions to keep
 * stored agent definitions.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each lookup is one
 * read snapshot and each change one write transaction that commits before it
 * returns. Concurrency model: single-owner, synchronous on the backend's event
 * loop. Implements {@link AgentRecordStore}.
 */
export default class SqliteAgentRecordStore implements AgentRecordStore {
  /** Borrowed read snapshots for agent lookups. */
  readonly #databaseReader: DatabaseReader

  /** Borrowed write transactions for agent creation, changes, and deletion. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed database access without performing database work.
   * @param database - Read snapshots and write transactions lent by the
   * database owner.
   */
  public constructor(database: DatabaseReader & DatabaseWriter) {
    this.#databaseReader = database
    this.#databaseWriter = database
  }

  /**
   * Implements {@link AgentRecordStore.findAgent} in one read snapshot.
   * @param code - Interface-defined code.
   * @returns The interface-defined agent or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public findAgent(code: string): Agent | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      findAgent(statements, code)
    )
  }

  /**
   * Implements {@link AgentRecordStore.createAgent} with one insert that
   * leaves a stored agent with the same code untouched.
   * @param agent - Interface-defined agent.
   * @returns The interface-defined creation outcome.
   * @throws The interface-defined failures.
   */
  public createAgent(agent: Agent): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(
            `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`
          )
          .run(
            agent.code,
            agent.name,
            agent.bio,
            agent.systemPrompt,
            agent.createdAt,
            agent.updatedAt
          ).changes === 1
    )
  }

  /**
   * Implements {@link AgentRecordStore.updateAgent} with one
   * `UPDATE … RETURNING` statement.
   * @param update - Interface-defined change.
   * @param updatedAt - Interface-defined change time.
   * @returns The interface-defined agent or absence.
   * @throws The interface-defined failures; the returned row is validated
   * before the change commits, so an invalid row rolls the change back.
   */
  public updateAgent(
    update: AgentUpdate,
    updatedAt: string
  ): Agent | undefined {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      updateAgent(statements, update, updatedAt)
    )
  }

  /**
   * Implements {@link AgentRecordStore.deleteAgent}.
   * @param code - Interface-defined code.
   * @returns The interface-defined deletion outcome.
   * @throws The interface-defined failures.
   */
  public deleteAgent(code: string): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements.getStatement("DELETE FROM agents WHERE code = ?").run(code)
          .changes === 1
    )
  }
}
