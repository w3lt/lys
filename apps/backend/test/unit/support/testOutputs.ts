import { Writable } from "node:stream"

/**
 * Creates an output that accepts every write, standing in for a working
 * standard output or standard error.
 *
 * @param receive - Receives the text of each write, in write order.
 * @returns A new output; never fails a write.
 */
export function createWorkingOutput(receive: (text: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      receive(chunk.toString("utf8"))
      callback()
    }
  })
}

/**
 * Creates an output whose every write fails, standing in for the process's
 * standard output or standard error on a full disk or a closed pipe.
 *
 * Like those streams, the output stays open after a failure: each later write
 * is attempted and fails again, and each failure is emitted as an `error`
 * event once the current callbacks have run.
 *
 * @param failure - Failure each write reports.
 * @param receive - Receives the text of each attempted write, in write order.
 * @returns A new output; an `error` event without a listener ends the process.
 */
export function createFailingOutput(
  failure: Error,
  receive: (text: string) => void
): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      receive(chunk.toString("utf8"))
      callback()
      process.nextTick(() => {
        this.emit("error", failure)
      })
    }
  })
}
