/**
 * Steps shared by the journeys that drive the renderer.
 *
 * @remarks Every handle is a stable one the renderer exposes: ARIA labels,
 * titles, roles, test identifiers, and the class names of the composer, the
 * transcript, and Settings. The strings here are JavaScript expressions
 * evaluated in the page.
 */

/** Expression selecting the composer's message textarea. */
export const COMPOSER_TEXTAREA = `document.querySelector('textarea[aria-label^="Message "]')`

/** Expression selecting the composer's Send/Stop button. */
export const SEND_BUTTON = `document.querySelector("button.composer__send")`

/** Expression that is truthy while Send is offered and takes the draft. */
export const SEND_ENABLED = `${SEND_BUTTON} !== null && !${SEND_BUTTON}.disabled && ${SEND_BUTTON}.textContent.trim() === "Send"`

/** Expression selecting the button that opens Past conversations. */
export const PAST_CONVERSATIONS_BUTTON = `document.querySelector('button[title="Past conversations (⌘K)"]')`

/** Expression selecting the Past conversations dialog, `null` while closed. */
export const PAST_CONVERSATIONS_DIALOG = `document.querySelector('[aria-label="Past conversations"]')`

/**
 * Expression that is truthy once no reply streams in the shown conversation:
 * the streaming caret is gone and the composer's button reads Send.
 */
export const REPLY_FINISHED = `document.querySelector('[data-testid="streaming-caret"]') === null && ${SEND_BUTTON}?.textContent.trim() === "Send"`

/**
 * Expression selecting the newest message shown under an agent's portrait,
 * `undefined` when there is none.
 */
export const LAST_ASSISTANT_MESSAGE = `[...document.querySelectorAll("article.chat-view__message--lys")].at(-1)`

/**
 * Expression reading the text of the newest assistant message, without its
 * buttons and streaming caret.
 */
export const LAST_ASSISTANT_TEXT = `(() => {
  const article = ${LAST_ASSISTANT_MESSAGE};
  if (!article) return "";
  const copy = article.cloneNode(true);
  for (const element of copy.querySelectorAll('button, [data-testid="streaming-caret"]')) element.remove();
  return copy.textContent;
})()`

/**
 * Expression listing the transcript's messages in order, each with its
 * speaker label, the text a person or delegator wrote (`null` for a reply or
 * a reports row), and whether it shows under an agent's portrait.
 */
export const TRANSCRIPT_MESSAGES = `[...document.querySelectorAll("article.chat-view__message")].map((article) => ({
  speaker: article.querySelector(".chat-view__speaker")?.textContent.trim() ?? null,
  copy: article.querySelector(".chat-view__user-copy")?.textContent ?? null,
  isAgent: article.classList.contains("chat-view__message--lys")
}))`

/**
 * Expression listing the texts the composer's notices show, such as the
 * jobs bar's `1 job is working` or a job's read-only notice; empty notices
 * are left out.
 */
export const COMPOSER_NOTICE_TEXTS = `[...document.querySelectorAll("output.composer__notice-message")].map((output) => output.textContent.trim()).filter((text) => text !== "")`

/**
 * Expression selecting the card a reply shows while a tool call waits for
 * the person's answer.
 */
export const TOOL_APPROVAL_CARD = `document.querySelector('[aria-label="Tool call waiting for your answer"]')`

/**
 * Builds the expression selecting a button by the start of its visible
 * text, for buttons whose text ends in a key hint such as Allow once.
 *
 * @param {string} text - Start of the button's trimmed text.
 * @returns {string} The expression, which yields `undefined` when no button
 * matches.
 */
export function buildButtonExpression(text) {
  return `[...document.querySelectorAll("button")].find((button) => button.textContent.trim().startsWith(${JSON.stringify(text)}))`
}

/**
 * Builds the expression selecting a button by its accessible name, such as
 * a job card's `Fox report, job 1` or the jobs bar's `Stop all jobs`.
 *
 * @param {string} label - The button's `aria-label`.
 * @returns {string} The expression.
 */
export function buildLabeledButtonExpression(label) {
  return `document.querySelector(${JSON.stringify(`button[aria-label=${JSON.stringify(label)}]`)})`
}

/**
 * Builds the expression reading a job card, found by the accessible name of
 * the button that opens its job.
 *
 * @param {string} label - The open button's name, `<title>, job <number>`.
 * @returns {string} The expression, which yields `null` while no card has
 * that button, else the card's element identifier (`job-<job id>`), its
 * `data-state`, the agent name, state label, and note it shows (`null`
 * without a note), whether it offers Stop, and whether it sits inside a
 * reply.
 */
