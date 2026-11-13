import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, onTestFinished } from "vitest"
import { migrateDatabase } from "../../../../src/infrastructure/database/migrations"

/** Schema version produced by the current migration list. */
const CURRENT_SCHEMA_VERSION = 17

/**
 * Opens an empty in-memory database owned by the current test.
 *
 * @returns An open connection closed when the test finishes.
 */
function openEmptyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:")
  onTestFinished(() => {
    database.close()
  })
  return database
}

/**
 * Reads the stored schema version marker.
 *
 * @param database - Open connection.
 * @returns The `user_version` pragma value.
 */
function readUserVersion(database: DatabaseSync): unknown {
  return database.prepare("PRAGMA user_version").get()?.user_version
}

/**
 * Lists schema objects of one kind.
 *
 * @param database - Open connection.
 * @param type - SQLite schema object type.
 * @returns Object names in ascending order.
 */
function listSchemaObjects(
  database: DatabaseSync,
  type: "table" | "trigger" | "index"
): unknown[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all(type)
    .map((row) => row.name)
}

/**
 * Lists a table's column names in declaration order.
 *
 * @param database - Open connection.
 * @param table - Table name.
 * @returns Column names.
 */
function listColumns(database: DatabaseSync, table: string): unknown[] {
  return database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name)
}

/**
 * Message table, index, and triggers as migrations 2 to 5 left them, the
 * shape every version from 5 to 8 stores.
 *
 * @remarks Copied from those migrations at version 8 (commit 216db37), so a
 * fixture built from it is the historical table, not the current one.
 */
const VERSION_8_MESSAGES_SQL = `
  CREATE TABLE conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL
      REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    model TEXT,
    content TEXT NOT NULL,
    status TEXT CHECK (
      status IN ('streaming', 'completed', 'interrupted', 'failed')
    ),
    finish_reason TEXT CHECK (
      finish_reason IN ('stop', 'length')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT,
    CHECK (
      (
        role = 'user'
        AND model IS NULL
        AND length(content) > 0
        AND status IS NULL
        AND finish_reason IS NULL
        AND updated_at IS NULL
      )
      OR
      (
        role = 'assistant'
        AND status IS NOT NULL
        AND updated_at IS NOT NULL
        AND model IS NOT NULL
        AND length(model) > 0
        AND (
          (
            status = 'completed'
            AND finish_reason IS NOT NULL
          )
          OR
          (
            status IN ('streaming', 'interrupted', 'failed')
            AND finish_reason IS NULL
          )
        )
      )
    )
  ) STRICT;

  CREATE INDEX conversation_messages_conversation_idx
    ON conversation_messages (conversation_id, created_at, id);

  CREATE TRIGGER update_conversation_after_message_insert
  AFTER INSERT ON conversation_messages
  FOR EACH ROW
  BEGIN
    UPDATE conversations
    SET updated_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  END;

  CREATE TRIGGER update_conversation_after_message_update
  AFTER UPDATE OF content ON conversation_messages
  FOR EACH ROW
  BEGIN
    UPDATE conversations
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.conversation_id;
  END;
`

/**
 * Creates a database with the version-8 schema.
 *
 * @returns A connection at `user_version` 8, closed when the test finishes.
 * @remarks Starts from {@link createVersion10Database}, then replaces what
 * migrations 9 and 10 changed with the historical version-8 objects: the
 * attachments and sources tables go, and the message table, its index, and
 * its triggers come back as {@link VERSION_8_MESSAGES_SQL}. The other tables
 * are unchanged since version 8.
 */
function createVersion8Database(): DatabaseSync {
  const database = createVersion10Database()
  database.exec(`
    DROP TABLE conversation_attachments;
    DROP TABLE conversation_sources;
    DROP TABLE conversation_messages;
    ${VERSION_8_MESSAGES_SQL}
    PRAGMA user_version = 8
  `)
  return database
}

/**
 * Creates a database at version 9: the current schema without the
 * attachments table.
 *
 * @returns A connection at `user_version` 9, closed when the test finishes.
 * @remarks Migration 10 only adds the attachments table, so dropping it from
 * a version-10 database leaves exactly the version-9 schema.
 */
function createVersion9Database(): DatabaseSync {
  const database = createVersion10Database()
  database.exec(`
    DROP TABLE conversation_attachments;
    PRAGMA user_version = 9
  `)
  return database
}

/**
 * Creates a database at version 10: the version-11 schema without the
 * agents' deletion time.
 *
 * @returns A connection at `user_version` 10, closed when the test finishes.
 * @remarks Migration 11 only adds `agents.deleted_at`, so dropping that
 * column from a version-11 database leaves exactly the version-10 schema.
 */
function createVersion10Database(): DatabaseSync {
  const database = createVersion11Database()
  database.exec(`
    ALTER TABLE agents DROP COLUMN deleted_at;
    PRAGMA user_version = 10
  `)
  return database
}

/**
 * Creates a database at version 11, whose schema is the version-12 one.
 *
 * @returns A connection at `user_version` 11, closed when the test finishes.
 * @remarks Migration 12 changes only stored codes, never the schema.
 */
function createVersion11Database(): DatabaseSync {
  const database = createVersion12Database()
  database.exec("PRAGMA user_version = 11")
  return database
}

/**
 * Removes the tool search call records, their indexes, and their trigger,
 * which version 16 adds.
 *
 * @param database - Connection at version 16 or later.
 */
