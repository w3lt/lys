/**
 * Proves in a real browser that the renderer's shared controls render the
 * type and height their variant declares wherever they are placed, and that
 * every text renders a size from the type scale.
 *
 * @remarks Computed sizes come from the cascade, which a simulated DOM does
 * not implement, so only a browser can observe them. The expected values
 * are the design contract written out here, not read from the tokens, so a
 * changed token fails the journey instead of moving its oracle with it.
 */

import { JourneyFailure, rejectUnless } from "../lib/journey.mjs"
import { ESCAPE_KEY } from "../lib/rendererPage.mjs"
import { waitForComposerReady } from "../lib/rendererSteps.mjs"

/** Every font size, in CSS pixels, the type scale allows. */
const TYPE_SCALE_PX = Object.freeze([10, 11, 12, 13, 14, 16, 18, 24, 32])

/** Text size of controls that hold plain text, in CSS pixels. */
const CONTROL_TEXT_PX = 14

/** Text size of the mono actions and segments, in CSS pixels. */
const META_TEXT_PX = 11

/** Weight of a button's label. */
const BUTTON_LABEL_WEIGHT = 500

/** Smallest pointer target a control may have, in CSS pixels. */
const MINIMUM_TARGET_PX = 24

/** Height of a button or segment by its `data-size`, in CSS pixels. */
const CONTROL_HEIGHT_PX = Object.freeze({
  "icon-xs": 24,
  sm: 28,
  "icon-sm": 28,
  default: 32,
  icon: 32,
  lg: 36,
  "icon-lg": 36
})

/** Height of a one-line field, a text input or a select, in CSS pixels. */
const FIELD_HEIGHT_PX = 32

/** Button variants whose label is plain control text. */
const CONTROL_TEXT_VARIANTS = Object.freeze([
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive"
])

/** Button variants whose label is mono meta text. */
const META_TEXT_VARIANTS = Object.freeze(["text", "back"])

/**
 * Page expression that measures every control and every element with text
 * of its own inside one root, leaving out Markdown replies, whose inline
 * code and citations size themselves relative to the surrounding text.
 *
 * @param {string} rootSelector - CSS selector of the surface to measure.
 * @returns {string} The expression; it evaluates to `{missing}` or the
 * measurements.
 */
