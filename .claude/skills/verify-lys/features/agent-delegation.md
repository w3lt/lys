# Agent delegation

A built-in agent leads: with the `delegate_work` tool it gives a job to a
custom agent, its member, once the person allows the call. The job is a
conversation of its own under the lead's conversation. The member works in it,
can send progress notes with `report_progress`, and its reply ends the job
with a result. The result wakes the lead: a wake-up turn delivers the reports
the lead has not seen yet, and the lead answers.

## Sub-features

- Settings, Tools lists `delegate_work` under `agents` with the access label
  `gives work`. By default it is switched on and set to Ask me, so each call
  needs the person's approval.
- Built-in agents (`caliginia`, `lysiptera`) are leaders. Every custom agent
  is a member that can take work and is never offered `delegate_work`.
- Allowing the call starts job 1 of the conversation. It is stored as a
  `conversations` row with `parent_conversation_id` and `job_number`. Its
  first message has `origin` `delegator`, holds the instructions, and names
  the call through `job_call_id`.
- The job's card sits in the lead's reply. It shows the title, the member's
  name, the state (`Working`, then `Replied`), the latest progress note, and
  Stop while the job works.
- The lead's reply ends while the job works. Send comes back, and the
  composer's jobs bar reads `1 job is working` with `Stop all jobs`.
- `report_progress` stores a `note` report. The end of the member's reply
  stores a `result` report.
- A result wakes the lead. One wake-up message (`origin` `wake-up`) delivers
  every undelivered report. The transcript shows it as `Reports · N`, one
  report per row headed `<member> · <job title> · Progress note` or
  `Result`, and the lead's reply follows.
- Clicking the card opens the job read-only, with the notice
  `This is a job from <lead>. You can read it and stop it.` and the button
  `Back to the conversation`.
- History (`GET /api/v1/conversations` and Past conversations) lists the
  main conversation and never a job.
- The backend logs `An agent gave work to another agent`,
  `A job report was stored` for each report, and `A wake-up turn started`,
  each with the main conversation's `conversationId`.
- Not covered here: `stop_job`, Stop on a card, `Stop all jobs`, declining
  the call, the `delegate_work` switch turned off, `delegate_work` set to Just
  run, which runs each call without asking, `failed`, `stopped`, and
  `interrupted` reports, several jobs at once, Lysiptera as the lead, recovery
  after a restart, and the sources a delivered report cites (they need the web
  tools).

## How to get to it (user POV)

Open Lys with the backend running and a model loaded. In Settings, Agents,
add a custom agent; it is the member. Settings, Tools shows `delegate_work`
switched on under `agents`; press Done. In a chat with Caliginia, ask it to
give a job to that agent. A card asks `Give <code> the job “<title>”. It gets
only these instructions: <instructions>`; press Allow once. The job's card
shows in Caliginia's reply as `Working` with the member's latest note, and
the bar above the composer reads `1 job is working`. When the member replies,
the card reads `Replied`, a `Reports · 2` row appears, and Caliginia answers
it. Click the card to read the job, then press Back to the conversation.

## Driving it with verify-lys

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --journey agent-delegation-ui
```

The fake provider follows the delegation script in
`scripts/lib/verificationProvider.mjs`. `findScriptedAnswer` looks only at a
streamed request's last message and the tools it offers:

- The delegation message, while `delegate_work` is offered, gets a
  `delegate_work` call for `verify-member`, titled `Fox report`, with the
  instructions `Write the fox sentence.`.
- The instructions, while `report_progress` is offered, get a
  `report_progress` call with the note.
- A `delegate_work` result gets `One agent is working on it.`.
- A `report_progress` result gets the slow verification reply.
- The reports block gets `The fox report is in.`.
- Anything else gets the verification reply, as before.

`agent-delegation-ui` (`scripts/journeys/agentDelegationUi.mjs`) runs ten
steps:

1. It reads `GET /api/v1/agents/verify-member` and posts the member to
   `POST /api/v1/agents` on a 404, so a second run in the same stack passes.
2. It opens the Tools pane and checks that the `delegate_work` row sits under
   `agents`, reads `gives work`, and has its switch `Use delegate_work` on
   (`02-tools-pane.png`). Then it presses Done.
3. It types the delegation message and presses Send.
4. The region `[aria-label="Tool call waiting for your answer"]` must hold the
   call's summary (`04-approval-card.png`). The journey presses Allow once.
5. The button `Fox report, job 1` must sit in the lead's reply. Its card
   must read `Verifier` and `Working`, show the note, and offer Stop
   (`05-job-working.png`).
6. The lead's reply must end as `One agent is working on it.` while the card
   still works. The jobs bar must read `1 job is working` with
   `Stop all jobs` (`06-lead-reply-ended.png`).
7. The card must read `Replied`. `Reports · 2` must open to the note, then
   the result, which holds the member's whole reply. The lead's last reply
   must read `The fox report is in.` (`07-lead-woken.png`).
8. Clicking the card must show the job's notice, a first message under
   `Caliginia` with the instructions, the member's whole reply last under
   `Verifier`, and a disabled message field and Send (`08-job-view.png`). Back
   to the conversation must show the main conversation again
   (`08-main-again.png`).
9. Over the API, the job's id (taken from the card's `job-<id>`) must have
   kind `job` and the main conversation as its parent. The list must hold the
   main conversation and not the job, and Past conversations must not list
   `Fox report` (`09-history.png`).
10. SQLite must hold exactly one job with its one `delegator` message, which
    names the main conversation's `delegate_work` call. It must hold a `note`
    and a `result` report, both delivered by one `wake-up` message of the main
    conversation (`10-sqlite-rows.json`). The backend's log must hold exactly
    one, two, and one of the three log lines for the main conversation
    (`10-backend-log.json`). The provider's log must hold exactly five
    streamed chat requests since Send, one per script line, and the member's
    request must not offer `delegate_work` (`10-provider-requests.json`).

Expected end state: the journey `passed`, and the run's
`logs/lys-home/lys_db.sqlite` holds the main conversation, its job, and both
reports.

Proved alive on 2026-11-16 at `123a452e` with the journey's files
uncommitted: with both `startDueWakeUpTurn` calls in
`apps/backend/src/modules/delegation/replyEnds.ts` taken out, run
`2026-11-16T10-21-07-a638` failed at step 7. The card read `Replied`, but no
`Reports · 2` row and no woken reply came within 60 s. After
`git checkout -- apps/backend/src/modules/delegation/replyEnds.ts`, the full
run `2026-11-16T10-22-18-91b3` passed every journey.

## Gotchas

- The fake answers by the last message only, so the script's texts must stay
  unique. A journey that sends `Give the fox sentence to another agent.` gets
  a `delegate_work` call whenever the tool is offered.
- The tool names are written in `verificationProvider.mjs` because the harness
  cannot import `@lys/share`. Rename a tool there when the backend renames it.
- The provider's request log records each streamed request's
  `offeredToolNames`, `lastMessageRole`, and `scriptedAnswer`. Read it first
  when a step waits for a reply that never comes.
- A note does not wake the lead; only a `result` or `failed` report does. So
  the note waits and is delivered with the result in one wake-up message, and
  the row reads `Reports · 2`. A change that lets notes wake the lead shows up
  as a second wake-up and fails steps 7 and 10.
- The card keeps showing the latest note after the job replies. The journey
  does not check it either way.
- The backend's database carries over within a run, so the member already
  exists when the journey runs twice in one `--keep` stack. Step 1 handles
  it. A second job in the same conversation would be job 2, but every run
  starts a new conversation.
