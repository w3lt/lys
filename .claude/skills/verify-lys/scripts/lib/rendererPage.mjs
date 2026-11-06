/**
 * Driving the Lys renderer in a Chrome page over the DevTools protocol.
 *
 * @remarks The renderer is the real Vite-served desktop UI. Because the
 * desktop's WKWebView cannot be driven on macOS, the page runs in Chrome
 * with `window.__TAURI_INTERNALS__` replaced by a shim that forwards every
 * `invoke` to the verification host over HTTP. Everything else, from the
 * React store to the backend's server-sent events, is the production code
 * path. Clicks are real mouse events at the element's centre, and typing
 * goes through `Input.insertText`, so React sees ordinary input events.
 */

import { writeFileSync } from "node:fs"
import { waitForCondition } from "./waiting.mjs"

/** Window size `tauri.conf.json` gives the main window. */
export const RENDERER_VIEWPORT = Object.freeze({ width: 1180, height: 820 })

/** Deadline of one navigation, in milliseconds; Vite's first load is slow. */
const NAVIGATION_TIMEOUT_MS = 60_000

/**
 * Builds the script that stands in for Tauri's IPC bridge in the page.
 *
 * @param {string} hostUrl - Origin of the verification host.
 * @returns {string} JavaScript evaluated before every document's scripts.
 */
export function buildTauriShimSource(hostUrl) {
  return `(() => {
  const hostUrl = ${JSON.stringify(hostUrl)};
  const callbacks = new Map();
  let nextCallbackId = 1;
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    async invoke(cmd, args = {}) {
      const response = await fetch(hostUrl + "/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd, args: args ?? {} })
      });
      const outcome = await response.json();
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    },
    transformCallback(callback, once) {
      const id = nextCallbackId++;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(path, protocol = "asset") {
      return protocol + "://localhost/" + encodeURIComponent(path);
    }
  };
})();`
}

/** One renderer page attached to a DevTools session. */
export class RendererPage {
  /** @type {import("./cdp.mjs").CdpConnection} */
  #connection

  /** @type {string} */
  #sessionId

  /** @type {string} */
  #targetId

