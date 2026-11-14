# Chat streaming

Sending a message in the composer makes the backend ask the provider of the
conversation's model for a reply and stream it back as server-sent events;
the renderer shows the text as it arrives, then the finished reply, and the
conversation gets a generated title.

## Sub-features

- Sending a message starts a new conversation with the composer's agent
  (default `caliginia`) and stores the user message before generation starts.
- The composer names the conversation's model by its key and provider
  (`lys-verify:latest · Ollama`), and the chat request carries both as
  `model: {provider, modelKey}`.
- The reply streams: the backend sends a `reply-part` event that opens the
  text part with its first fragment, then one `reply-part-delta` event per
  fragment, each stored before it is sent, then `done` with the finish reason.
- The renderer shows the partial text with a streaming caret, offers Stop
  instead of Send while the reply runs, and shows the whole reply when done.
- A title is generated in a separate provider request and arrives as a
  `title` event; the conversation shows it in Past conversations.
- The reply and title are stored in SQLite (`conversations`,
  `conversation_messages`) and can be read back through
  `GET /api/v1/conversations/:id`. The assistant message stores its model's
  key and provider (`model` and `provider`), since the same key on two
  providers names two models.
- Not covered here: the Stop button, reasoning parts, tool calls, attachments,
  continuing an existing conversation, and `length` finishes.

## How to get to it (user POV)

Open Lys with the backend running and a model loaded. The composer at the
bottom reads `Say something to Caliginia`. Type a message and press Send (or
Enter). The reply appears under the agent's name word by word with a caret;
the Send button reads Stop. When the reply ends, Send comes back. Open Past
conversations (the list icon, ⌘K) to see the conversation under its
generated title.

## Driving it with verify-lys

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --journey chat-stream-api --journey chat-stream-ui
```

`chat-stream-api` (`scripts/journeys/chatStreamApi.mjs`) posts
`{conversation: {kind: "new", agentCode: "caliginia"}, message, model:
{provider: "ollama", modelKey: "lys-verify:latest"}, generationOptions:
{temperature: 0.7, replyCeiling: 2048}}` to `POST /api/v1/chat`, records
every event with its arrival time (`evidence/chat-stream-api/01-events.json`,
`01-timeline.json`), and checks:
first event `start-new-conversation-turn`; a `reply-part` of kind `text`; at
least 10 `reply-part-delta` events for that part spread over at least 1000 ms
(the fake provider sends 37 words 120 ms apart, so a whole-block reply cannot
pass); part content plus deltas equal the provider's reply; `done` with
`stop`; `title` equal to `Verification streaming chat`. It then reads
`GET /api/v1/conversations/:id` until the assistant message has
`finishReason: "stop"` and checks the text part, the title, and that the
assistant message has `model: "lys-verify:latest"` and `provider: "ollama"`
(`02-conversation.json`). It reads the SQLite rows read-only
(`03-sqlite-rows.json`) and checks that the reply text row's `reply_id` is
the turn's assistant message and that this message's row stores `model`
`lys-verify:latest` and `provider` `ollama`, which proves the provider is
stored with the reply. Last, it checks the provider's request log
for exactly one streamed completion carrying the user message and one
non-streamed completion with a response format (the title).

`chat-stream-ui` (`scripts/journeys/chatStreamUi.mjs`) opens the renderer,
waits for the placeholder `Say something to …`, clicks
`textarea[aria-label^="Message "]`, inserts the message, clicks
`button.composer__send` once it reads `Send`, waits for
`[data-testid="streaming-caret"]`, screenshots mid-stream
(`03-streaming.png`) and records the newest `article.chat-view__message--lys`
text, which must contain `Lys verification reply:` and not yet `all at once.`
while the button reads `Stop`; waits for the caret to go and the button to
read `Send`, screenshots (`04-complete.png`) and checks the whole reply is
shown and longer than the mid-stream text; clicks
`button[title="Past conversations (⌘K)"]`, waits for
`[aria-label="Past conversations"]` to contain the title, screenshots
(`05-history.png`), and presses Escape.

Expected end state: both journeys `passed`; the run's
`logs/lys-home/lys_db.sqlite` holds the conversation with its title.

## Gotchas

- The provider is `scripts/fake-ollama.mjs`, not a model: the reply text,
  title, and 120 ms word interval are constants in
  `scripts/lib/verificationProvider.mjs`. Change them there and the journeys
  follow.
- The provider is on the assistant message's row, not on the reply text:
  the text sits in a row of role `text` whose `reply_id` names the assistant
  row. SQLite allows `provider` only on assistant rows, and replies stored
  before Lys recorded providers hold `NULL`.
- The first fragment is not a delta: it rides in the `reply-part` event that
  opens the text part. Reconstruct text as `part.content` plus the deltas, or
  the first word is missing.
- The title request is sent at once, so `title` usually arrives before the
  first `reply-part`; do not assume event order beyond the start event first.
- Proved alive on 2026-11-01: holding the reply back in
  `apps/backend/src/modules/chat/openAiReplyModel.ts` until the finish reason
  made `chat-stream-api` fail with `deltaCount: 0` and `chat-stream-ui` fail
  with the mid-stream text showing only the agent name; restoring the file
  made both pass again.
- The mid-stream screenshot depends on the reply lasting a few seconds; a
  provider that answers in one chunk makes the mid-stream step fail, which is
  the intended signal.
