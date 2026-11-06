/**
 * A minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
 *
 * @remarks Only what the harness needs: sending commands to the browser or
 * to one attached session, and waiting for one named event. Chrome is
 * started by the stack module; this module finds its DevTools endpoint in
 * the profile directory's `DevToolsActivePort` file.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { waitForCondition } from "./waiting.mjs"

/** Deadline of one protocol command, in milliseconds. */
const COMMAND_TIMEOUT_MS = 30_000

/**
 * Reads the DevTools endpoint Chrome wrote into its profile directory.
 *
 * @param {string} profileDir - Chrome's `--user-data-dir`.
 * @returns {string | undefined} The browser WebSocket URL, or `undefined`
 * until Chrome has written the file.
 */
export function findDevToolsEndpoint(profileDir) {
  const path = join(profileDir, "DevToolsActivePort")
  if (!existsSync(path)) return undefined
  const [port, browserPath] = readFileSync(path, "utf8").trim().split("\n")
  if (!port || !browserPath) return undefined
  return `ws://127.0.0.1:${port}${browserPath}`
}

/**
 * Waits for Chrome to publish its DevTools endpoint.
 *
 * @param {string} profileDir - Chrome's `--user-data-dir`.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<string>} The browser WebSocket URL.
 * @throws {import("./waiting.mjs").WaitTimeoutError} If Chrome does not
 * publish it in time.
 */
export function waitForDevToolsEndpoint(profileDir, timeoutMs) {
  return waitForCondition({
    description: "Chrome to publish its DevTools endpoint",
    timeoutMs,
    check: () => findDevToolsEndpoint(profileDir)
  })
}

/** One connection to a Chrome DevTools endpoint. */
export class CdpConnection {
  /** @type {WebSocket} */
  #socket

  /** @type {number} */
  #nextId = 1

  /** @type {Map<number, {resolve: Function, reject: Function, method: string}>} */
  #pending = new Map()

  /** @type {Set<(message: {method: string, params: unknown, sessionId?: string}) => void>} */
  #eventListeners = new Set()

  /**
   * Opens a connection to a DevTools endpoint.
   *
   * @param {string} webSocketUrl - Browser or page WebSocket URL.
   * @returns {Promise<CdpConnection>} The open connection.
   * @throws If the socket cannot connect.
   */
  static open(webSocketUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl)
      socket.addEventListener("open", () => resolve(new CdpConnection(socket)))
      socket.addEventListener("error", () =>
        reject(new Error(`The DevTools connection to ${webSocketUrl} failed`))
      )
    })
  }

  /**
   * @param {WebSocket} socket - An open socket to the endpoint.
   */
  constructor(socket) {
    this.#socket = socket
    socket.addEventListener("message", (event) =>
      this.#handleMessage(String(event.data))
    )
    socket.addEventListener("close", () => this.#handleClose())
  }

  /**
   * Sends one protocol command and waits for its result.
   *
   * @param {string} method - Protocol method, such as `Page.navigate`.
   * @param {Record<string, unknown>} [params] - Method parameters.
   * @param {string} [sessionId] - Attached session the command targets;
   * omitted for a browser-level command.
   * @returns {Promise<Record<string, unknown>>} The command's result.
   * @throws If Chrome answers with an error or the deadline passes.
   */
  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new Error(`${method} gave no answer within ${COMMAND_TIMEOUT_MS} ms`)
        )
      }, COMMAND_TIMEOUT_MS)
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.#socket.send(JSON.stringify(message))
    })
  }

  /**
   * Waits for one event of a session.
   *
   * @param {{method: string, sessionId?: string, timeoutMs: number}} options -
   * Event name, the session it must come from, and the deadline.
   * @returns {Promise<unknown>} The event's parameters.
   * @throws If the deadline passes first.
   */
  waitForEvent({ method, sessionId, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#eventListeners.delete(listener)
        reject(new Error(`No ${method} event within ${timeoutMs} ms`))
      }, timeoutMs)
      const listener = (message) => {
        if (message.method !== method) return
        if (sessionId !== undefined && message.sessionId !== sessionId) return
        clearTimeout(timer)
        this.#eventListeners.delete(listener)
        resolve(message.params)
      }
      this.#eventListeners.add(listener)
    })
  }

  /**
   * Closes the socket. Pending commands are rejected.
   */
  close() {
    this.#socket.close()
  }

  /**
   * Routes one incoming protocol message to its command or to listeners.
   *
   * @param {string} text - Raw message text.
   */
  #handleMessage(text) {
    const message = JSON.parse(text)
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      if (pending === undefined) return
      if (message.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${message.error.message}`)
        )
      } else pending.resolve(message.result ?? {})
      return
    }
    for (const listener of this.#eventListeners) listener(message)
  }

  /**
   * Rejects every pending command when the socket closes.
   */
  #handleClose() {
    for (const pending of this.#pending.values())
      pending.reject(new Error(`${pending.method}: the DevTools socket closed`))
    this.#pending.clear()
  }
}