function buildMeasureExpression(rootSelector) {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (root === null) return { missing: ${JSON.stringify(rootSelector)} };
    const controlSelector = '[data-slot="button"], [data-slot="toggle-group-item"], [data-slot="input"], [data-slot="native-select"], [data-slot="textarea"]';
    const measurements = [];
    for (const element of root.querySelectorAll("*")) {
      if (element.closest(".markdown-message") !== null) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const isControl = element.matches(controlSelector);
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("")
        .trim();
      if (!isControl && ownText === "") continue;
      const style = getComputedStyle(element);
      measurements.push({
        label: (ownText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.innerText || element.tagName).trim().slice(0, 48),
        tag: element.tagName.toLowerCase(),
        slot: element.dataset.slot ?? null,
        variant: element.dataset.variant ?? null,
        size: element.dataset.size ?? null,
        isControl,
        fontSizePx: Number.parseFloat(style.fontSize),
        fontWeight: Number(style.fontWeight),
        isMono: style.fontFamily.includes("Mono"),
        heightPx: box.height,
        parentFontSizePx: Number.parseFloat(getComputedStyle(element.parentElement).fontSize)
      });
    }
    return { measurements };
  })()`
}

/**
 * Tells whether two pixel lengths are equal within rounding.
 *
 * @param {number} actualPx - Measured length.
 * @param {number} expectedPx - Contract length.
 * @returns {boolean} `true` within half a pixel.
 */
function isSameLength(actualPx, expectedPx) {
  return Math.abs(actualPx - expectedPx) < 0.5
}

/**
 * Lists how a measured text departs from the mono meta text.
 *
 * @param {object} measurement - The element's measurement.
 * @param {string} kind - What the element is, for the message.
 * @returns {string[]} The departure; empty when it complies.
 */
function findMetaTextDepartures(measurement, kind) {
  if (isSameLength(measurement.fontSizePx, META_TEXT_PX) && measurement.isMono)
    return []
  const family = measurement.isMono ? "mono" : "sans"
  return [
    `${kind} text ${measurement.fontSizePx}px ${family}, not ${META_TEXT_PX}px mono`
  ]
}

/**
 * Lists how a measured control departs from the height of its `data-size`.
 *
 * @param {object} measurement - The control's measurement.
 * @param {string} kind - What the control is, for the message.
 * @returns {string[]} The departure; empty when it complies.
 */
function findHeightDepartures(measurement, kind) {
  const size = measurement.size ?? "default"
  const expectedHeightPx = CONTROL_HEIGHT_PX[size]
  if (isSameLength(measurement.heightPx, expectedHeightPx)) return []
  return [
    `${kind} ${measurement.heightPx}px tall, not ${expectedHeightPx}px for size ${size}`
  ]
}

/**
 * Lists how a `link` button departs from the size of the text around it.
 *
 * @param {object} measurement - The button's measurement.
 * @returns {string[]} The departure; empty when it complies.
 */
function findLinkDepartures(measurement) {
  if (isSameLength(measurement.fontSizePx, measurement.parentFontSizePx))
    return []
  return [
    `link text ${measurement.fontSizePx}px, not the ${measurement.parentFontSizePx}px around it`
  ]
}

/**
 * Lists how a `text` or `back` button departs from its contract: mono meta
 * text on a target at least 24 px tall.
 *
 * @param {object} measurement - The button's measurement.
 * @returns {string[]} The departures; empty when it complies.
 */
function findMetaActionDepartures(measurement) {
  const departures = findMetaTextDepartures(measurement, measurement.variant)
  if (measurement.heightPx < MINIMUM_TARGET_PX - 0.5)
    departures.push(`target ${measurement.heightPx}px tall`)
  return departures
}

/**
 * Lists how a framed button departs from its contract: a medium label in the
 * control text, at the height of its size.
 *
 * @param {object} measurement - The button's measurement.
 * @returns {string[]} The departures; empty when it complies.
 */
function findFramedButtonDepartures(measurement) {
  const departures = findHeightDepartures(measurement, "button")
  if (!isSameLength(measurement.fontSizePx, CONTROL_TEXT_PX))
    departures.push(
      `label ${measurement.fontSizePx}px, not ${CONTROL_TEXT_PX}px`
    )
  if (measurement.fontWeight !== BUTTON_LABEL_WEIGHT)
    departures.push(
      `label weight ${measurement.fontWeight}, not ${BUTTON_LABEL_WEIGHT}`
    )
  return departures
}

/**
 * Lists how a shared button departs from the contract of its variant, which
 * is `default` when the button exposes none.
 *
 * @param {object} measurement - The button's measurement.
 * @returns {string[]} The departures; empty when it complies.
 */
function findButtonDepartures(measurement) {
  const variant = measurement.variant ?? "default"
  if (variant === "link") return findLinkDepartures(measurement)
  if (META_TEXT_VARIANTS.includes(variant))
    return findMetaActionDepartures(measurement)
  if (CONTROL_TEXT_VARIANTS.includes(variant))
    return findFramedButtonDepartures(measurement)
  return [`unknown variant ${variant}`]
}

/**
 * Lists how a toggle-group item departs from its contract: a mono meta
 * segment at the height of its size.
 *
 * @param {object} measurement - The item's measurement.
 * @returns {string[]} The departures; empty when it complies.
 */
function findSegmentDepartures(measurement) {
  return [
    ...findMetaTextDepartures(measurement, "segment"),
    ...findHeightDepartures(measurement, "segment")
  ]
}

/**
 * Lists how a one-line field departs from its contract: control text, 32 px
 * tall.
 *
 * @param {object} measurement - The field's measurement.
 * @returns {string[]} The departures; empty when it complies.
 */
function findFieldDepartures(measurement) {
  const departures = []
  if (!isSameLength(measurement.fontSizePx, CONTROL_TEXT_PX))
    departures.push(`field text ${measurement.fontSizePx}px, not 14px`)
  if (!isSameLength(measurement.heightPx, FIELD_HEIGHT_PX))
    departures.push(`field ${measurement.heightPx}px tall, not 32px`)
  return departures
}

/**
 * Lists how a textarea departs from its contract: control text.
 *
 * @param {object} measurement - The textarea's measurement.
 * @returns {string[]} The departure; empty when it complies.
 */
function findTextareaDepartures(measurement) {
  if (isSameLength(measurement.fontSizePx, CONTROL_TEXT_PX)) return []
  return [`textarea text ${measurement.fontSizePx}px, not 14px`]
}

/** The contract check of each shared control, by its `data-slot`. */
const SLOT_CHECKS = Object.freeze({
  button: findButtonDepartures,
  "toggle-group-item": findSegmentDepartures,
  input: findFieldDepartures,
  "native-select": findFieldDepartures,
  textarea: findTextareaDepartures
})

/**
 * Lists how one measured element departs from the type scale and, for a
 * shared control, from its primitive's contract.
 *
 * @param {object} measurement - The element's measurement.
 * @returns {string[]} The departures; empty when it complies.
 */
function findDepartures(measurement) {
  const isOnScale = TYPE_SCALE_PX.some((sizePx) =>
    isSameLength(measurement.fontSizePx, sizePx)
  )
  const departures = isOnScale
    ? []
    : [`${measurement.fontSizePx}px is not on the type scale`]
  const checkSlot = SLOT_CHECKS[measurement.slot]
  return checkSlot === undefined
    ? departures
    : [...departures, ...checkSlot(measurement)]
}

/**
 * Names a measured element for a failure message: its tag, its slot,
 * variant, and size when it is a shared control, and its label.
 *
 * @param {object} measurement - The element's measurement.
 * @returns {string} The name.
 */
function describeMeasuredElement(measurement) {
  const slotParts = [measurement.slot, measurement.variant, measurement.size]
    .filter((part) => part !== null)
    .join(" ")
  const slot = slotParts === "" ? "" : `[${slotParts}]`
  return `${measurement.tag}${slot} "${measurement.label}"`
}

/**
 * Measures one surface, saves the measurements and a screenshot, and
 * rejects when anything departs from the contract.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {object} evidence - The step's evidence recorder.
 * @param {{name: string, rootSelector: string}} surface - What to measure.
 * @returns {Promise<{controls: number, texts: number}>} How many controls and
 * texts complied.
 * @throws If the surface is missing or anything departs.
 */
async function checkSurface(page, evidence, surface) {
  const result = await page.evaluate(
    buildMeasureExpression(surface.rootSelector)
  )
  rejectUnless(
    result.missing === undefined,
    `${surface.name} is not shown.`,
    result
  )
  await page.captureScreenshot(evidence.buildPath(`${surface.name}.png`))
  evidence.saveJson(`${surface.name}-measurements.json`, result.measurements)
  const violations = result.measurements
    .map((measurement) => ({
      element: describeMeasuredElement(measurement),
      departures: findDepartures(measurement)
    }))
    .filter((entry) => entry.departures.length > 0)
  rejectUnless(
    violations.length === 0,
    `${surface.name}: ${violations.length} element(s) depart from the type scale or their control's contract.`,
    violations
  )
  const controls = result.measurements.filter(
    (measurement) => measurement.isControl
  )
  return {
    controls: controls.length,
    texts: result.measurements.length - controls.length
  }
}