function dropToolSearchCallRecords(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER interrupt_tool_search_calls_after_tool_call_update;
    DROP TABLE tool_search_call_decisions;
  `)
}

/**
 * Creates a database at version 12: the version-15 schema without the tool
 * call decision records.
 *
 * @returns A connection at `user_version` 12, closed when the test finishes.
 * @remarks Migration 13 only adds the decision table, its index, and its
 * trigger, and migrations 14 and 15 only create them again, so dropping
 * them from a version-15 database leaves exactly the version-12 schema.
 */
function createVersion12Database(): DatabaseSync {
  const database = createVersion15Database()
  database.exec(`
    DROP TRIGGER update_tool_call_decision_after_tool_call_update;
    DROP TABLE tool_call_decisions;
    PRAGMA user_version = 12
  `)
  return database
}

/** Denial reasons of the current decision tables, in their SQL's words. */
const CURRENT_DENIAL_REASONS_SQL =
  "'credential-file', 'outside-approved-folders', 'settings-unreadable', 'blocked-address', 'usage-limit', 'paid-tool-budget'"

/** Denial reasons of the version-16 decision tables, in their SQL's words. */
const VERSION_16_DENIAL_REASONS_SQL =
  "'credential-file', 'outside-approved-folders', 'settings-unreadable', 'blocked-address'"

/** Denial reasons of the version-14 decision table, in its SQL's words. */
const VERSION_14_DENIAL_REASONS_SQL = "'credential-file', 'blocked-address'"

/** Approval reasons of the current decision table, in its SQL's words. */
const CURRENT_APPROVAL_REASONS_SQL =
  "policy_reason IN ('destructive-tool', 'open-world-write', 'paid-tool')"

/** Approval reasons of the version-16 decision table, in its SQL's words. */
const VERSION_16_APPROVAL_REASONS_SQL = "policy_reason = 'destructive-tool'"

/** The policy identity column version 17 adds to both decision tables. */
const POLICY_ID_COLUMN_PATTERN =
  /policy_id TEXT CHECK \(\s*policy_id IS NULL OR \(policy_id <> '' AND policy_effect IS NOT NULL\)\s*\),\s*/u

/**
 * Replaces one text of an SQL definition, which must hold it.
 *
 * @param sql - Definition.
 * @param text - Text to replace, or a pattern matching it.
 * @param replacement - Its replacement.
 * @returns The definition with the text replaced.
 * @throws If the definition does not hold the text, which the derivations
 * below rely on.
 */
function replaceSqlText(
  sql: string,
  text: string | RegExp,
  replacement: string
): string {
  const isHeld = typeof text === "string" ? sql.includes(text) : text.test(sql)
  if (!isHeld) throw new Error(`The SQL no longer holds ${String(text)}`)
  return sql.replace(text, replacement)
}

/** Schema objects of one decision table that a migration creates again. */
type DecisionTableObjects = Readonly<{
  /** The table. */
  table: string
  /** Its indexes. */
  indexes: readonly string[]
  /** The trigger whose body names it. */
  trigger: string
}>

/** The tool call decision records' table, index, and trigger. */
const TOOL_CALL_DECISION_OBJECTS = Object.freeze({
  table: "tool_call_decisions",
  indexes: ["tool_call_decisions_conversation_idx"],
  trigger: "update_tool_call_decision_after_tool_call_update"
} satisfies DecisionTableObjects)

/** The tool search call records' table, indexes, and trigger. */
const TOOL_SEARCH_CALL_DECISION_OBJECTS = Object.freeze({
  table: "tool_search_call_decisions",
  indexes: [
    "tool_search_call_decisions_search_call_idx",
    "tool_search_call_decisions_conversation_idx"
  ],
  trigger: "interrupt_tool_search_calls_after_tool_call_update"
} satisfies DecisionTableObjects)

/**
 * Creates an empty decision table again with changed rules, and its indexes
 * and trigger again unchanged.
 *
 * @param database - Connection holding the table, without rows in it.
 * @param objects - The table and the objects that go with it.
 * @param editTableSql - Changes the table's SQL into the wanted one.
 */
function recreateDecisionTable(
  database: DatabaseSync,
  objects: DecisionTableObjects,
  editTableSql: (tableSql: string) => string
): void {
  const readSql = (name: string): string => {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name)
    if (typeof row?.sql !== "string") throw new Error(`${name} has no SQL`)
    return row.sql
  }
  const tableSql = readSql(objects.table)
  const indexSqls = objects.indexes.map(readSql)
  const triggerSql = readSql(objects.trigger)
  database.exec(`
    DROP TRIGGER ${objects.trigger};
    DROP TABLE ${objects.table};
  `)
  database.exec(editTableSql(tableSql))
  for (const indexSql of indexSqls) database.exec(indexSql)
  database.exec(triggerSql)
}

/**
 * Changes a current decision table's SQL into the version-16 one.
 *
 * @param tableSql - The current table's SQL.
 * @returns The SQL without the policy identity column, the denials
 * `usage-limit` and `paid-tool-budget`, and the approval reasons
 * `open-world-write` and `paid-tool`, where the table holds them.
 */
function revertVersion17TableSql(tableSql: string): string {
  const version16Sql = replaceSqlText(
    replaceSqlText(tableSql, POLICY_ID_COLUMN_PATTERN, ""),
    CURRENT_DENIAL_REASONS_SQL,
    VERSION_16_DENIAL_REASONS_SQL
  )
  return version16Sql.includes(CURRENT_APPROVAL_REASONS_SQL)
    ? version16Sql.replace(
        CURRENT_APPROVAL_REASONS_SQL,
        VERSION_16_APPROVAL_REASONS_SQL
      )
    : version16Sql
}

/**
 * Creates a database at version 16: the current schema whose decision
 * tables cannot store the policy's identity, its usage and budget denials,
 * or its open-world and paid-tool approval reasons.
 *
 * @returns A connection at `user_version` 16, closed when the test finishes.
 * @remarks Migration 17 only creates both decision tables again with the
 * column and the values added, and their indexes and triggers again
 * unchanged, so the current tables' own SQL without them is each
 * version-16 table.
 */
function createVersion16Database(): DatabaseSync {
  const database = openEmptyDatabase()
  migrateDatabase(database)
  recreateDecisionTable(
    database,
    TOOL_CALL_DECISION_OBJECTS,
    revertVersion17TableSql
  )
  recreateDecisionTable(
    database,
    TOOL_SEARCH_CALL_DECISION_OBJECTS,
    revertVersion17TableSql
  )
  database.exec("PRAGMA user_version = 16")
  return database
}

/**
 * Creates a database at an earlier version whose decision table differs
 * from the version-15 one only in its rules.
 *
 * @param version - The version.
 * @param editTableSql - Changes the version-15 table's SQL into the
 * version's.
 * @returns A connection at `user_version` `version`, closed when the test
 * finishes.
 * @remarks Migrations 14 and 15 only create the decision table again with
 * one more allowed value, and its index and trigger again unchanged, so
 * the version-15 table's own SQL without those values is each earlier
 * table.
 */
function createDecisionTableVersionDatabase(
  version: number,
  editTableSql: (tableSql: string) => string
): DatabaseSync {
  const database = createVersion15Database()
  recreateDecisionTable(database, TOOL_CALL_DECISION_OBJECTS, editTableSql)
  database.exec(`PRAGMA user_version = ${version}`)
  return database
}

/**
 * Creates a database at version 15: the version-16 schema without the tool
 * search call records.
 *
 * @returns A connection at `user_version` 15, closed when the test finishes.
 * @remarks Migration 16 only adds the tool search call records.
 */
function createVersion15Database(): DatabaseSync {
  const database = createVersion16Database()
  dropToolSearchCallRecords(database)
  database.exec("PRAGMA user_version = 15")
  return database
}

/**
 * Creates a database at version 14: the version-15 schema whose decision
 * records cannot store the denial reasons `outside-approved-folders` and
 * `settings-unreadable`.
 *
 * @returns A connection at `user_version` 14, closed when the test finishes.
 */
function createVersion14Database(): DatabaseSync {
  return createDecisionTableVersionDatabase(14, (tableSql) =>
    replaceSqlText(
      tableSql,
      VERSION_16_DENIAL_REASONS_SQL,
      VERSION_14_DENIAL_REASONS_SQL
    )
  )
}

/**
 * Creates a database at version 13: the version-14 schema whose decision
 * records cannot store the answer `expired` either.
 *
 * @returns A connection at `user_version` 13, closed when the test finishes.
 */
function createVersion13Database(): DatabaseSync {
  return createDecisionTableVersionDatabase(13, (tableSql) =>
    replaceSqlText(
      replaceSqlText(
        tableSql,
        VERSION_16_DENIAL_REASONS_SQL,
        VERSION_14_DENIAL_REASONS_SQL
      ),
      "'showFailed', 'expired'",
      "'showFailed'"
    )
  )
}

/**
 * Stores, in a migrated database, conversation `c1` under `caliginia` with
 * one streaming reply `a1` and its waiting web search call `p1`.
 *
 * @param database - Connection at version 12 or later.
 */
function saveWaitingToolCall(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
    VALUES ('p1', 'c1', 'tool_call', 'a1', 0, 0, '', 'awaiting-approval', 'web_search', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  `)
}

/**
 * Stores the decision record of call `p1` with the given decision columns.
 *
 * @param database - Connection holding {@link saveWaitingToolCall}'s rows.
 * @param values - SQL values of `policy_effect`, `policy_reason`,
 * `approval_mode`, and `answer`, in that order.
 */
function saveToolCallDecision(database: DatabaseSync, values: string): void {
  database.exec(`
    INSERT INTO tool_call_decisions (call_id, conversation_id, agent_code, tool_name, policy_effect, policy_reason, approval_mode, answer, outcome, created_at, updated_at)
    VALUES ('p1', 'c1', 'caliginia', 'web_search', ${values}, 'awaiting-approval', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  `)
}

/**
 * Stores, in a migrated database, conversation `c1` under `caliginia` with
 * one streaming reply `a1` and its running `find_tools` call `f1`, which
 * started a tool search.
 *
 * @param database - Connection at version 16 or later.
 */
function saveRunningSearchCall(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
    VALUES ('f1', 'c1', 'tool_call', 'a1', 0, 0, '', 'running', 'find_tools', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  `)
}

/**
 * Stores the record of one call of the search {@link saveRunningSearchCall}
 * started.
 *
 * @param database - Connection holding {@link saveRunningSearchCall}'s rows.
 * @param callId - Identity of the search's call.
 * @param values - SQL values of `policy_effect`, `policy_reason`,
 * `outcome`, and `updated_at`, in that order.
 */
function saveToolSearchCallRecord(
  database: DatabaseSync,
  callId: string,
  values: string
): void {
  database.exec(`
    INSERT INTO tool_search_call_decisions (call_id, search_call_id, conversation_id, agent_code, tool_name, argument_text, created_at, policy_effect, policy_reason, outcome, updated_at)
    VALUES ('${callId}', 'f1', 'c1', 'armitage', 'search_tools', '{"query":"web"}', '2026-01-04T00:00:00.000Z', ${values})
  `)
}

/**
 * Adds the policy identity that migration 17 gives every record stored
 * before it.
 *
 * @param records - Records read before the migration.
 * @returns The records with a null `policy_id`.
 */
function addNullPolicyId(
  records: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  return records.map((record) => ({ ...record, policy_id: null }))
}

/**
 * Lists the stored tool search call records.
 *
 * @param database - Open connection.
 * @returns Each record's call, outcome, and update time, by call.
 */
function listToolSearchCallOutcomes(
  database: DatabaseSync
): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT call_id AS callId, outcome, updated_at AS updatedAt
      FROM tool_search_call_decisions ORDER BY call_id`
    )
    .all()
}