export function buildJobCardExpression(label) {
  return `(() => {
    const card = ${buildLabeledButtonExpression(label)}?.closest("article.chat-view__job");
    if (!card) return null;
    const meta = card.querySelectorAll(".chat-view__job-meta span");
    return {
      elementId: card.id,
      state: card.dataset.state,
      agentName: meta[0]?.textContent.trim() ?? null,
      stateLabel: card.querySelector(".chat-view__job-state")?.textContent.trim() ?? null,
      note: card.querySelector(".chat-view__job-note")?.textContent ?? null,
      hasStop: card.querySelector(".chat-view__job-stop") !== null,
      isInReply: card.closest("article.chat-view__message--lys") !== null
    };
  })()`
}

/**
 * Builds the expression selecting the line that opens to the reports a
 * message delivered, by its visible text.
 *
 * @param {string} label - The line's text, such as `Reports · 2`.
 * @returns {string} The expression, which yields `undefined` when no line
 * has that text.
 */
export function buildReportsLineExpression(label) {
  return `[...document.querySelectorAll("details.chat-view__reports > summary")].find((summary) => summary.textContent.trim() === ${JSON.stringify(label)})`
}

/**
 * Builds the expression reading the reports a message's line opens to.
 *
 * @param {string} label - The line's text, such as `Reports · 2`.
 * @returns {string} The expression, which yields `null` when no line has
 * that text, else whether its disclosure is open and each report's heading
 * (`<agent> · <title> · <kind>`) and text in order.
 */
export function buildDeliveredReportsExpression(label) {
  return `(() => {
    const details = ${buildReportsLineExpression(label)}?.closest("details");
    if (!details) return null;
    return {
      isOpen: details.open,
      reports: [...details.querySelectorAll("li.chat-view__report")].map((report) => ({
        heading: report.querySelector(".chat-view__report-heading")?.textContent.trim() ?? null,
        content: report.querySelector(".chat-view__report-content")?.textContent ?? ""
      }))
    };
  })()`
}

/**
 * Builds the expression reading one row of the Tools pane of Settings,
 * found by the tool's name.
 *
 * @param {string} toolName - Name the row shows.
 * @returns {string} The expression, which yields `null` while no row shows
 * the name, else the heading of the row's group and its access label.
 */
export function buildToolRowExpression(toolName) {
  return `(() => {
    const name = [...document.querySelectorAll(".settings-view__tool-name")].find((element) => element.textContent.trim() === ${JSON.stringify(toolName)});
    const row = name?.closest(".settings-view__tool-row");
    if (!row) return null;
    return {
      groupHeading: row.closest("section.settings-view__tool-group")?.querySelector("h2")?.textContent.trim() ?? null,
      accessLabel: row.querySelector('[data-badge="access"]')?.textContent.trim() ?? null
    };
  })()`
}

/**
 * Builds the expression selecting a switch by its accessible name.
 *
 * @param {string} label - The switch's `aria-label`.
 * @returns {string} The expression.
 */
export function buildSwitchExpression(label) {
  return `document.querySelector('[role="switch"][aria-label=${JSON.stringify(label)}]')`
}

/** Expression reading the Runtime pane's backend status heading. */
const BACKEND_STATUS_HEADING = `document.querySelector('[aria-label="Backend status"] h2')`

/**
 * One settings pane: its label in the settings rail and what shows it is
 * rendered.
 *
 * @typedef {object} SettingsPane
 * @property {string} label - Start of the rail entry's text.
 * @property {string} readyExpression - Expression that is truthy once the
 * pane's content is on the page.
 */

/** The Runtime pane, with the backend status card. */
export const RUNTIME_PANE = Object.freeze({
  label: "Runtime",
  readyExpression: `${BACKEND_STATUS_HEADING} !== null`
})

/** The Tools pane, once Lys's own tools are listed by group. */
export const TOOLS_PANE = Object.freeze({
  label: "Tools",
  readyExpression: `document.querySelector("section.settings-view__tool-group") !== null`
})

/** The Generation pane, with the Reply ceiling switch. */
export const GENERATION_PANE = Object.freeze({
  label: "Generation",
  readyExpression: `${buildSwitchExpression("Reply ceiling")} !== null`
})

/**
 * Waits until the composer accepts a message for the conversation's agent.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<string>} The placeholder, `Say something to <agent>`.
 * @throws If the composer still waits on the backend or provider in time.
 */