/**
 * Clicks the first button inside a root whose visible text matches.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {string} rootSelector - Where to look.
 * @param {RegExp} pattern - The text to match, case-insensitive as written.
 * @returns {Promise<void>} Resolves once clicked.
 */
function clickButtonByText(page, rootSelector, pattern) {
  return page.click(
    `[...document.querySelectorAll(${JSON.stringify(`${rootSelector} button`)})].find((button) => ${pattern}.test(button.innerText.trim()))`
  )
}

/**
 * Opens one settings pane from the rail and waits until it has read its
 * settings.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {string} label - The pane's name as the rail shows it.
 * @returns {Promise<void>} Resolves once the pane's heading reads the name
 * and its "Reading … settings" status is gone.
 */
async function openPane(page, label) {
  await clickButtonByText(
    page,
    '[aria-label="Settings sections"]',
    new RegExp(`^${label}\\b`)
  )
  await page.waitForPageCondition({
    description: `the ${label} pane, read`,
    expression: `document.querySelector(".settings-view h1")?.innerText.trim() === ${JSON.stringify(label)} && ![...document.querySelectorAll('.settings-view [role="status"]')].some((status) => /^Reading /.test(status.textContent.trim()))`,
    timeoutMs: 15_000
  })
}

/**
 * Opens Past conversations, measures it, and closes it again whether or not
 * it complies.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {object} evidence - The step's evidence recorder.
 * @returns {Promise<{controls: number, texts: number}>} What complied.
 * @throws If the dialog does not open or anything in it departs.
 */
async function checkPastConversations(page, evidence) {
  await page.click(
    `document.querySelector('button[title="Past conversations (⌘K)"]')`
  )
  await page.waitForPageCondition({
    description: "the Past conversations dialog",
    expression: `document.querySelector('[aria-label="Past conversations"]') !== null`,
    timeoutMs: 10_000
  })
  try {
    return await checkSurface(page, evidence, {
      name: "past-conversations",
      rootSelector: '[aria-label="Past conversations"]'
    })
  } finally {
    await page.pressKey(ESCAPE_KEY)
  }
}

/**
 * Opens Settings and reads the panes its rail lists.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @returns {Promise<string[]>} Each pane's name, in rail order.
 * @throws If the rail lists no pane.
 */
