import * as z from "zod"
import { agentSummarySchema } from "@lys/protocol"
import { agentSchema, type Agent } from "@lys/share"
import type {
  AgentPage,
  AgentRecordSearcher,
  AgentRecordStore,
  ListAgentsInput,
  SearchAgentsInput,
  StoredAgentMatch,
  StoredAgentRecord,
  StoredAgentSearchPage,
  UpdateAgentInput
} from "../../../modules/agent/records"
import type {
  DatabaseFunctionRegistry,
  DatabaseReader,
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"
import { registerSearchFunctions } from "../searchFunctions"

/** Validates the number of stored agents read with a list page. */
const agentCountSchema = z.strictObject({
  storedCount: z.int().nonnegative()
})

/** Validates the listed rows of one page, freezing the page. */
const agentSummaryRowsSchema = z.array(agentSummarySchema).readonly()

/**
 * Validates one stored agent row with its deletion time, freezing the
 * record.
 */
const storedAgentRecordSchema = z
  .strictObject({
    /** The agent's own columns, as the agent schema stores them. */
    agent: agentSchema,
    /** Deletion time in the stored format; null while not deleted. */
    deletedAt: z.iso.datetime({ precision: 3 }).nullable()
  })
  .readonly()

/** Validates the number of stored agents that match a search. */
const agentMatchCountSchema = z.strictObject({
  matchCount: z.int().nonnegative()
})

/** Validates one matched row: the agent summary and two search columns. */
const agentMatchRowSchema = z.strictObject({
  ...agentSummarySchema.unwrap().shape,
  /** Deletion time in the stored format; null while not deleted. */
  deletedAt: z.iso.datetime({ precision: 3 }).nullable(),
  /** SQLite truth value of whether the code or name equals the query. */
  isExactMatch: z.literal([0, 1])
})

/**
 * Condition under which an agent matches the bound `$query`; requires the
 * `contains_search` function on the connection.
 */
const AGENT_MATCH_SQL = `contains_search(code, $query)
  OR contains_search(name, $query) OR contains_search(bio, $query)`

/**
 * Value of whether an agent's code or name equals the bound `$query`,
 * ignoring case: the same number of characters and a case-insensitive
 * match mean the whole text matches.
 */
const AGENT_EXACT_MATCH_SQL = `(length(code) = length($query)
  AND contains_search(code, $query))
  OR (length(name) = length($query) AND contains_search(name, $query))`

/**
 * Builds the frozen match of one validated row.
 * @param row - Matched row read by {@link searchAgents}.
 * @returns The match, its agent summary frozen.
 */
function buildAgentMatch(
  row: z.infer<typeof agentMatchRowSchema>
): StoredAgentMatch {
  const { deletedAt, isExactMatch, ...agent } = row
  return Object.freeze({
    agent: agentSummarySchema.parse(agent),
    deletedAt,
    isExactMatch: isExactMatch === 1
  })
}

/**
 * Reads the match count and the first matches of one search inside the
 * caller's read transaction.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Search text and the number of matches to read.
 * @returns The frozen page: matches whose code or name equals the query
 * first, then the others, each group by creation time and code.
 * @throws If SQLite fails or a matched row violates the agent schema.
 * @remarks Requires the `contains_search` function on the connection.
 */
function searchAgents(
  statements: DatabaseStatementCompiler,
  input: SearchAgentsInput
): StoredAgentSearchPage {
  const { matchCount } = agentMatchCountSchema.parse(
    statements
      .getStatement(
        `SELECT count(*) AS matchCount FROM agents WHERE ${AGENT_MATCH_SQL}`
      )
      .get({ query: input.query })
  )
  const rows = statements
    .getStatement(
      `SELECT code, name, bio, created_at AS createdAt, updated_at AS updatedAt,
      deleted_at AS deletedAt, ${AGENT_EXACT_MATCH_SQL} AS isExactMatch
      FROM agents WHERE ${AGENT_MATCH_SQL}
      ORDER BY isExactMatch DESC, created_at, code LIMIT $limit`
    )
    .all({ query: input.query, limit: input.limit })
  return Object.freeze({
    matches: Object.freeze(
      rows.map((row) => buildAgentMatch(agentMatchRowSchema.parse(row)))
    ),
    matchCount
  })
}

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
    statements
      .getStatement(
        "SELECT count(*) AS storedCount FROM agents WHERE deleted_at IS NULL"
      )
      .get()
  )
  const rows = statements
    .getStatement(
      `SELECT code, name, bio, created_at AS createdAt, updated_at AS updatedAt
      FROM agents
      WHERE deleted_at IS NULL AND ($createdAt IS NULL
        OR created_at > $createdAt
        OR (created_at = $createdAt AND code > $code))
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
 * Reads one agent, deleted or not, inside the caller's transaction.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param code - Code to look up, compared exactly.
 * @returns The validated, frozen record with the agent's deletion time, or
 * undefined when no agent has the code.
 * @throws If SQLite fails, the row violates the agent schema, or its
 * deletion time is not in the stored format.
 */
function findAgent(
  statements: DatabaseStatementCompiler,
  code: string
): StoredAgentRecord | undefined {
  const row = statements
    .getStatement(
      `SELECT code, name, bio, system_prompt AS systemPrompt,
      created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
      FROM agents WHERE code = ?`
    )
    .get(code)
  if (row === undefined) return undefined
  const { deletedAt, ...agent } = row
  return storedAgentRecordSchema.parse({ agent, deletedAt })
}

/**
 * Inserts one new agent inside the caller's write transaction, leaving a
 * stored agent with the same code untouched.
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param agent - Validated agent, stored exactly as given.
 * @returns True when the agent was inserted; false when its code is taken,
 * by a deleted agent too.
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
 * @returns The changed agent, or undefined when no agent that is not deleted
 * has the code.
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
      WHERE code = ? AND deleted_at IS NULL
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
 * @remarks Invariant: once created, `contains_search` is registered on the
 * shared connection for its search queries. Owns no resource: the database's
 * owner closes the connection, after which every operation fails with
 * `Database is closed`. Each listing, search, or lookup is one read snapshot
 * and each change one write transaction that commits before it returns.
 * Concurrency model: single-owner, synchronous on the backend's event loop.
 * Implements {@link AgentRecordStore} and {@link AgentRecordSearcher}.
 */
export default class SqliteAgentRecordStore
  implements AgentRecordStore, AgentRecordSearcher
{
  /** Borrowed read snapshots for agent listings and lookups. */
  readonly #databaseReader: DatabaseReader

  /** Borrowed write transactions for agent creation, changes, and deletion. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed database access prepared by
   * {@link SqliteAgentRecordStore.create}.
   * @param database - Read snapshots and write transactions lent by the
   * database owner.
   */
  private constructor(database: DatabaseReader & DatabaseWriter) {
    this.#databaseReader = database
    this.#databaseWriter = database
  }

  /**
   * Registers agent search on the shared connection and publishes the agent
   * records.
   * @param database - Read snapshots, write transactions, and function
   * registration lent by the database owner; the records retain only the
   * snapshots and transactions.
   * @returns The ready records; they own nothing to release.
   * @throws If the database is closed or SQLite rejects the registration.
   * @remarks Registers the shared search functions, among them
   * `contains_search`, the case-insensitive match agent search uses.
   */
  public static create(
    database: DatabaseReader & DatabaseWriter & DatabaseFunctionRegistry
  ): SqliteAgentRecordStore {
    registerSearchFunctions(database)
    return new SqliteAgentRecordStore(database)
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
   * @returns The interface-defined record or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public findAgent(code: string): StoredAgentRecord | undefined {
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
   * Implements {@link AgentRecordStore.deleteAgent} with one `UPDATE` that
   * marks only an agent that is not deleted yet.
   * @param code - Interface-defined code.
   * @param deletedAt - Interface-defined deletion time.
   * @returns The interface-defined deletion outcome.
   * @throws The interface-defined failures.
   */
  public deleteAgent(code: string, deletedAt: string): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(
            "UPDATE agents SET deleted_at = ? WHERE code = ? AND deleted_at IS NULL"
          )
          .run(deletedAt, code).changes === 1
    )
  }

  /**
   * Implements {@link AgentRecordSearcher.searchAgents} in one read snapshot, so
   * the count and the matches agree.
   * @param input - Interface-defined search text and number of matches.
   * @returns The interface-defined page.
   * @throws The interface-defined closed and validation failures.
   */
  public searchAgents(input: SearchAgentsInput): StoredAgentSearchPage {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      searchAgents(statements, input)
    )
  }
}
