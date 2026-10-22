import { describe, expect, it } from "vitest"
import { registerOutputFailureListeners } from "../../src/log"
import {
  createFailingOutput,
  createWorkingOutput,
  waitForOutputClose
} from "./support/testOutputs"

/** Failure a write reports on a full disk. */
const DISK_FULL = new Error("ENOSPC: no space left on device, write")

/** Failure a write reports once the reader of a pipe has exited. */
const PIPE_CLOSED = new Error("write EPIPE")

/**
 * Waits until Node has run every callback queued so far, so a failure a write
 * would have reported has been emitted.
 *
 * @returns A promise settled on the next turn of the event loop.
 */
function waitForPendingCallbacks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe("registerOutputFailureListeners", () => {
  it("reports a failed standard output once on standard error and drops what is written to it later", async () => {
    // Without a listener, Node would end the process at the failure.
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createFailingOutput(DISK_FULL, (text) => {
      outputWrites.push(text)
    })
    const standardError = createWorkingOutput((text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)

    standardOutput.write('{"msg":"incoming request"}\n')
    await waitForOutputClose(standardOutput)
    standardOutput.write('{"msg":"request completed"}\n')
    await waitForPendingCallbacks()

    expect(outputWrites).toEqual(['{"msg":"incoming request"}\n'])
    expect(errorWrites).toEqual([
      "The Lys backend could not write to its standard output, so it drops what it writes there until it restarts: ENOSPC: no space left on device, write\n"
    ])
  })

  it("reports a failed standard error once on standard output", async () => {
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createWorkingOutput((text) => {
      outputWrites.push(text)
    })
    const standardError = createFailingOutput(PIPE_CLOSED, (text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)

    standardError.write("Warning: something Node reports\n")
    await waitForOutputClose(standardError)
    standardError.write("Warning: something else\n")
    await waitForPendingCallbacks()

    expect(errorWrites).toEqual(["Warning: something Node reports\n"])
    expect(outputWrites).toEqual([
      "The Lys backend could not write to its standard error, so it drops what it writes there until it restarts: write EPIPE\n"
    ])
  })

  it("drops the report when both outputs fail, so each failure is reported at most once", async () => {
    const outputWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createFailingOutput(DISK_FULL, (text) => {
      outputWrites.push(text)
    })
    const standardError = createFailingOutput(DISK_FULL, (text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)

    standardOutput.write('{"msg":"incoming request"}\n')
    await Promise.all([
      waitForOutputClose(standardOutput),
      waitForOutputClose(standardError)
    ])
    await waitForPendingCallbacks()

    expect(outputWrites).toEqual(['{"msg":"incoming request"}\n'])
    expect(errorWrites).toEqual([
      "The Lys backend could not write to its standard output, so it drops what it writes there until it restarts: ENOSPC: no space left on device, write\n"
    ])
  })
})
