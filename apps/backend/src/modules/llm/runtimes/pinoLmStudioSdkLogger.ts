import type { LoggerInterface } from "@lmstudio/sdk"
import type { FastifyBaseLogger } from "fastify"
import { format, stripVTControlCharacters } from "node:util"

/**
 * Retains the backend's logger to serve as the LM Studio SDK's logger, so
 * the messages the SDK would print on the console, such as why it could not
 * connect to LM Studio, are lines of the backend's log instead.
 *
 * Each message becomes one line at the level the SDK gave it: `info`,
 * `warn`, `error`, or `debug`. The line's `msg` is the text the SDK would
 * have printed: its arguments joined as `console` joins them, an error with
 * its stack, without terminal color codes.
 *
 * @remarks Borrows the logger and owns nothing to release. The logger's level
 * decides which messages are written, so the backend's logger leaves out
 * `debug` messages. Concurrency model: stateless after construction; the SDK
 * calls it on the backend's one event loop.
 */
export default class PinoLmStudioSdkLogger implements LoggerInterface {
  /** Receives one line per SDK message; borrowed. */
  readonly #logger: FastifyBaseLogger

  /**
   * Creates an SDK logger that writes to the given logger.
   *
   * @param logger - The backend's logger, or a child of it; borrowed.
   */
  public constructor(logger: FastifyBaseLogger) {
    this.#logger = logger
  }

  /**
   * Logs an SDK message at level `info`.
   *
   * @param messages - Arguments of the SDK's call, its prefix first.
   */
  public info(...messages: unknown[]): void {
    this.#logger.info(formatSdkMessage(messages))
  }

  /**
   * Logs an SDK message at level `warn`.
   *
   * @param messages - Arguments of the SDK's call, its prefix first.
   */
  public warn(...messages: unknown[]): void {
    this.#logger.warn(formatSdkMessage(messages))
  }

  /**
   * Logs an SDK message at level `error`.
   *
   * @param messages - Arguments of the SDK's call, its prefix first.
   */
  public error(...messages: unknown[]): void {
    this.#logger.error(formatSdkMessage(messages))
  }

  /**
   * Logs an SDK message at level `debug`.
   *
   * @param messages - Arguments of the SDK's call, its prefix first.
   */
  public debug(...messages: unknown[]): void {
    this.#logger.debug(formatSdkMessage(messages))
  }
}

/**
 * Formats the arguments of one SDK logger call as the console would print
 * them, without terminal color codes.
 *
 * @param messages - Arguments of the call, such as the SDK's colored
 * `[LMStudioClient]…` prefix, a text, and an error.
 * @returns The arguments joined by spaces, each error with its stack.
 */
function formatSdkMessage(messages: readonly unknown[]): string {
  return stripVTControlCharacters(format(...messages))
}
