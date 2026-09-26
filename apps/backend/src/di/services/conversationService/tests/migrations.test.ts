import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import SqliteConversationStore from ".."
import { legacyMigrations } from "./legacyMigrations"
import { buildChatMessages } from "../../../../modules/chat/chat/messages"

/** Allocates only synthetic test storage and installs cleanup before returning its path. */
function createDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "lys-history-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, "conversation.sqlite")
}

/**
 * Inserts a historical streaming reply at one schema version without using the current writer.
 * @param databasePath - Synthetic test database owned by the calling case.
 * @param version - Historical schema version the fixture represents.
 * @returns The conversation activity time stored before any restart.
 */
function createLegacyTranscript(databasePath: string, version: number): string {
  using database = new DatabaseSync(databasePath)
  database.exec(legacyMigrations.slice(0, version).join(";\n"))
  database.exec(`PRAGMA user_version = ${version};
    INSERT INTO conversations VALUES ('0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d', 'Saved title',
      'Historical custom instruction', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO conversation_messages VALUES ('0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72e',
      '0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d', 'assistant', 'old-model', 'Interrupted text',
      'streaming', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');`)
  const activity = database
    .prepare("SELECT updated_at FROM conversations")
    .get()?.updated_at
  assert.equal(typeof activity, "string")
  return String(activity)
}

/**
 * Verifies recovery advances message state time, keeps conversation activity
 * time, and retains saved prompt and content.
 */
function handleStreamingRecovery(context: TestContext, version: number): void {
  const databasePath = createDatabasePath(context)
  const storedActivity = createLegacyTranscript(databasePath, version)
  context.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2030-01-01T00:00:00.000Z")
  })
  using store = SqliteConversationStore.open(databasePath)
  const history = store.createHistoryAccess()
  const conversation = history.getConversation(
    "0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d"
  )
  assert.ok(conversation)
  const message = conversation.messages[0]
  assert.ok(message?.role === "assistant")
  assert.equal(message.status, "interrupted")
  assert.equal(message.content, "Interrupted text")
  assert.equal(message.updatedAt, "2030-01-01T00:00:00.000Z")
  assert.equal(conversation.updatedAt, storedActivity)
  const renamed = history.updateConversationTitle(
    conversation.id,
    "Renamed after upgrade"
  )
  assert.equal(renamed?.updatedAt, conversation.updatedAt)
  const turn = store.createTurnAccess().createConversationTurn({
    systemPrompt: "Test system prompt",
    conversationId: conversation.id,
    model: "test",
    userMessageContent: "Continue"
  })
  assert.deepEqual(buildChatMessages(turn), [
    { role: "system", content: "Historical custom instruction" },
    { role: "assistant", content: "Interrupted text" },
    { role: "user", content: "Continue" }
  ])
}

/** Verifies a supported historical schema upgrades and can persist a complete turn. */
function handleHistoricalVersion(context: TestContext, version: number): void {
  const databasePath = createDatabasePath(context)
  using historical = new DatabaseSync(databasePath)
  historical.exec(legacyMigrations.slice(0, version).join(";\n"))
  historical.exec(`PRAGMA user_version = ${version}`)
  using store = SqliteConversationStore.open(databasePath)
  const turn = store.createTurnAccess().createConversationTurn({
    systemPrompt: "Test system prompt",
    model: "test",
    userMessageContent: "Migrated"
  })
  assert.equal(
    store.createHistoryAccess().getConversation(turn.conversation.id)?.messages
      .length,
    2
  )
  assert.equal(historical.prepare("PRAGMA user_version").get()?.user_version, 5)
}

/** Verifies every supported source schema, including empty stores, has an upgrade path. */
async function handleMigrationVersions(context: TestContext): Promise<void> {
  for (const version of [0, 1, 2, 3, 4])
    await context.test(`schema ${version}`, (child) =>
      handleHistoricalVersion(child, version)
    )
}

/** Verifies a partially attempted migration rolls back its trigger and version changes. */
function handleMigrationRollback(context: TestContext): void {
  const databasePath = createDatabasePath(context)
  using database = new DatabaseSync(databasePath)
  database.exec(legacyMigrations.slice(0, 3).join(";\n"))
  database.exec(
    "PRAGMA user_version = 3; ALTER TABLE conversations RENAME TO legacy_conversations"
  )
  assert.throws(
    () => SqliteConversationStore.open(databasePath),
    /no such table/
  )
  assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3)
  assert.ok(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'update_conversation_updated_at'"
      )
      .get()
  )
}

/** Verifies unknown future schemas are refused without changing their version marker. */
function handleFutureVersion(context: TestContext): void {
  const databasePath = createDatabasePath(context)
  using database = new DatabaseSync(databasePath)
  database.exec("PRAGMA user_version = 99")
  assert.throws(
    () => SqliteConversationStore.open(databasePath),
    /newer than supported/
  )
  assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 99)
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM sqlite_master").get()
      ?.count,
    0
  )
}

/** Verifies startup recovery from each schema whose message trigger counted state changes. */
async function handleStreamingRecoveryVersions(
  context: TestContext
): Promise<void> {
  for (const version of [3, 4])
    await context.test(`schema ${version}`, (child) =>
      handleStreamingRecovery(child, version)
    )
}

test(
  "restart recovers interrupted text, updates state time, and preserves activity and saved context",
  handleStreamingRecoveryVersions
)
test(
  "empty and historical schemas migrate to usable stores",
  handleMigrationVersions
)
test(
  "migration failure rolls back the trigger and schema marker",
  handleMigrationRollback
)
test("future schemas are refused without modification", handleFutureVersion)
