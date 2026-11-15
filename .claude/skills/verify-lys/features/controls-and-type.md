# Controls and type

Every text in the renderer is set in one of the nine steps of the type
scale, and every shared control, a Button, ToggleGroup item, Input,
NativeSelect, or Textarea from `apps/desktop/src/components/ui`, renders
the text and height its variant and size declare wherever it is placed.

## Sub-features

- The type scale: 10, 11, 12, 13, 14, 16, 18, 24, and 32 px, declared as
  `--text-*` tokens in `apps/desktop/src/index.css`, used as `text-<step>`
  utilities and `var(--text-<step>)` in stylesheets.
- Button by its `data-variant` (`default` when missing): `default`,
  `outline`, `secondary`, `ghost`, and `destructive` labels are 14 px,
  weight 500; `link` takes the size of the text around it; `text` and
  `back` are 11 px mono and at least 24 px tall.
- Button and ToggleGroup item heights by their `data-size`: `icon-xs` 24,
  `sm` and `icon-sm` 28, `default` and `icon` 32, `lg` and `icon-lg` 36 px.
- ToggleGroup items are 11 px mono segments.
- Input and NativeSelect are 32 px tall with 14 px text; Textarea text is
  14 px.
- Not covered: the composer's model and agent menus and the context meter
  panel, which open only on a pointer press the journey does not make; the
  tool approval prompt; the conversation history's rename and delete rows;
  Markdown replies, whose inline code and headings size themselves in `em`
  relative to the reply's text; the stop reply state.

## How to get to it (user POV)

Open Lys: the chat shows the composer and the starter prompts. Press the
list button in the composer's bottom row for Past conversations. Press the
gear for Settings and pick each pane in the left rail. In MCP, expand the
built-in email server for the mailbox card and press Add server for the
server editor; in Agents, press New agent for the agent editor. The Done,
Save, Refresh, and Add buttons, the fields, and the segments read at one
size in every pane.

## Driving it with verify-lys

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --journey controls-and-type-ui
```

`scripts/journeys/controlsAndTypeUi.mjs` opens the renderer, waits for the
composer to be ready, and checks each surface in turn: the chat
(`.app-shell`), Past conversations, every pane of
`[aria-label="Settings sections"]` (`.settings-view`, after the pane's
heading reads its name and no `Reading …` status remains), the email
server's mailbox card, the agent editor, and the MCP server editor. On each
it measures, in the page, every element with `data-slot` `button`,
`toggle-group-item`, `input`, `native-select`, or `textarea` and every
element with text of its own, outside `.markdown-message`: computed font
size, weight, family, height, the parent's font size, and the slot's
`data-variant` and `data-size`. It saves the screenshot
(`NN-<surface>.png`) and the measurements (`NN-<surface>-measurements.json`)
and fails a surface that has any departure; every surface is checked even
after one fails, and the journey then fails naming them.

Expected end state: `passed`, sixteen steps. With the change reverted, every
shared control's label measures 16 px and weight 400 and every field 16 px.
That was seen on 2026-11-15 with the old unlayered reset put back in
`apps/desktop/src/App.scss`.

## Gotchas

- The expected sizes are written in the journey, not read from the tokens,
  so a changed token fails it instead of moving its oracle.
- A Button without `data-variant` is measured as `default`: a Button that
  stops exposing its variant fails as a 14 px label wherever it is a `text`
  or `back` action.
- The Lys pane renders a skeleton while it reads its settings; the journey
  waits for the `Reading …` status to clear before measuring, or the
  skeleton's sizes would be measured instead.
- The email server's card is expanded by its row button in
  `[aria-label="MCP servers"]` whose text starts with `email`; the journey
  waits for the `Your email account` heading.
- The seeded settings have no email account, so the mailbox card shows the
  sign-in form, not a signed-in account and its Remove account button.