async function openSettings(page) {
  await page.click(`document.querySelector('button[title="Settings"]')`)
  await page.waitForPageCondition({
    description: "the settings sections",
    expression: `document.querySelector('[aria-label="Settings sections"]') !== null`,
    timeoutMs: 10_000
  })
  const labels = await page.evaluate(
    `[...document.querySelectorAll('[aria-label="Settings sections"] > ul > li > button')].map((button) => button.innerText.split("\\n")[0].trim())`
  )
  rejectUnless(labels.length > 0, "The rail lists no panes.", labels)
  return labels
}

/**
 * Surfaces a pane opens from one of its buttons: the step name, the pane,
 * the button that opens it, and the condition that shows it is open.
 */
const OPENED_SURFACES = Object.freeze([
  {
    step: "Settings → MCP → email: the mailbox card",
    name: "mcp-mailbox",
    pane: "MCP",
    opener: {
      rootSelector: '[aria-label="MCP servers"]',
      pattern: /^email\b/i
    },
    shown: {
      description: "the mailbox card",
      expression: `[...document.querySelectorAll(".settings-view h3")].some((heading) => heading.innerText.trim() === "Your email account")`
    }
  },
  {
    step: "Settings → Agents → New agent: the agent editor",
    name: "agent-editor",
    pane: "Agents",
    opener: { rootSelector: ".settings-view", pattern: /^New agent$/ },
    shown: {
      description: "the agent editor",
      expression: `document.querySelector(".settings-view textarea") !== null`
    }
  },
  {
    step: "Settings → MCP → Add server: the server editor",
    name: "mcp-editor",
    pane: "MCP",
    opener: { rootSelector: ".settings-view", pattern: /^Add server$/ },
    shown: {
      description: "the server editor",
      expression: `[...document.querySelectorAll(".settings-view button")].some((button) => /^Cancel$/.test(button.innerText.trim()))`
    }
  }
])

/**
 * Opens a pane, presses the button that opens one of its surfaces, waits for
 * the surface, and measures the settings view.
 *
 * @param {import("../lib/rendererPage.mjs").RendererPage} page - The page.
 * @param {object} evidence - The step's evidence recorder.
 * @param {(typeof OPENED_SURFACES)[number]} surface - What to open.
 * @returns {Promise<{controls: number, texts: number}>} What complied.
 * @throws If the surface does not open or anything in it departs.
 */
async function checkOpenedSurface(page, evidence, surface) {
  await openPane(page, surface.pane)
  await clickButtonByText(
    page,
    surface.opener.rootSelector,
    surface.opener.pattern
  )
  await page.waitForPageCondition({ ...surface.shown, timeoutMs: 10_000 })
  return checkSurface(page, evidence, {
    name: surface.name,
    rootSelector: ".settings-view"
  })
}

/** The journey. */
export default Object.freeze({
  id: "controls-and-type-ui",
  feature: "controls-and-type",
  title:
    "Shared controls render their variant's type and height everywhere, and every text is on the type scale",
  needsRenderer: true,
  needsNative: false,
  async run(steps, context) {
    const page = await context.openPage()
    const failedSurfaces = []
    /**
     * Runs one surface step and keeps going when it fails, so a run lists
     * every surface that departs instead of only the first.
     *
     * @param {string} name - The step's name.
     * @param {(evidence: object) => Promise<unknown>} body - The step.
     * @returns {Promise<void>} Resolves once the step has finished.
     */
    const checkStep = async (name, body) => {
      try {
        await steps.step(name, body)
      } catch (error) {
        if (!(error instanceof JourneyFailure)) throw error
        failedSurfaces.push(name)
      }
    }
    try {
      await checkStep("the chat view", async (evidence) => {
        await waitForComposerReady(page, 60_000)
        return checkSurface(page, evidence, {
          name: "chat",
          rootSelector: ".app-shell"
        })
      })
      await checkStep("Past conversations", (evidence) =>
        checkPastConversations(page, evidence)
      )
      const paneLabels = await steps.step("open Settings", () =>
        openSettings(page)
      )
      for (const label of paneLabels) {
        await checkStep(`Settings → ${label}`, async (evidence) => {
          await openPane(page, label)
          return checkSurface(page, evidence, {
            name: `settings-${label.toLowerCase()}`,
            rootSelector: ".settings-view"
          })
        })
      }
      for (const surface of OPENED_SURFACES) {
        await checkStep(surface.step, (evidence) =>
          checkOpenedSurface(page, evidence, surface)
        )
      }
      rejectUnless(
        failedSurfaces.length === 0,
        `${failedSurfaces.length} surface(s) depart from the type scale or their controls' contract.`,
        failedSurfaces
      )
    } finally {
      await page.close()
    }
  }
})