  /**
   * Opens the renderer in a new page with the Tauri shim installed.
   *
   * @param {{connection: import("./cdp.mjs").CdpConnection, url: string, hostUrl: string}} options -
   * The browser connection, the renderer URL, and the verification host.
   * @returns {Promise<RendererPage>} The page after its load event.
   * @throws If the page cannot be created or does not load in time.
   */
  static async open({ connection, url, hostUrl }) {
    const { targetId } = await connection.send("Target.createTarget", {
      url: "about:blank"
    })
    const { sessionId } = await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true
    })
    const page = new RendererPage(connection, sessionId, targetId)
    await page.#prepare(buildTauriShimSource(hostUrl))
    await page.navigate(url)
    return page
  }

  /**
   * @param {import("./cdp.mjs").CdpConnection} connection - Browser connection.
   * @param {string} sessionId - Attached session of the page.
   * @param {string} targetId - The page's target.
   */
  constructor(connection, sessionId, targetId) {
    this.#connection = connection
    this.#sessionId = sessionId
    this.#targetId = targetId
  }

  /**
   * Navigates the page and waits for its load event.
   *
   * @param {string} url - Absolute URL.
   * @returns {Promise<void>} Resolves after the load event.
   * @throws If navigation fails or the load event does not fire in time.
   */
  async navigate(url) {
    const loaded = this.#connection.waitForEvent({
      method: "Page.loadEventFired",
      sessionId: this.#sessionId,
      timeoutMs: NAVIGATION_TIMEOUT_MS
    })
    const result = await this.#send("Page.navigate", { url })
    if (result.errorText)
      throw new Error(`Navigation failed: ${result.errorText}`)
    await loaded
  }

  /**
   * Reloads the page and waits for its load event.
   *
   * @returns {Promise<void>} Resolves after the load event.
   * @throws If the load event does not fire in time.
   */
  async reload() {
    const loaded = this.#connection.waitForEvent({
      method: "Page.loadEventFired",
      sessionId: this.#sessionId,
      timeoutMs: NAVIGATION_TIMEOUT_MS
    })
    await this.#send("Page.reload", {})
    await loaded
  }

  /**
   * Evaluates an expression in the page and returns its value.
   *
   * @param {string} expression - JavaScript expression; a promise is awaited.
   * @returns {Promise<unknown>} The JSON-serialisable result.
   * @throws If the expression throws, with the exception's description.
   */
  async evaluate(expression) {
    const result = await this.#send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      const exception = result.exceptionDetails.exception
      throw new Error(
        `Page script failed: ${exception?.description ?? result.exceptionDetails.text}`
      )
    }
    return result.result?.value
  }

  /**
   * Polls an expression until it is truthy.
   *
   * @param {{description: string, expression: string, timeoutMs: number}} options -
   * What is awaited, the expression, and the deadline.
   * @returns {Promise<unknown>} The first truthy value.
   * @throws {import("./waiting.mjs").WaitTimeoutError} If the deadline passes.
   */
  waitForPageCondition({ description, expression, timeoutMs }) {
    return waitForCondition({
      description,
      timeoutMs,
      check: () => this.evaluate(expression)
    })
  }

  /**
   * Clicks the centre of the element an expression selects.
   *
   * @param {string} elementExpression - Expression returning an `Element`.
   * @returns {Promise<void>} Resolves after the mouse up event.
   * @throws If the expression selects nothing or an element without a box.
   */
  async click(elementExpression) {
    const box = await this.evaluate(`(() => {
      const element = (${elementExpression});
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`)
    if (!box) throw new Error(`Nothing to click for ${elementExpression}`)
    if (box.width === 0 || box.height === 0)
      throw new Error(`The element for ${elementExpression} has no box`)
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.#send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1
      })
    }
  }

  /**
   * Inserts text at the focused element's caret, as typing would.
   *
   * @param {string} text - The text.
   * @returns {Promise<void>} Resolves once inserted.
   */
  async typeText(text) {
    await this.#send("Input.insertText", { text })
  }

  /**
   * Presses and releases one key.
   *
   * @param {{key: string, code: string, keyCode: number}} key - Key identity.
   * @returns {Promise<void>} Resolves after the key up event.
   */
  async pressKey(key) {
    for (const type of ["keyDown", "keyUp"]) {
      await this.#send("Input.dispatchKeyEvent", {
        type,
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode
      })
    }
  }

  /**
   * Captures the viewport as a PNG file.
   *
   * @param {string} filePath - Absolute path of the PNG to write.
   * @returns {Promise<void>} Resolves once written.
   */
  async captureScreenshot(filePath) {
    const { data } = await this.#send("Page.captureScreenshot", {
      format: "png"
    })
    writeFileSync(filePath, Buffer.from(data, "base64"))
  }

  /**
   * Closes the page.
   *
   * @returns {Promise<void>} Resolves once Chrome closed the target.
   */
  async close() {
    await this.#connection.send("Target.closeTarget", {
      targetId: this.#targetId
    })
  }

  /**
   * Enables the domains the page uses, installs the shim, and fixes the
   * viewport to the desktop window's size.
   *
   * @param {string} shimSource - The Tauri shim script.
   * @returns {Promise<void>} Resolves once prepared.
   */
  async #prepare(shimSource) {
    await this.#send("Page.enable", {})
    await this.#send("Runtime.enable", {})
    await this.#send("Page.addScriptToEvaluateOnNewDocument", {
      source: shimSource
    })
    await this.#send("Emulation.setDeviceMetricsOverride", {
      ...RENDERER_VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false
    })
  }

  /**
   * Sends one command to this page's session.
   *
   * @param {string} method - Protocol method.
   * @param {Record<string, unknown>} params - Method parameters.
   * @returns {Promise<Record<string, unknown>>} The command's result.
   */
  #send(method, params) {
    return this.#connection.send(method, params, this.#sessionId)
  }
}

/** The Escape key, for closing dialogs. */
export const ESCAPE_KEY = Object.freeze({
  key: "Escape",
  code: "Escape",
  keyCode: 27
})
