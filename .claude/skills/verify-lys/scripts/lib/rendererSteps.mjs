/**
 * Steps shared by the journeys that drive the renderer.
 *
 * @remarks Every handle is a stable one the renderer exposes: ARIA labels,
 * titles, roles, test identifiers, and the composer's class names. The
 * strings here are JavaScript expressions evaluated in the page.
 */

/** Expression selecting the composer's message textarea. */
export const COMPOSER_TEXTAREA = `document.querySelector('textarea[aria-label^="Message "]')`

/** Expression selecting the composer's Send/Stop button. */
export const SEND_BUTTON = `document.querySelector("button.composer__send")`

/**
 * Expression reading the text of the newest assistant message, without its
 * buttons and streaming caret.
 */
export const LAST_ASSISTANT_TEXT = `(() => {
  const article = [...document.querySelectorAll("article.chat-view__message--lys")].at(-1);
  if (!article) return "";
  const copy = article.cloneNode(true);
  for (const element of copy.querySelectorAll('button, [data-testid="streaming-caret"]')) element.remove();
  return copy.textContent;
})()`

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
 * One settings pane: its tab label and what shows it is rendered.
 *
 * @typedef {object} SettingsPane
 * @property {string} label - Start of the tab's text.
 * @property {string} readyExpression - Expression that is truthy once the
 * pane's content is on the page.
 */

/** The Runtime pane, with the backend status card. */
export const RUNTIME_PANE = Object.freeze({
  label: "Runtime",
  readyExpression: `${BACKEND_STATUS_HEADING} !== null`
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
    `[...document.querySelectorAll('[aria-label="Settings sections"] [role="tab"]')].find((tab) => tab.textContent.startsWith(${JSON.stringify(pane.label)}))`
  )
  await page.waitForPageCondition({
    description: `the ${pane.label} pane`,
    expression: pane.readyExpression,
    timeoutMs: 15_000
  })
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
