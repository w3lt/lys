/** Immutable historical SQL from 19edf31, schema versions 1–3; never derive upgrade fixtures from current migrations. */
export const legacyMigrations = Object.freeze([
  `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `,
  `
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
  `,
  `
    CREATE TRIGGER update_conversation_updated_at
    AFTER UPDATE ON conversations
    FOR EACH ROW
    WHEN NEW.updated_at <= OLD.updated_at
    BEGIN
      UPDATE conversations
      SET updated_at = CASE
        WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') > OLD.updated_at
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ELSE strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          OLD.updated_at,
          '+0.001 seconds'
        )
      END
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER update_conversation_after_message_update
    AFTER UPDATE ON conversation_messages
    FOR EACH ROW
    BEGIN
      UPDATE conversations
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = NEW.conversation_id;
    END;
  `
])
