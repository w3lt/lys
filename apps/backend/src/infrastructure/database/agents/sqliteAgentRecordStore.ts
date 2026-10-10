import * as z from "zod"
import { agentSummarySchema } from "@lys/protocol"
import { agentSchema, type Agent } from "@lys/share"
import type {
  AgentPage,
  AgentRecordStore,
  ListAgentsInput,
  UpdateAgentInput
} from "../../../modules/agent/records"
import type {
  DatabaseReader,
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"

/** Validates the number of stored agents read with a list page. */
const agentCountSchema = z.strictObject({
  storedCount: z.int().nonnegative()
})

/** Validates the listed rows of one page, freezing the page. */
const agentSummaryRowsSchema = z.array(agentSummarySchema).readonly()

/**
 * Reads the agent count and one page of summaries inside the caller's read
 * transaction.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Boundary after which the page starts and its size.
 * @returns The validated page and whether more agents follow it.
 * @throws If SQLite fails or a listed row violates the agent schema.
 */
function listAgents(
  statements: DatabaseStatementCompiler,
  input: ListAgentsInput
): AgentPage {
  const { storedCount } = agentCountSchema.parse(
    statements.getStatement("SELECT count(*) AS storedCount FROM agents").get()
  )
  const rows = statements
    .getStatement(
      `SELECT code, name, bio, created_at AS createdAt, updated_at AS updatedAt
      FROM agents
      WHERE $createdAt IS NULL OR created_at > $createdAt
        OR (created_at = $createdAt AND code > $code)
      ORDER BY created_at, code LIMIT $limit`
    )
    .all({
      createdAt: input.after?.createdAt ?? null,
      code: input.after?.code ?? null,
      limit: input.limit + 1
    })
  return {
    agents: agentSummaryRowsSchema.parse(rows.slice(0, input.limit)),
    storedCount,
    hasMore: rows.length > input.limit
  }
}

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
 * Inserts one new agent inside the caller's write transaction, leaving a
 * stored agent with the same code untouched.
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param agent - Validated agent, stored exactly as given.
 * @returns True when the agent was inserted; false when its code is taken.
 * @throws If SQLite fails.
 */
function insertAgent(
  statements: DatabaseStatementCompiler,
  agent: Agent
): boolean {
  const result = statements
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
    )
  return result.changes === 1
}

/**
 * Applies one agent change inside the caller's write transaction.
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param input - Code, the fields to replace (an omitted field keeps its
 * stored value), and the time stored as the agent's last change.
 * @returns The changed agent, or undefined when no agent has the code.
 * @throws If SQLite fails or the changed row violates the agent schema; the
 * row is validated before the caller's transaction commits, so either failure
 * rolls the change back.
 */
function updateAgent(
  statements: DatabaseStatementCompiler,
  input: UpdateAgentInput
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
      input.changes.name ?? null,
      input.changes.bio ?? null,
      input.changes.systemPrompt ?? null,
      input.updatedAt,
      input.code
    )
  return row === undefined ? undefined : agentSchema.parse(row)
}

/**
 * Borrows the shared database's read snapshots and write transactions to keep
 * stored agent definitions.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each listing or
 * lookup is one read snapshot and each change one write transaction that commits before it
 * returns. Concurrency model: single-owner, synchronous on the backend's event
 * loop. Implements {@link AgentRecordStore}.
 */
export default class SqliteAgentRecordStore implements AgentRecordStore {
  /** Borrowed read snapshots for agent listings and lookups. */
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
   * Implements {@link AgentRecordStore.listAgents} in one read snapshot, so
   * the count and the page agree.
   * @param input - Interface-defined boundary and page size.
   * @returns The interface-defined page.
   * @throws The interface-defined closed and validation failures.
   */
  public listAgents(input: ListAgentsInput): AgentPage {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      listAgents(statements, input)
    )
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
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      insertAgent(statements, agent)
    )
  }

  /**
   * Implements {@link AgentRecordStore.updateAgent} with one
   * `UPDATE … RETURNING` statement.
   * @param input - Interface-defined code, change, and change time.
   * @returns The interface-defined agent or absence.
   * @throws The interface-defined failures; the returned row is validated
   * before the change commits, so an invalid row rolls the change back.
   */
  public updateAgent(input: UpdateAgentInput): Agent | undefined {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      updateAgent(statements, input)
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
