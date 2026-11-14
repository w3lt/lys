# Lys feature map

One file per user-facing feature the `verify-lys` harness can prove. Each
file has the same four sections: `Sub-features`, `How to get to it (user
POV)`, `Driving it with verify-lys`, and `Gotchas`. The map is the maintained
source of what is verified; a proof that drives one convenient entry point is
incomplete when the file lists others. Keep it honest with
`/pstack:maintain-verification-skill` when the app changes.

Drive a feature's journeys from the repository root, sandbox off:

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --journey <journey-id> [--journey <journey-id>]
```

| Feature                                         | Journeys                                                                   | Last proved                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Chat streaming](chat-streaming.md)             | `chat-stream-api`, `chat-stream-ui`                                        | 2026-11-14 at `b93854ea` with the #360 work tree, both passed, the reply stored with provider `ollama`; 2026-11-01 at `cdb09874`, both failed on the held-back regression |
| [Settings persistence](settings-persistence.md) | `settings-generation-ui`, `settings-autostart-ui`                          | 2026-11-14 at `b93854ea` with the #360 work tree, both passed                                                                                                             |
| [Backend lifecycle](backend-lifecycle.md)       | `backend-health`, `backend-lifecycle-ui`, `host-lifecycle-native` (opt-in) | 2026-11-14 at `b93854ea` with the #360 work tree, first two passed; native not run (last blocked on 2026-11-01, no GUI session)                                           |

Features Lys has that no journey covers yet, from its routes and panes:
conversation history (rename, delete, search, open a past conversation),
attachments on a message, the tool switches and tool approval flow, the
Agents pane (custom agents), the Models pane (load configuration, load and
unload), the Providers pane (several providers on at once) and the Secrets
pane, MCP servers, vmo and `read_page`, `web_search`, the stop-reply button,
and the context meter. Each needs its own file and journey before it counts
as verified.

To add a feature: write `features/<feature>.md` with the four sections, add a
journey under `scripts/journeys/` that exports `{id, feature, title,
needsRenderer, needsNative, run}` with `feature` naming the file, register it
in `scripts/journeys/index.mjs`, run it, and add the row above.
