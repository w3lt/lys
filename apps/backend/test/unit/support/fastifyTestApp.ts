import Fastify, {
  type FastifyInstance,
  type FastifyLoggerOptions
} from "fastify"
import { onTestFinished } from "vitest"
import * as z from "zod"

/** Pino fields read by backend log assertions; other fields are retained. */
const capturedLogRecordSchema = z.looseObject({
  /** Pino level label, such as `debug` or `error`. */
  level: z.string()
})

/** One structured line written by the logger of a test application. */
export type CapturedLogRecord = z.infer<typeof capturedLogRecordSchema>

/** Log destination of a test application, with the records written to it. */
export type CapturedLog = Readonly<{
  /** Destination that parses each line it receives into {@link logs}. */
  destination: NonNullable<FastifyLoggerOptions["stream"]>
  /** Parsed log records in write order; grows while the application logs. */
  logs: readonly CapturedLogRecord[]
}>

/**
 * Creates a log destination that keeps each JSON line a Fastify logger writes.
 *
 * @returns The destination and its live record list.
 * @remarks The destination's `write` throws a `SyntaxError` for a line that is
 * not JSON and a `z.ZodError` for a record without a string `level`, so a
 * malformed line fails the test that logged it.
 */
export function createCapturedLog(): CapturedLog {
  const logs: CapturedLogRecord[] = []
  const destination = {
    write: (line: string) => {
      logs.push(capturedLogRecordSchema.parse(JSON.parse(line)))
    }
  }
  return Object.freeze({ destination, logs })
}

/** Fastify application owned by one test case, with its captured log lines. */
export type TestFastify = Readonly<{
  /** Application closed automatically when the owning test finishes. */
  app: FastifyInstance
  /** Parsed log records in write order; grows while the application logs. */
  logs: readonly CapturedLogRecord[]
}>

/**
 * Creates a Fastify application whose trace-level logs are captured in memory.
 *
 * Captured records carry the level label instead of pino's numeric level.
 *
 * @returns The application and its live log record list.
 * @remarks Must be called while a test is running. Closing is registered with
 * the runner before the caller can perform any further setup, so a failed
 * registration or assertion still releases the application and its hooks.
 */
export function createTestFastify(): TestFastify {
  const { destination, logs } = createCapturedLog()
  const app = Fastify({
    logger: {
      level: "trace",
      formatters: { level: (label) => ({ level: label }) },
      stream: destination
    }
  })
  onTestFinished(async () => {
    await app.close()
  })
  return Object.freeze({ app, logs })
}