/**
 * Lists the stored decision records.
 *
 * @param database - Open connection.
 * @returns Each record's call, conversation, outcome, and update time, by
 * call.
 */
function listToolCallDecisionOutcomes(
  database: DatabaseSync
): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT call_id AS callId, conversation_id AS conversationId, outcome,
      updated_at AS updatedAt FROM tool_call_decisions ORDER BY call_id`
    )
    .all()
}

/**
 * Stores agents and conversations in a version-11 database.
 *
 * @param database - Connection at `user_version` 11.
 * @param records - Codes of the stored agents, each deleted when its flag is
 * true, and agent codes of the stored conversations, one conversation each.
 */
function saveVersion11Records(
  database: DatabaseSync,
  records: Readonly<{
    agents: readonly (readonly [code: string, isDeleted: boolean])[]
    conversationAgentCodes: readonly string[]
  }>
): void {
  const saveAgent = database.prepare(
    `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at, deleted_at)
    VALUES (?, 'Stored', 'Stored agent.', 'You are stored.', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ?)`
  )
  for (const [code, isDeleted] of records.agents)
    saveAgent.run(code, isDeleted ? "2026-01-03T00:00:00.000Z" : null)
  const saveConversation = database.prepare(
    `INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES (?, 'Kept title', ?, '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z')`
  )
  for (const [index, agentCode] of records.conversationAgentCodes.entries())
    saveConversation.run(`c${index + 1}`, agentCode)
}

/**
 * Lists the stored agents.
 *
 * @param database - Open connection.
 * @returns Each agent's code, times, and deletion, by code.
 */
function listStoredAgents(database: DatabaseSync): unknown[] {
  return database
    .prepare(
      "SELECT code, created_at, updated_at, deleted_at FROM agents ORDER BY code"
    )
    .all()
}

/**
 * Lists the codes of the stored agents.
 *
 * @param database - Open connection.
 * @returns The codes, in code order.
 */
function listStoredAgentCodes(database: DatabaseSync): unknown[] {
  return database
    .prepare("SELECT code FROM agents ORDER BY code")
    .all()
    .map((row) => row.code)
}

/**
 * Lists the agent codes of the stored conversations.
 *
 * @param database - Open connection.
 * @returns Each conversation's agent code, in id order.
 */
function listConversationAgentCodes(database: DatabaseSync): unknown[] {
  return database
    .prepare("SELECT agent_code FROM conversations ORDER BY id")
    .all()
    .map((row) => row.agent_code)
}

/**
 * Lists the stored conversations.
 *
 * @param database - Open connection.
 * @returns Each conversation's id, agent code, title, and times, by id.
 */
function listStoredConversations(database: DatabaseSync): unknown[] {
  return database
    .prepare(
      "SELECT id, agent_code, title, created_at, updated_at FROM conversations ORDER BY id"
    )
    .all()
}

/**
 * Creates a database with the version-6 conversations table.
 *
 * @returns A connection at `user_version` 6, closed when the test finishes.
 * @remarks Starts from {@link createVersion8Database} and reverses migration
 * 7, which changes only the conversations table: it drops `agent_code` and
 * adds `system_prompt` back. SQLite requires the re-added column to have a
 * default, which the version-6 table lacked; every case writes the column
 * explicitly, so the default is never used.
 */
function createVersion6Database(): DatabaseSync {
  const database = createVersion8Database()
  database.exec(`
    ALTER TABLE conversations DROP COLUMN agent_code;
    ALTER TABLE conversations ADD COLUMN system_prompt TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 6
  `)
  return database
}

/**
 * Creates a database with the version-7 schema.
 *
 * @returns A connection at `user_version` 7, closed when the test finishes.
 * @remarks Starts from {@link createVersion8Database} and resets the version
 * marker: migration 8 changes only rows, and an empty database has none to
 * change.
 */
function createVersion7Database(): DatabaseSync {
  const database = createVersion8Database()
  database.exec("PRAGMA user_version = 7")
  return database
}

/** Version-8 message columns, which version 9 keeps with the same meaning. */
const VERSION_8_MESSAGE_COLUMNS =
  "id, conversation_id, role, model, status, finish_reason, created_at, updated_at"

/**
 * Lists the user and assistant rows of the message table, which versions 8
 * and 9 store alike.
 *
 * @param database - Open connection at version 8 or later.
 * @param columns - Columns to read: the version-8 columns, with or without
 * `content`, which version 9 empties on replies.
 * @returns The rows in identity order.
 */
function listMessageRows(
  database: DatabaseSync,
  columns: "version-8" | "version-8 and content"
): unknown[] {
  const selected =
    columns === "version-8"
      ? VERSION_8_MESSAGE_COLUMNS
      : `${VERSION_8_MESSAGE_COLUMNS}, content`
  return database
    .prepare(
      `SELECT ${selected} FROM conversation_messages
      WHERE role IN ('user', 'assistant') ORDER BY id`
    )
    .all()
}

/**
 * Lists the reply pieces of the message table.
 *
 * @param database - Open connection at version 9.
 * @returns Each piece's identity, place, text, and times, in reply order.
 */
function listReplyPartRows(database: DatabaseSync): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT id, conversation_id AS conversationId, role, reply_id AS replyId,
      position, round, content, status, tool_name AS toolName,
      created_at AS createdAt, updated_at AS updatedAt
      FROM conversation_messages WHERE reply_id IS NOT NULL ORDER BY reply_id`
    )
    .all()
}

/**
 * Stores, in a version-8 database, one conversation with a user message and
 * a completed, a failed, and a streaming reply.
 *
 * @param database - Connection at `user_version` 8.
 * @remarks The completed reply holds two rounds' text joined by a blank
 * line, the failed one no text, and the streaming one partial text; each
 * reply's update time differs from its creation time.
 */
