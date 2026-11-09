/**
 * Read-only observation of the backend's SQLite database.
 *
 * @remarks Opens the scratch run's `lys_db.sqlite` read-only with Node's
 * built-in `node:sqlite`, so a journey can show that what the API streamed
 * is what the backend stored. Nothing here writes.
 */

import { DatabaseSync } from "node:sqlite"

/**
 * Reads a conversation's row and its message rows.
 *
 * @param {string} databasePath - Absolute path of `lys_db.sqlite`.
 * @param {string} conversationId - UUIDv7 of the conversation.
 * @returns {{conversation: unknown, messages: unknown[]}} The conversation
 * row, or `undefined`, and its messages in position order.
 * @throws If the database cannot be opened or the tables are missing.
 */
export function readConversationRows(databasePath, conversationId) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const conversation = database
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(conversationId)
    const messages = database
      .prepare(
        "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY position, round, id"
      )
      .all(conversationId)
    return { conversation, messages }
  } finally {
    database.close()
  }
}