export function waitForComposerReady(page, timeoutMs) {
  return page.waitForPageCondition({
    description: 'the composer to be ready (placeholder "Say something to …")',
    expression: `(() => {
      const textarea = ${COMPOSER_TEXTAREA};
      if (!textarea) return false;
      return textarea.placeholder.startsWith("Say something to") ? textarea.placeholder : false;
    })()`,
    timeoutMs
  })
}

/**
 * Types a message into the composer and presses Send once it enables.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page, with
 * the composer ready.
 * @param {string} message - Text to type.
 * @returns {Promise<{message: string}>} The message sent.
 * @throws If Send does not enable within 5 seconds.
 */
export async function sendComposerMessage(page, message) {
  await page.click(COMPOSER_TEXTAREA)
  await page.typeText(message)
  await page.waitForPageCondition({
    description: "the Send button to enable",
    expression: SEND_ENABLED,
    timeoutMs: 5000
  })
  await page.click(SEND_BUTTON)
  return { message }
}

/**
 * Waits until the app shell is on the page: the store finished loading
 * settings and the composer with its Settings button is rendered, whether
 * or not the backend and provider are ready.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<string>} The composer's placeholder at that moment.
 * @throws If the shell does not render in time.
 */
export function waitForAppShell(page, timeoutMs) {
  return page.waitForPageCondition({
    description: "the app shell (composer with its Settings button)",
    expression: `(() => {
      const textarea = ${COMPOSER_TEXTAREA};
      const settings = document.querySelector('button[title="Settings"]');
      return textarea !== null && settings !== null ? textarea.placeholder : false;
    })()`,
    timeoutMs
  })
}

/**
 * Opens Settings from the composer and selects one pane.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page.
 * @param {SettingsPane} pane - The pane to show.
 * @returns {Promise<void>} Resolves once the pane's content is rendered.
 * @throws If the settings view or the pane does not appear in time.
 */
export async function openSettingsPane(page, pane) {
  await page.click(`document.querySelector('button[title="Settings"]')`)
  await page.waitForPageCondition({
    description: "the settings sections",
    expression: `document.querySelector('[aria-label="Settings sections"]') !== null`,
    timeoutMs: 10_000
  })
  await page.click(
    `[...document.querySelectorAll('[aria-label="Settings sections"] > ul > li > button')].find((entry) => entry.textContent.startsWith(${JSON.stringify(pane.label)}))`
  )
  await page.waitForPageCondition({
    description: `the ${pane.label} pane`,
    expression: pane.readyExpression,
    timeoutMs: 15_000
  })
}

/**
 * Closes Settings with its Done button and waits for the chat's composer.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page, with
 * Settings shown.
 * @returns {Promise<void>} Resolves once the composer is ready again.
 * @throws If the Done button is missing or the composer is not ready within
 * 10 seconds.
 */
export async function closeSettingsView(page) {
  await page.click(`document.querySelector("button.settings-view__done")`)
  await waitForComposerReady(page, 10_000)
}

/**
 * Reads a switch's state.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page.
 * @param {string} label - The switch's `aria-label`.
 * @returns {Promise<string | null>} `"true"`, `"false"`, or `null` when
 * the switch is absent.
 */
export function readSwitchState(page, label) {
  return page.evaluate(
    `${buildSwitchExpression(label)}?.getAttribute("aria-checked") ?? null`
  )
}

/**
 * Waits for a switch to show a state.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page.
 * @param {{label: string, expected: "true" | "false", timeoutMs: number}} options -
 * The switch, the state, and the deadline.
 * @returns {Promise<unknown>} Resolves once the state shows.
 * @throws If the deadline passes first.
 */
export function waitForSwitchState(page, { label, expected, timeoutMs }) {
  return page.waitForPageCondition({
    description: `the "${label}" switch to be ${expected === "true" ? "on" : "off"}`,
    expression: `${buildSwitchExpression(label)}?.getAttribute("aria-checked") === ${JSON.stringify(expected)}`,
    timeoutMs
  })
}

/**
 * Waits for the Runtime pane's backend status heading to read a label.
 *
 * @param {import("./rendererPage.mjs").RendererPage} page - The page.
 * @param {string} expected - The heading text, such as `Backend running`.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<unknown>} Resolves once the heading reads it.
 * @throws If the deadline passes first.
 */
export function waitForBackendStatusLabel(page, expected, timeoutMs) {
  return page.waitForPageCondition({
    description: `the backend status to read "${expected}"`,
    expression: `${BACKEND_STATUS_HEADING}?.textContent.trim() === ${JSON.stringify(expected)}`,
    timeoutMs
  })
}