function saveVersion8Conversation(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', 'Title', 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-09T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES
      ('u1', 'c1', 'user', NULL, 'Hello', NULL, NULL, '2026-01-02T00:00:00.000Z', NULL),
      ('a1', 'c1', 'assistant', 'model', 'First round' || char(10) || char(10) || 'Answer', 'completed', 'stop', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      ('a2', 'c1', 'assistant', 'model', '', 'failed', NULL, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:01.000Z'),
      ('a3', 'c1', 'assistant', 'model', 'Partial', 'streaming', NULL, '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:02.000Z')
  `)
}

describe("migrateDatabase", () => {
  it("creates the current schema in an empty database", () => {
    const database = openEmptyDatabase()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toEqual([
      "agents",
      "conversation_attachments",
      "conversation_messages",
      "conversation_sources",
      "conversations",
      "tool_call_decisions",
      "tool_search_call_decisions"
    ])
    expect(listSchemaObjects(database, "trigger")).toEqual([
      "interrupt_tool_search_calls_after_tool_call_update",
      "update_conversation_after_message_insert",
      "update_conversation_after_message_update",
      "update_conversation_updated_at",
      "update_tool_call_decision_after_tool_call_update"
    ])
    expect(listSchemaObjects(database, "index")).toEqual([
      "conversation_messages_conversation_idx",
      "conversation_messages_reply_part_idx",
      "tool_call_decisions_conversation_idx",
      "tool_search_call_decisions_conversation_idx",
      "tool_search_call_decisions_search_call_idx"
    ])
    expect(database.isTransaction).toBe(false)
  })

  it("leaves a current database unchanged when run again", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database
      .prepare(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
        VALUES ('kept', NULL, 'lys', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(database.prepare("SELECT id FROM conversations").all()).toEqual([
      { id: "kept" }
    ])
  })

  it("upgrades a version-5 database by adding the agents table and keeping its conversations", () => {
    const database = createVersion6Database()
    // Migration 6 only adds the agents table, so dropping it from a version-6
    // database leaves exactly the version-5 schema.
    database.exec("DROP TABLE agents; PRAGMA user_version = 5")
    database
      .prepare(
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
        VALUES ('kept', 'Title', 'prompt', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listSchemaObjects(database, "table")).toContain("agents")
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM agents").get()
    ).toEqual({ count: 0 })
    expect(
      database.prepare("SELECT id, title FROM conversations").all()
    ).toEqual([{ id: "kept", title: "Title" }])
  })

  it("upgrades a version-6 database by recording Caliginia as every conversation's agent and dropping the stored prompts", () => {
    const database = createVersion6Database()
    database
      .prepare(
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
        VALUES ('kept', 'Title', 'Old prompt', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
        VALUES ('question', 'kept', 'user', 'Hello', '2026-01-02T00:00:00.000Z')`
      )
      .run()
    const conversationsBefore = database
      .prepare("SELECT id, title, created_at, updated_at FROM conversations")
      .all()
    const messagesBefore = listMessageRows(database, "version-8 and content")

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "conversations")).toEqual([
      "id",
      "title",
      "created_at",
      "updated_at",
      "agent_code"
    ])
    expect(
      database
        .prepare("SELECT id, title, created_at, updated_at FROM conversations")
        .all()
    ).toEqual(conversationsBefore)
    expect(
      database
        .prepare("SELECT agent_code AS agentCode FROM conversations")
        .all()
    ).toEqual([{ agentCode: "caliginia" }])
    expect(listMessageRows(database, "version-8 and content")).toEqual(
      messagesBefore
    )
  })

  it("upgrades a version-7 database by moving every conversation Lys answered to Caliginia and changing nothing else", () => {
    const database = createVersion7Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES
        ('first', 'Title', 'lys', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('second', NULL, 'lys', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('other', NULL, 'web-researcher', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES ('question', 'first', 'user', 'Hello', '2026-01-02T00:00:00.000Z');
      INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
      VALUES ('lys', 'Mine', 'My own agent.', 'You are mine.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    const conversationsBefore = database
      .prepare(
        "SELECT id, title, created_at, updated_at FROM conversations ORDER BY id"
      )
      .all()
    const messagesBefore = listMessageRows(database, "version-8 and content")
    const agentsBefore = database.prepare("SELECT * FROM agents").all()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      database
        .prepare(
          "SELECT id, agent_code AS agentCode FROM conversations ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "first", agentCode: "caliginia" },
      { id: "other", agentCode: "web-researcher" },
      { id: "second", agentCode: "caliginia" }
    ])
    expect(
      database
        .prepare(
          "SELECT id, title, created_at, updated_at FROM conversations ORDER BY id"
        )
        .all()
    ).toEqual(conversationsBefore)
    expect(listMessageRows(database, "version-8 and content")).toEqual(
      messagesBefore
    )
    expect(database.prepare("SELECT * FROM agents").all()).toEqual(
      agentsBefore.map((row) => ({ ...row, deleted_at: null }))
    )
  })

  it("upgrades a version-8 database by keeping every message and its conversation's activity time, without reply text", () => {
    const database = createVersion8Database()
    saveVersion8Conversation(database)
    const activityTimeBefore = database
      .prepare("SELECT updated_at AS updatedAt FROM conversations")
      .get()
    const messagesBefore = listMessageRows(database, "version-8")

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listMessageRows(database, "version-8")).toEqual(messagesBefore)
    expect(
      database
        .prepare(
          `SELECT id, content FROM conversation_messages
          WHERE role IN ('user', 'assistant') ORDER BY id`
        )
        .all()
    ).toEqual([
      { id: "a1", content: "" },
      { id: "a2", content: "" },
      { id: "a3", content: "" },
      { id: "u1", content: "Hello" }
    ])
    expect(
      database
        .prepare("SELECT updated_at AS updatedAt FROM conversations")
        .get()
    ).toEqual(activityTimeBefore)
    expect(listSchemaObjects(database, "trigger")).toEqual([
      "interrupt_tool_search_calls_after_tool_call_update",
      "update_conversation_after_message_insert",
      "update_conversation_after_message_update",
      "update_conversation_updated_at",
      "update_tool_call_decision_after_tool_call_update"
    ])
  })

  it("upgrades a version-8 database by moving each reply's text into one text piece of round 0 with the reply's times", () => {
    const database = createVersion8Database()
    saveVersion8Conversation(database)

    migrateDatabase(database)

    const parts = listReplyPartRows(database)
    expect(parts).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
        conversationId: "c1",
        role: "text",
        replyId: "a1",
        position: 0,
        round: 0,
        content: "First round\n\nAnswer",
        status: null,
        toolName: null,
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-04T00:00:00.000Z"
      },
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
        conversationId: "c1",
        role: "text",
        replyId: "a3",
        position: 0,
        round: 0,
        content: "Partial",
        status: null,
        toolName: null,
        createdAt: "2026-01-06T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:02.000Z"
      }
    ])
    // A UUIDv7 holds its time in its first 48 bits.
    const firstPartTime = Number.parseInt(
      String(parts[0]?.id).replaceAll("-", "").slice(0, 12),
      16
    )
    expect(firstPartTime).toBe(Date.parse("2026-01-03T00:00:00.000Z"))
  })

  it("upgrades a version-8 database holding a reply whose text starts with a NUL character", () => {
    const database = createVersion8Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', char(0) || 'Hi', 'completed', 'stop', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      database
        .prepare(
          "SELECT reply_id AS replyId, content FROM conversation_messages WHERE role = 'text'"
        )
        .all()
    ).toEqual([{ replyId: "a1", content: "\u0000Hi" }])
  })

  it("keeps a version-8 database unchanged when migration 9 fails", () => {
    const database = createVersion8Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', 'Answer', 'completed', 'stop', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      CREATE TABLE conversation_sources (id TEXT)
    `)

    expect(() => migrateDatabase(database)).toThrow(
      /table conversation_sources already exists/
    )

    expect(readUserVersion(database)).toBe(8)
    expect(listColumns(database, "conversation_messages")).toEqual([
      "id",
      "conversation_id",
      "role",
      "model",
      "content",
      "status",
      "finish_reason",
      "created_at",
      "updated_at"
    ])
    expect(
      database.prepare("SELECT content FROM conversation_messages").all()
    ).toEqual([{ content: "Answer" }])
    expect(database.isTransaction).toBe(false)
  })

  it.each([
    [
      "a reply holding text",
      {
        role: "'assistant'",
        replyId: "NULL",
        position: "NULL",
        round: "NULL",
        model: "'model'",
        status: "'completed'",
        finishReason: "'stop'"
      },
      /CHECK constraint failed/
    ],
    [
      "a completed reply without a finish reason",
      {
        role: "'assistant'",
        replyId: "NULL",
        position: "NULL",
        round: "NULL",
        model: "'model'",
        content: "''",
        status: "'completed'"
      },
      /CHECK constraint failed/
    ],
    [
      "an empty user message",
      {
        role: "'user'",
        replyId: "NULL",
        position: "NULL",
        round: "NULL",
        content: "''",
        updatedAt: "NULL"
      },
      /CHECK constraint failed/
    ],
    [
      "a text piece without its reply",
      { replyId: "NULL" },
      /CHECK constraint failed/
    ],
    ["an empty text piece", { content: "''" }, /CHECK constraint failed/],
    [
      "an empty reasoning piece",
      { role: "'reasoning'", content: "''" },
      /CHECK constraint failed/
    ],
    [
      "a piece with a negative position",
      { position: "-1" },
      /CHECK constraint failed/
    ],
    ["a piece without a round", { round: "NULL" }, /CHECK constraint failed/],
    [
      "a piece at a position its reply already uses",
      { position: "0" },
      /UNIQUE constraint failed: conversation_messages\.reply_id, conversation_messages\.position/
    ],
    [
      "a running call with a result",
      {
        role: "'tool_call'",
        content: "'result'",
        status: "'running'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a failed call without a result",
      {
        role: "'tool_call'",
        content: "''",
        status: "'failed'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a rejected call without a result",
      {
        role: "'tool_call'",
        content: "''",
        status: "'rejected'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a call without a status",
      {
        role: "'tool_call'",
        content: "''",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a call with a reply status",
      {
        role: "'tool_call'",
        content: "''",
        status: "'streaming'",
        toolName: "'read_page'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a call without its tool name",
      {
        role: "'tool_call'",
        content: "''",
        status: "'running'",
        toolArguments: "'{}'"
      },
      /CHECK constraint failed/
    ],
    [
      "a succeeded call whose source numbers are not JSON",
      {
        role: "'tool_call'",
        content: "'result'",
        status: "'succeeded'",
        toolName: "'read_page'",
        toolArguments: "'{}'",
        sourceNumbers: "'[1'"
      },
      /CHECK constraint failed/
    ]
  ])("refuses %s", (_label, change, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
      VALUES ('p1', 'c1', 'text', 'a1', 0, 0, 'kept', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    // A valid text piece at position 1, with the case's one change.
    const row = {
      role: "'text'",
      replyId: "'a1'",
      position: "1",
      round: "0",
      model: "NULL",
      content: "'text'",
      status: "NULL",
      finishReason: "NULL",
      toolName: "NULL",
      toolArguments: "NULL",
      sourceNumbers: "NULL",
      updatedAt: "'2026-01-03T00:00:00.000Z'",
      ...change
    }

    expect(() =>
      database.exec(
        `INSERT INTO conversation_messages
        (id, conversation_id, role, reply_id, position, round, model, content, status, finish_reason, tool_name, tool_arguments, source_numbers, created_at, updated_at)
        VALUES ('p2', 'c1', ${row.role}, ${row.replyId}, ${row.position}, ${row.round}, ${row.model}, ${row.content}, ${row.status}, ${row.finishReason}, ${row.toolName}, ${row.toolArguments}, ${row.sourceNumbers}, '2026-01-03T00:00:00.000Z', ${row.updatedAt})`
      )
    ).toThrow(failure)
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_messages")
        .get()
    ).toEqual({ count: 2 })
  })

  it("stores each kind of reply piece the version-9 rules allow", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, source_numbers, created_at, updated_at)
      VALUES
        ('p0', 'c1', 'reasoning', 'a1', 0, 0, 'Thinking', NULL, NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p1', 'c1', 'text', 'a1', 1, 0, 'Let me look', NULL, NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p2', 'c1', 'tool_call', 'a1', 2, 0, '', 'awaiting-approval', 'web_search', '{"query":"lys"}', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p3', 'c1', 'tool_call', 'a1', 3, 0, '', 'succeeded', 'read_text_file', '', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p4', 'c1', 'tool_call', 'a1', 4, 0, 'Results', 'succeeded', 'web_search', '{}', '[1,2]', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p5', 'c1', 'tool_call', 'a1', 5, 0, 'Rejected', 'rejected', '', 'not json', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES ('c1', 1, 'https://example.com/', 'Example')
    `)

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM conversation_messages WHERE reply_id = 'a1'"
        )
        .get()
    ).toEqual({ count: 6 })
  })

  it("deletes a reply's pieces with the reply, and a conversation's pieces and sources with the conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES
        ('a1', 'c1', 'assistant', 'model', '', 'completed', 'stop', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('a2', 'c1', 'assistant', 'model', '', 'completed', 'stop', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
      VALUES
        ('p1', 'c1', 'text', 'a1', 0, 0, 'One', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p2', 'c1', 'text', 'a2', 0, 0, 'Two', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
      INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES ('c1', 1, 'https://example.com/', 'Example')
    `)

    database.exec("DELETE FROM conversation_messages WHERE id = 'a1'")

    expect(
      database.prepare("SELECT id FROM conversation_messages ORDER BY id").all()
    ).toEqual([{ id: "a2" }, { id: "p2" }])

    database.exec("DELETE FROM conversations WHERE id = 'c1'")

    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_messages")
        .get()
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_sources")
        .get()
    ).toEqual({ count: 0 })
  })

  it("refuses a piece whose reply is not stored", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)

    expect(() =>
      database.exec(`
        INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, created_at, updated_at)
        VALUES ('p1', 'c1', 'text', 'missing', 0, 0, 'Text', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `)
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it("moves a conversation's activity time forward when a piece is added or its content changes, and not when only its status changes", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    const readActivityTime = () =>
      database
        .prepare("SELECT updated_at AS updatedAt FROM conversations")
        .get()

    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES ('p1', 'c1', 'tool_call', 'a1', 0, 0, '', 'awaiting-approval', 'read_page', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
    `)
    expect(readActivityTime()).toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z"
    })

    database.exec(
      "UPDATE conversation_messages SET status = 'running' WHERE id = 'p1'"
    )
    expect(readActivityTime()).toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z"
    })

    database.exec(
      "UPDATE conversation_messages SET status = 'succeeded', content = 'Page' WHERE id = 'p1'"
    )
    expect(readActivityTime()).not.toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z"
    })
  })

  it.each([
    ["a number below 1", "('c1', 0, 'https://example.com/a', 'A')"],
    ["an empty URL", "('c1', 2, '', 'A')"],
    ["an empty title", "('c1', 2, 'https://example.com/a', '')"],
    [
      "a number the conversation already uses",
      "('c1', 1, 'https://example.com/a', 'A')"
    ],
    [
      "a URL the conversation already stores",
      "('c1', 2, 'https://example.com/', 'A')"
    ]
  ])("refuses a source with %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES ('c1', 1, 'https://example.com/', 'Example')
    `)

    expect(() =>
      database.exec(
        `INSERT INTO conversation_sources (conversation_id, number, url, title) VALUES ${values}`
      )
    ).toThrow(/constraint failed/)
  })

  it("refuses a conversation row with an empty agent code", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    expect(() =>
      database.exec(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
        VALUES ('empty', NULL, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
    ).toThrow(/CHECK constraint failed: agent_code <> ''/)
  })

  it.each([
    [
      "a missing code",
      { code: "NULL" },
      /NOT NULL constraint failed: agents\.code/
    ],
    ["an empty code", { code: "''" }, /CHECK constraint failed: code <> ''/],
    ["an empty name", { name: "''" }, /CHECK constraint failed: name <> ''/],
    ["an empty bio", { bio: "''" }, /CHECK constraint failed: bio <> ''/],
    [
      "an empty system prompt",
      { systemPrompt: "''" },
      /CHECK constraint failed: system_prompt <> ''/
    ]
  ])("refuses an agent row with %s", (_label, change, failure) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    const row = {
      code: "'lys'",
      name: "'Lys'",
      bio: "'Bio'",
      systemPrompt: "'Prompt'",
      ...change
    }

    expect(() =>
      database.exec(
        `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
        VALUES (${row.code}, ${row.name}, ${row.bio}, ${row.systemPrompt}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
    ).toThrow(failure)
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM agents").get()
    ).toEqual({ count: 0 })
  })

  it("stores reply text, a user message, and a failed call's result that start with a NUL character", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES
        ('u1', 'c1', 'user', NULL, char(0) || 'Hello', NULL, NULL, '2026-01-02T00:00:00.000Z', NULL),
        ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES
        ('p0', 'c1', 'reasoning', 'a1', 0, 0, char(0) || 'Thinking', NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p1', 'c1', 'text', 'a1', 1, 0, char(0) || 'Answer', NULL, NULL, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('p2', 'c1', 'tool_call', 'a1', 2, 0, char(0) || 'Failed', 'failed', 'read_page', '{}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)

    expect(
      database
        .prepare(
          "SELECT id, content FROM conversation_messages WHERE id <> 'a1' ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: "p0", content: "\u0000Thinking" },
      { id: "p1", content: "\u0000Answer" },
      { id: "p2", content: "\u0000Failed" },
      { id: "u1", content: "\u0000Hello" }
    ])
  })

  it("stores agent text that starts with a NUL character", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    database
      .prepare(
        `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "lys",
        "\u0000Lys",
        "\u0000Bio",
        "\u0000Prompt",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      )

    expect(
      database
        .prepare("SELECT name, bio, system_prompt AS systemPrompt FROM agents")
        .get()
    ).toEqual({
      name: "\u0000Lys",
      bio: "\u0000Bio",
      systemPrompt: "\u0000Prompt"
    })
  })

  it("upgrades a version-9 database by adding the attachments table and keeping its messages", () => {
    const database = createVersion9Database()
    database.exec(`
      INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
      VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES ('u1', 'c1', 'user', 'Hello', '2026-01-02T00:00:00.000Z')
    `)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "conversation_attachments")).toEqual([
      "conversation_id",
      "message_id",
      "number",
      "name",
      "kind",
      "media_type",
      "size_bytes",
      "width",
      "height"
    ])
    expect(
      database.prepare("SELECT id, content FROM conversation_messages").all()
    ).toEqual([{ id: "u1", content: "Hello" }])
  })

  it("upgrades a version-10 database by adding the agents' deletion time, leaving every stored agent not deleted", () => {
    const database = createVersion10Database()
    database.exec(`
      INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
      VALUES ('researcher', 'Researcher', 'Searches.', 'You search.', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "agents")).toEqual([
      "code",
      "name",
      "bio",
      "system_prompt",
      "created_at",
      "updated_at",
      "deleted_at"
    ])
    expect(
      database.prepare("SELECT code, updated_at, deleted_at FROM agents").all()
    ).toEqual([
      {
        code: "researcher",
        updated_at: "2026-01-02T00:00:00.000Z",
        deleted_at: null
      }
    ])
  })

  it("upgrades a version-11 database by moving a stored agent coded armitage and its conversations to armitage-2, changing nothing else", () => {
    const database = createVersion11Database()
    saveVersion11Records(database, {
      agents: [
        ["armitage", false],
        ["researcher", false]
      ],
      conversationAgentCodes: ["armitage", "researcher", "armitage"]
    })

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listStoredAgents(database)).toEqual([
      {
        code: "armitage-2",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        deleted_at: null
      },
      {
        code: "researcher",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        deleted_at: null
      }
    ])
    expect(listStoredConversations(database)).toEqual(
      [
        ["c1", "armitage-2"],
        ["c2", "researcher"],
        ["c3", "armitage-2"]
      ].map(([id, agentCode]) => ({
        id,
        agent_code: agentCode,
        title: "Kept title",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-04T00:00:00.000Z"
      }))
    )
  })

  it("upgrades a version-11 database by moving a deleted stored agent coded armitage, keeping its deletion", () => {
    const database = createVersion11Database()
    saveVersion11Records(database, {
      agents: [["armitage", true]],
      conversationAgentCodes: []
    })

    migrateDatabase(database)

    expect(listStoredAgents(database)).toEqual([
      {
        code: "armitage-2",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        deleted_at: "2026-01-03T00:00:00.000Z"
      }
    ])
  })

  it("upgrades a version-11 database by moving armitage's records to the first code no agent and no conversation holds", () => {
    const database = createVersion11Database()
    saveVersion11Records(database, {
      agents: [
        ["armitage", false],
        ["armitage-2", true]
      ],
      conversationAgentCodes: ["armitage", "armitage-3"]
    })

    migrateDatabase(database)

    expect(listStoredAgentCodes(database)).toEqual(["armitage-2", "armitage-4"])
    expect(listConversationAgentCodes(database)).toEqual([
      "armitage-4",
      "armitage-3"
    ])
  })

  it("upgrades a version-11 database by moving conversations recorded under armitage without a stored agent", () => {
    const database = createVersion11Database()
    saveVersion11Records(database, {
      agents: [],
      conversationAgentCodes: ["armitage"]
    })

    migrateDatabase(database)

    expect(listConversationAgentCodes(database)).toEqual(["armitage-2"])
  })

  it("upgrades a version-11 database without a record under armitage without changing anything", () => {
    const database = createVersion11Database()
    saveVersion11Records(database, {
      agents: [
        ["armitage-2", false],
        ["researcher", false]
      ],
      conversationAgentCodes: ["researcher", "caliginia"]
    })
    const agents = listStoredAgents(database)
    const conversations = listStoredConversations(database)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listStoredAgents(database)).toEqual(agents)
    expect(listStoredConversations(database)).toEqual(conversations)
  })

  it("refuses an empty agent deletion time", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)

    expect(() =>
      database.exec(`
        INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at, deleted_at)
        VALUES ('researcher', 'Researcher', 'Searches.', 'You search.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '')
      `)
    ).toThrow(/CHECK constraint failed/)
  })

  /** Stores a conversation with one user message for attachment cases. */
  const ATTACHMENT_PARENTS_SQL = `
    INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES ('c1', NULL, 'caliginia', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES ('u1', 'c1', 'user', 'Hello', '2026-01-02T00:00:00.000Z');
    INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
    VALUES ('c1', 'u1', 1, 'Notes.md', 'text', NULL, 12, NULL, NULL)
  `

  it("stores an image and a text attachment under a user message", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(ATTACHMENT_PARENTS_SQL)

    database.exec(`
      INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
      VALUES ('c1', 'u1', 2, 'photo.png', 'image', 'image/png', 2048, 64, 32)
    `)

    expect(
      database
        .prepare(
          "SELECT number, name, kind FROM conversation_attachments ORDER BY number"
        )
        .all()
    ).toEqual([
      { number: 1, name: "Notes.md", kind: "text" },
      { number: 2, name: "photo.png", kind: "image" }
    ])
  })

  it.each([
    [
      "a number below 1",
      "('c1', 'u1', 0, 'a.md', 'text', NULL, 1, NULL, NULL)"
    ],
    ["an empty name", "('c1', 'u1', 2, '', 'text', NULL, 1, NULL, NULL)"],
    ["the name .", "('c1', 'u1', 2, '.', 'text', NULL, 1, NULL, NULL)"],
    ["the name ..", "('c1', 'u1', 2, '..', 'text', NULL, 1, NULL, NULL)"],
    [
      "a name holding a slash",
      "('c1', 'u1', 2, 'a/b.md', 'text', NULL, 1, NULL, NULL)"
    ],
    [
      "an unknown kind",
      "('c1', 'u1', 2, 'a.pdf', 'document', NULL, 1, NULL, NULL)"
    ],
    [
      "a negative size",
      "('c1', 'u1', 2, 'a.md', 'text', NULL, -1, NULL, NULL)"
    ],
    [
      "an image without a media type",
      "('c1', 'u1', 2, 'a.png', 'image', NULL, 1, 64, 32)"
    ],
    [
      "an image without sides",
      "('c1', 'u1', 2, 'a.png', 'image', 'image/png', 1, NULL, NULL)"
    ],
    [
      "an image with a zero side",
      "('c1', 'u1', 2, 'a.png', 'image', 'image/png', 1, 0, 32)"
    ],
    [
      "a text file with sides",
      "('c1', 'u1', 2, 'a.md', 'text', NULL, 1, 64, 32)"
    ],
    [
      "a text file with a media type",
      "('c1', 'u1', 2, 'a.md', 'text', 'text/plain', 1, NULL, NULL)"
    ],
    [
      "a name the message already stores, in another case",
      "('c1', 'u1', 2, 'notes.MD', 'text', NULL, 1, NULL, NULL)"
    ],
    [
      "a number the conversation already uses",
      "('c1', 'u1', 1, 'other.md', 'text', NULL, 1, NULL, NULL)"
    ],
    [
      "a message that is not stored",
      "('c1', 'u9', 2, 'a.md', 'text', NULL, 1, NULL, NULL)"
    ]
  ])("refuses an attachment with %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(ATTACHMENT_PARENTS_SQL)

    expect(() =>
      database.exec(
        `INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height) VALUES ${values}`
      )
    ).toThrow(/constraint failed/)
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM conversation_attachments")
        .get()
    ).toEqual({ count: 1 })
  })

  it("deletes a message's attachments with the message, and a conversation's with the conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    database.exec(ATTACHMENT_PARENTS_SQL)
    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES ('u2', 'c1', 'user', 'Again', '2026-01-03T00:00:00.000Z');
      INSERT INTO conversation_attachments (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
      VALUES ('c1', 'u2', 2, 'later.md', 'text', NULL, 3, NULL, NULL)
    `)

    database.exec("DELETE FROM conversation_messages WHERE id = 'u2'")
    expect(
      database.prepare("SELECT name FROM conversation_attachments").all()
    ).toEqual([{ name: "Notes.md" }])

    database.exec("DELETE FROM conversations WHERE id = 'c1'")
    expect(
      database.prepare("SELECT name FROM conversation_attachments").all()
    ).toEqual([])
  })

  it("upgrades a version-12 database by adding the tool call decision records, giving none to a call it already stores", () => {
    const database = createVersion12Database()
    saveWaitingToolCall(database)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(listColumns(database, "tool_call_decisions")).toEqual([
      "call_id",
      "conversation_id",
      "agent_code",
      "tool_name",
      "policy_effect",
      "policy_reason",
      "policy_id",
      "approval_mode",
      "answer",
      "outcome",
      "created_at",
      "updated_at"
    ])
    expect(listToolCallDecisionOutcomes(database)).toEqual([])
    expect(listReplyPartRows(database)).toMatchObject([
      { id: "p1", status: "awaiting-approval" }
    ])
    expect(listSchemaObjects(database, "trigger")).toContain(
      "update_tool_call_decision_after_tool_call_update"
    )
    expect(listSchemaObjects(database, "index")).toContain(
      "tool_call_decisions_conversation_idx"
    )

    database.exec(
      "UPDATE conversation_messages SET status = 'running' WHERE id = 'p1'"
    )

    expect(listReplyPartRows(database)).toMatchObject([
      { id: "p1", status: "running" }
    ])
    expect(listToolCallDecisionOutcomes(database)).toEqual([])
  })

  it.each(
    Object.entries({
      "a call Lys's own checks failed": "NULL, NULL, NULL, NULL",
      "a denied call": "'deny', 'credential-file', NULL, NULL",
      "an allowed call that runs without approval": "'allow', NULL, NULL, NULL",
      "an allowed call the person allowed":
        "'allow', NULL, 'ask-me', 'allowed'",
      "an allowed call the client could not show":
        "'allow', NULL, 'ask-me', 'showFailed'",
      "a destructive call the person declined":
        "'require-approval', 'destructive-tool', 'just-run', 'declined'",
      "a call whose prompt expired": "'allow', NULL, 'ask-me', 'expired'",
      "a call naming a path outside the approved folders":
        "'deny', 'outside-approved-folders', NULL, NULL",
      "a call naming a path while the approved folders cannot be read":
        "'deny', 'settings-unreadable', NULL, NULL",
      "a call past the usage limit": "'deny', 'usage-limit', NULL, NULL",
      "a paid call past the budget": "'deny', 'paid-tool-budget', NULL, NULL",
      "an open-world write the person allowed":
        "'require-approval', 'open-world-write', 'just-run', 'allowed'",
      "a paid call the person allowed":
        "'require-approval', 'paid-tool', 'ask-me', 'allowed'"
    })
  )("stores the decision record of %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveWaitingToolCall(database)

    saveToolCallDecision(database, values)

    expect(listToolCallDecisionOutcomes(database)).toEqual([
      {
        callId: "p1",
        conversationId: "c1",
        outcome: "awaiting-approval",
        updatedAt: "2026-01-03T00:00:00.000Z"
      }
    ])
  })

  it.each(
    Object.entries({
      "a reason without an effect": "NULL, 'credential-file', NULL, NULL",
      "a mode without an effect": "NULL, NULL, 'ask-me', NULL",
      "an unknown effect": "'maybe', NULL, NULL, NULL",
      "a denial without a reason": "'deny', NULL, NULL, NULL",
      "a denial with another rule's reason":
        "'deny', 'destructive-tool', NULL, NULL",
      "a required approval with a denial's reason":
        "'require-approval', 'paid-tool-budget', 'ask-me', NULL",
      "a denial with a mode": "'deny', 'blocked-address', 'ask-me', NULL",
      "a required approval without its reason":
        "'require-approval', NULL, 'ask-me', NULL",
      "a required approval without a mode":
        "'require-approval', 'destructive-tool', NULL, NULL",
      "an allowed call with a reason": "'allow', 'credential-file', NULL, NULL",
      "an unknown mode": "'allow', NULL, 'sometimes', NULL",
      "an answer without a mode": "'allow', NULL, NULL, 'allowed'",
      "an unknown answer": "'allow', NULL, 'ask-me', 'maybe'"
    })
  )("refuses a decision record with %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveWaitingToolCall(database)

    expect(() => saveToolCallDecision(database, values)).toThrow(
      /constraint failed/
    )
  })

  it.each(
    Object.entries({
      "whose call is not stored": `'missing', 'c1', 'caliginia', 'awaiting-approval'`,
      "with an empty agent code": `'p1', 'c1', '', 'awaiting-approval'`,
      "with an unknown outcome": `'p1', 'c1', 'caliginia', 'streaming'`
    })
  )("refuses a decision record %s", (_label, values) => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveWaitingToolCall(database)

    expect(() =>
      database.exec(`
        INSERT INTO tool_call_decisions (call_id, conversation_id, agent_code, outcome, tool_name, created_at, updated_at)
        VALUES (${values}, 'web_search', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
      `)
    ).toThrow(/constraint failed/)
  })

  it("upgrades a version-13 database by letting a decision record store the answer expired, keeping every record, its index, and its trigger", () => {
    const database = createVersion13Database()
    saveWaitingToolCall(database)
    saveToolCallDecision(database, "'allow', NULL, 'ask-me', NULL")
    const readRecords = () =>
      database.prepare("SELECT * FROM tool_call_decisions").all()
    const version13Records = readRecords()
    expect(() =>
      database.exec(
        "UPDATE tool_call_decisions SET answer = 'expired' WHERE call_id = 'p1'"
      )
    ).toThrow(/constraint failed/)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(readRecords()).toEqual(addNullPolicyId(version13Records))
    expect(listSchemaObjects(database, "index")).toContain(
      "tool_call_decisions_conversation_idx"
    )
    database.exec(`
      UPDATE tool_call_decisions SET answer = 'expired' WHERE call_id = 'p1';
      UPDATE conversation_messages SET status = 'failed', content = 'Expired.', updated_at = '2026-01-04T00:00:00.000Z' WHERE id = 'p1'
    `)
    expect(readRecords()).toMatchObject([
      {
        answer: "expired",
        outcome: "failed",
        updated_at: "2026-01-04T00:00:00.000Z"
      }
    ])
  })

  it("upgrades a version-14 database by letting a decision record store the denials outside-approved-folders and settings-unreadable, keeping every record, its index, and its trigger", () => {
    const database = createVersion14Database()
    saveWaitingToolCall(database)
    saveToolCallDecision(database, "'allow', NULL, 'ask-me', 'expired'")
    const readRecords = () =>
      database.prepare("SELECT * FROM tool_call_decisions").all()
    const version14Records = readRecords()
    const denyOutside =
      "UPDATE tool_call_decisions SET policy_effect = 'deny', policy_reason = 'outside-approved-folders', approval_mode = NULL, answer = NULL WHERE call_id = 'p1'"
    const denyUnreadable = denyOutside.replace(
      "outside-approved-folders",
      "settings-unreadable"
    )
    expect(() => database.exec(denyOutside)).toThrow(/constraint failed/)
    expect(() => database.exec(denyUnreadable)).toThrow(/constraint failed/)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(readRecords()).toEqual(addNullPolicyId(version14Records))
    expect(listSchemaObjects(database, "index")).toContain(
      "tool_call_decisions_conversation_idx"
    )
    database.exec(denyUnreadable)
    database.exec(denyOutside)
    database.exec(
      "UPDATE conversation_messages SET status = 'failed', content = 'Denied.', updated_at = '2026-01-04T00:00:00.000Z' WHERE id = 'p1'"
    )
    expect(readRecords()).toMatchObject([
      {
        policy_reason: "outside-approved-folders",
        outcome: "failed",
        updated_at: "2026-01-04T00:00:00.000Z"
      }
    ])
  })

  it.each(
    Object.entries({
      "an empty policy identity": ["'allow'", "''"],
      "a policy identity without an effect": ["NULL", "'lys-policy-v1'"]
    })
  )(
    "refuses a decision record and a search call's record with %s",
    (_label, [effect, policyId]) => {
      const database = openEmptyDatabase()
      migrateDatabase(database)
      saveRunningSearchCall(database)
      const at = "'2026-01-04T00:00:00.000Z'"

      expect(() =>
        database.exec(`
          INSERT INTO tool_call_decisions (call_id, conversation_id, agent_code, tool_name, policy_effect, policy_id, outcome, created_at, updated_at)
          VALUES ('f1', 'c1', 'caliginia', 'find_tools', ${effect}, ${policyId}, 'running', ${at}, ${at})
        `)
      ).toThrow(/constraint failed/)
      expect(() =>
        database.exec(`
          INSERT INTO tool_search_call_decisions (call_id, search_call_id, conversation_id, agent_code, tool_name, argument_text, policy_effect, policy_id, outcome, created_at, updated_at)
          VALUES ('s1', 'f1', 'c1', 'armitage', 'search_tools', '{}', ${effect}, ${policyId}, 'running', ${at}, ${at})
        `)
      ).toThrow(/constraint failed/)
    }
  )

  it("copies each status change of a call into its decision record with the call's update time", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveWaitingToolCall(database)
    saveToolCallDecision(database, "'allow', NULL, 'ask-me', NULL")

    database.exec(
      "UPDATE conversation_messages SET status = 'running', updated_at = '2026-01-04T00:00:00.000Z' WHERE id = 'p1'"
    )
    expect(listToolCallDecisionOutcomes(database)).toMatchObject([
      { outcome: "running", updatedAt: "2026-01-04T00:00:00.000Z" }
    ])

    database.exec(
      "UPDATE conversation_messages SET status = 'interrupted' WHERE id = 'p1'"
    )
    expect(listToolCallDecisionOutcomes(database)).toMatchObject([
      { outcome: "interrupted", updatedAt: "2026-01-04T00:00:00.000Z" }
    ])
  })

  it("deletes a decision record with its call, and with its conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveWaitingToolCall(database)
    saveToolCallDecision(database, "NULL, NULL, NULL, NULL")

    database.exec("DELETE FROM conversation_messages WHERE id = 'a1'")
    expect(listToolCallDecisionOutcomes(database)).toEqual([])

    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES ('a1', 'c1', 'assistant', 'model', '', 'streaming', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES ('p1', 'c1', 'tool_call', 'a1', 0, 0, '', 'awaiting-approval', 'web_search', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
    `)
    saveToolCallDecision(database, "NULL, NULL, NULL, NULL")
    database.exec("DELETE FROM conversations WHERE id = 'c1'")
    expect(listToolCallDecisionOutcomes(database)).toEqual([])
  })

  it("upgrades a version-15 database by adding the tool search call records, keeping every decision record", () => {
    const database = createVersion15Database()
    saveWaitingToolCall(database)
    saveToolCallDecision(database, "'allow', NULL, 'ask-me', NULL")
    const readRecords = () =>
      database.prepare("SELECT * FROM tool_call_decisions").all()
    const version15Records = readRecords()

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(readRecords()).toEqual(addNullPolicyId(version15Records))
    expect(listSchemaObjects(database, "table")).toContain(
      "tool_search_call_decisions"
    )
    expect(listToolSearchCallOutcomes(database)).toEqual([])
  })

  it("stores a search call's record for each decision a search's call can have, and refuses one that asks the person or waits for them", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveRunningSearchCall(database)
    const at = "'2026-01-04T00:00:00.000Z'"

    saveToolSearchCallRecord(database, "s1", `'allow', NULL, 'running', ${at}`)
    saveToolSearchCallRecord(
      database,
      "s2",
      `'deny', 'credential-file', 'failed', ${at}`
    )
    saveToolSearchCallRecord(database, "s3", `NULL, NULL, 'failed', ${at}`)
    const refused = {
      approval: `'require-approval', 'destructive-tool', 'running', ${at}`,
      waiting: `'allow', NULL, 'awaiting-approval', ${at}`,
      reasonlessDenial: `'deny', NULL, 'failed', ${at}`,
      allowedWithReason: `'allow', 'credential-file', 'running', ${at}`
    }
    for (const values of Object.values(refused))
      expect(() => saveToolSearchCallRecord(database, "s4", values)).toThrow(
        /constraint failed/
      )
    expect(listToolSearchCallOutcomes(database)).toMatchObject([
      { callId: "s1", outcome: "running" },
      { callId: "s2", outcome: "failed" },
      { callId: "s3", outcome: "failed" }
    ])
  })

  it("marks a search's calls still running as interrupted when its find_tools call stops running, keeping the later update time", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveRunningSearchCall(database)
    saveToolSearchCallRecord(
      database,
      "s1",
      "'allow', NULL, 'running', '2026-01-05T00:00:00.000Z'"
    )
    saveToolSearchCallRecord(
      database,
      "s2",
      "'allow', NULL, 'succeeded', '2026-01-05T00:00:00.000Z'"
    )
    saveToolSearchCallRecord(
      database,
      "s3",
      "'allow', NULL, 'running', '2026-01-07T00:00:00.000Z'"
    )

    database.exec(
      "UPDATE conversation_messages SET updated_at = '2026-01-06T00:00:00.000Z' WHERE id = 'f1'"
    )
    expect(listToolSearchCallOutcomes(database)).toMatchObject([
      { outcome: "running" },
      { outcome: "succeeded" },
      { outcome: "running" }
    ])
    database.exec(
      "UPDATE conversation_messages SET status = 'interrupted' WHERE id = 'f1'"
    )

    expect(listToolSearchCallOutcomes(database)).toEqual([
      {
        callId: "s1",
        outcome: "interrupted",
        updatedAt: "2026-01-06T00:00:00.000Z"
      },
      {
        callId: "s2",
        outcome: "succeeded",
        updatedAt: "2026-01-05T00:00:00.000Z"
      },
      {
        callId: "s3",
        outcome: "interrupted",
        updatedAt: "2026-01-07T00:00:00.000Z"
      }
    ])
  })

  it("deletes a search call's record with its find_tools call, and with its conversation", () => {
    const database = openEmptyDatabase()
    migrateDatabase(database)
    saveRunningSearchCall(database)
    const saveRecord = () =>
      saveToolSearchCallRecord(
        database,
        "s1",
        "'allow', NULL, 'running', '2026-01-04T00:00:00.000Z'"
      )
    saveRecord()

    database.exec("DELETE FROM conversation_messages WHERE id = 'f1'")
    expect(listToolSearchCallOutcomes(database)).toEqual([])

    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES ('f1', 'c1', 'tool_call', 'a1', 0, 0, '', 'running', 'find_tools', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
    `)
    saveRecord()
    database.exec("DELETE FROM conversations WHERE id = 'c1'")
    expect(listToolSearchCallOutcomes(database)).toEqual([])
  })

  it("upgrades a version-16 database by letting both decision tables store the policy's identity and its usage, budget, open-world, and paid-tool rules, keeping every record, its indexes, and its trigger", () => {
    const database = createVersion16Database()
    saveRunningSearchCall(database)
    saveToolSearchCallRecord(
      database,
      "s1",
      "'allow', NULL, 'running', '2026-01-04T00:00:00.000Z'"
    )
    database.exec(`
      INSERT INTO conversation_messages (id, conversation_id, role, reply_id, position, round, content, status, tool_name, tool_arguments, created_at, updated_at)
      VALUES ('p1', 'c1', 'tool_call', 'a1', 1, 0, '', 'awaiting-approval', 'web_search', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
    `)
    saveToolCallDecision(database, "'allow', NULL, 'ask-me', NULL")
    const readRecords = (table: string) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY call_id`).all()
    const version16DecisionRecords = readRecords("tool_call_decisions")
    const version16SearchRecords = readRecords("tool_search_call_decisions")
    const askPaid =
      "UPDATE tool_call_decisions SET policy_effect = 'require-approval', policy_reason = 'paid-tool', policy_id = 'lys-policy-v1' WHERE call_id = 'p1'"
    const denyUsage =
      "UPDATE tool_search_call_decisions SET policy_effect = 'deny', policy_reason = 'usage-limit', policy_id = 'lys-policy-v1' WHERE call_id = 's1'"
    expect(() => database.exec(askPaid)).toThrow(/no such column: policy_id/)
    expect(() =>
      database.exec(askPaid.replace(", policy_id = 'lys-policy-v1'", ""))
    ).toThrow(/constraint failed/)
    expect(() =>
      database.exec(denyUsage.replace(", policy_id = 'lys-policy-v1'", ""))
    ).toThrow(/constraint failed/)

    migrateDatabase(database)

    expect(readUserVersion(database)).toBe(CURRENT_SCHEMA_VERSION)
    expect(readRecords("tool_call_decisions")).toEqual(
      addNullPolicyId(version16DecisionRecords)
    )
    expect(readRecords("tool_search_call_decisions")).toEqual(
      addNullPolicyId(version16SearchRecords)
    )
    expect(listSchemaObjects(database, "index")).toEqual(
      expect.arrayContaining([
        "tool_call_decisions_conversation_idx",
        "tool_search_call_decisions_conversation_idx",
        "tool_search_call_decisions_search_call_idx"
      ])
    )
    database.exec(askPaid)
    database.exec(denyUsage)
    database.exec(
      "UPDATE conversation_messages SET status = 'running', updated_at = '2026-01-05T00:00:00.000Z' WHERE id = 'p1'"
    )
    database.exec(
      "UPDATE conversation_messages SET status = 'succeeded', updated_at = '2026-01-06T00:00:00.000Z' WHERE id = 'f1'"
    )
    expect(readRecords("tool_call_decisions")).toMatchObject([
      {
        policy_reason: "paid-tool",
        policy_id: "lys-policy-v1",
        outcome: "running",
        updated_at: "2026-01-05T00:00:00.000Z"
      }
    ])
    expect(readRecords("tool_search_call_decisions")).toMatchObject([
      {
        policy_reason: "usage-limit",
        policy_id: "lys-policy-v1",
        outcome: "interrupted",
        updated_at: "2026-01-06T00:00:00.000Z"
      }
    ])
  })

  it("rejects a database created by a newer version without changing it", () => {
    const database = openEmptyDatabase()
    database.exec("PRAGMA user_version = 99")

    // The message names both versions, in either order.
    expect(() => migrateDatabase(database)).toThrow(
      new RegExp(`^(?=.*\\b99\\b)(?=.*\\b${CURRENT_SCHEMA_VERSION}\\b)`)
    )

    expect(readUserVersion(database)).toBe(99)
    expect(listSchemaObjects(database, "table")).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it("rejects a negative schema version marker", () => {
    const database = openEmptyDatabase()
    database.exec("PRAGMA user_version = -1")

    expect(() => migrateDatabase(database)).toThrow()

    expect(readUserVersion(database)).toBe(-1)
    expect(listSchemaObjects(database, "table")).toEqual([])
    expect(database.isTransaction).toBe(false)
  })

  it("rolls back every migration when one migration fails", () => {
    const database = openEmptyDatabase()
    database.exec("CREATE TABLE conversation_messages (id TEXT)")

    expect(() => migrateDatabase(database)).toThrow(
      /table conversation_messages already exists/
    )

    expect(readUserVersion(database)).toBe(0)
    expect(listSchemaObjects(database, "table")).toEqual([
      "conversation_messages"
    ])
    expect(database.isTransaction).toBe(false)
  })
})
