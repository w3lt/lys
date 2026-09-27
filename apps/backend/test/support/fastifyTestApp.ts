import Fastify, { type FastifyInstance } from "fastify"
import { onTestFinished } from "vitest"
import * as z from "zod"

/** Pino fields read by backend log assertions; other fields are retained. */
const capturedLogRecordSchema = z.looseObject({
  /** Pino level label, such as `debug` or `error`. */
  level: z.string(),
  /** Log message written by the backend. */
  msg: z.string()
})

/** One structured line written by the logger of a test application. */
export type CapturedLogRecord = z.infer<typeof capturedLogRecordSchema>

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
  const logs: CapturedLogRecord[] = []
  const app = Fastify({
    logger: {
      level: "trace",
      formatters: { level: (label) => ({ level: label }) },
      stream: {
        write: (line: string) => {
          logs.push(capturedLogRecordSchema.parse(JSON.parse(line)))
        }
      }
    }
  })
  onTestFinished(async () => {
    await app.close()
  })
  return Object.freeze({ app, logs })
}

/**
 * Selects captured records written with one message.
 *
 * @param logs - Records captured from one test application.
 * @param message - Exact log message to select.
 * @returns The matching records in write order.
 */
export function findLogRecords(
  logs: readonly CapturedLogRecord[],
  message: string
): CapturedLogRecord[] {
  return logs.filter((record) => record.msg === message)
}
