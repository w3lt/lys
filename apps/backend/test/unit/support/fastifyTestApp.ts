import Fastify, { type FastifyInstance } from "fastify"
import { onTestFinished } from "vitest"
import * as z from "zod"
import { buildBackendLoggerOptions } from "../../../src/log"

/** Pino fields read by backend log assertions; other fields are retained. */
const capturedLogRecordSchema = z.looseObject({
  /** Pino level label, such as `debug` or `error`. */
  level: z.string()
})

/** One structured line written by the logger of a test application. */
export type CapturedLogRecord = z.infer<typeof capturedLogRecordSchema>

/**
 * Parses one line a Fastify logger wrote.
 *
 * @param line - JSON line as the logger wrote it.
 * @returns A new record holding every field of the line.
 * @throws {SyntaxError} If the line is not JSON.
 * @throws {z.ZodError} If the record has no string `level`.
 */
function parseCapturedLogRecord(line: string): CapturedLogRecord {
  return capturedLogRecordSchema.parse(JSON.parse(line))
}

/**
 * Owns the lines a test application's logger writes, serving as the `stream`
 * of that logger.
 *
 * @remarks A malformed line fails the test that logged it: {@link write}
 * throws for a line that is not JSON or has no string `level`, and keeps
 * nothing. The destination is never closed; it is released with the test.
 * Concurrency model: single-owner, in one test.
 */
export class CapturedLogDestination {
  /** Lines written so far, in write order. */
  readonly #lines: string[] = []

  /**
   * Records written so far, in write order.
   *
   * @returns A frozen list of records parsed anew on every read, so changing
   * one never changes the log.
   */
  public get records(): readonly CapturedLogRecord[] {
    return Object.freeze(this.#lines.map(parseCapturedLogRecord))
  }

  /**
   * Keeps one line the logger wrote.
   *
   * @param line - JSON line as the logger wrote it.
   * @throws {SyntaxError} If the line is not JSON; the line is not kept.
   * @throws {z.ZodError} If the record has no string `level`; the line is not
   * kept.
   */
  public write(line: string): void {
    parseCapturedLogRecord(line)
    this.#lines.push(line)
  }
}

/** Fastify application owned by one test case, with its captured log lines. */
export type TestFastify = Readonly<{
  /** Application closed automatically when the owning test finishes. */
  app: FastifyInstance
  /** Destination of the application's log; owned by the test. */
  log: CapturedLogDestination
}>

/**
 * Creates a Fastify application whose trace-level logs are captured in memory.
 *
 * Lines use the backend's log format, so a record carries the level name
 * instead of pino's number.
 *
 * @returns The application and the destination of its log.
 * @remarks Must be called while a test is running. Closing is registered with
 * the runner before the caller can perform any further setup, so a failed
 * registration or assertion still releases the application and its hooks.
 */
export function createTestFastify(): TestFastify {
  const log = new CapturedLogDestination()
  const loggerOptions = buildBackendLoggerOptions("trace", log)
  const app = Fastify({ logger: loggerOptions })
  onTestFinished(async () => {
    await app.close()
  })
  return Object.freeze({ app, log })
}
