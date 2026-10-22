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
 * Creates an output whose every write fails, standing in for a standard output
 * or standard error on a full disk or a closed pipe.
 *
 * @param failure - Failure each write reports through the output's `error`
 * event.
 * @param receive - Receives the text of each write the output attempts, in
 * write order; a write after the output closed is never attempted.
 * @returns A new output; Node closes it at its first failure.
 */
export function createFailingOutput(
  failure: Error,
  receive: (text: string) => void
): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      receive(chunk.toString("utf8"))
      callback(failure)
    }
  })
}

/**
 * Waits until an output has closed.
 *
 * @param output - Output to watch; it must still be open.
 * @returns A promise settled once the output emits `close`.
 */
export function waitForOutputClose(output: Writable): Promise<void> {
  return new Promise((resolve) => {
    output.once("close", () => {
      resolve()
    })
  })
}
