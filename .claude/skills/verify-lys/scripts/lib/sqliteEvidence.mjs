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

/**
 * Reads the jobs of a main conversation with their job messages and
 * reports.
 *
 * @param {string} databasePath - Absolute path of `lys_db.sqlite`.
 * @param {string} parentConversationId - UUIDv7 of the main conversation.
 * @returns {{jobs: unknown[], jobMessages: unknown[], reports: unknown[]}}
 * The job conversation rows by job number; the user-role message rows of
 * those jobs, oldest first, each with the conversation and tool name of the
 * call part its `job_call_id` names (`call_conversation_id`,
 * `call_tool_name`); and the jobs' report rows, oldest first, each with the
 * conversation and origin of the message that delivered it
 * (`delivered_conversation_id`, `delivered_origin`), both `null` while it
 * waits for delivery.
 * @throws If the database cannot be opened or the tables are missing.
 */
export function readJobRows(databasePath, parentConversationId) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const listRows = (sql) => database.prepare(sql).all(parentConversationId)
    return {
      jobs: listRows(
        "SELECT * FROM conversations WHERE parent_conversation_id = ? ORDER BY job_number"
      ),
      jobMessages: listRows(
        `SELECT message.*, call.conversation_id AS call_conversation_id, call.tool_name AS call_tool_name
         FROM conversation_messages AS message
         JOIN conversations AS job ON job.id = message.conversation_id
         LEFT JOIN conversation_messages AS call ON call.id = message.job_call_id
         WHERE job.parent_conversation_id = ? AND message.role = 'user'
         ORDER BY message.created_at, message.id`
      ),
      reports: listRows(
        `SELECT report.*, delivery.conversation_id AS delivered_conversation_id, delivery.origin AS delivered_origin
         FROM job_reports AS report
         JOIN conversations AS job ON job.id = report.job_conversation_id
         LEFT JOIN conversation_messages AS delivery ON delivery.id = report.delivered_message_id
         WHERE job.parent_conversation_id = ?
         ORDER BY report.created_at, report.id`
      )
    }
  } finally {
    database.close()
  }
}
