import { describe, expect, it } from "vitest"
import { registerOutputFailureListeners } from "../../src/log"
import { createFailingOutput, createWorkingOutput } from "./support/testOutputs"

/** Failure a write reports on a full disk. */
const DISK_FULL = new Error("ENOSPC: no space left on device, write")

/** Failure a write reports once the reader of a pipe has exited. */
const PIPE_CLOSED = new Error("write EPIPE")

/** Report written when the standard output fails on a full disk. */
const STANDARD_OUTPUT_DISK_FULL_REPORT =
  "The Lys backend could not write to its standard output, so what it writes there is lost while writing fails: ENOSPC: no space left on device, write\n"

/**
 * Waits until Node has run every callback queued so far, so each failure the
 * writes so far report has been emitted and handled.
 *
 * @returns A promise settled on the next turn of the event loop.
 */
function waitForPendingCallbacks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe("registerOutputFailureListeners", () => {
  it("reports the first failure of the standard output on standard error and keeps writing to it", async () => {
    // Without a listener, Node would end the process at the first failure.
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
    await waitForPendingCallbacks()
    standardOutput.write('{"msg":"request completed"}\n')
    await waitForPendingCallbacks()

    expect(outputWrites).toEqual([
      '{"msg":"incoming request"}\n',
      '{"msg":"request completed"}\n'
    ])
    expect(errorWrites).toEqual([STANDARD_OUTPUT_DISK_FULL_REPORT])
  })

  it("reports the first failure of standard error on the standard output", async () => {
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
    await waitForPendingCallbacks()
    standardError.write("Warning: something else\n")
    await waitForPendingCallbacks()

    expect(errorWrites).toEqual([
      "Warning: something Node reports\n",
      "Warning: something else\n"
    ])
    expect(outputWrites).toEqual([
      "The Lys backend could not write to its standard error, so what it writes there is lost while writing fails: write EPIPE\n"
    ])
  })

  it("reports each output's first failure once when both fail, instead of reporting back and forth", async () => {
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
    await waitForPendingCallbacks()
    standardOutput.write('{"msg":"request completed"}\n')
    await waitForPendingCallbacks()

    expect(outputWrites).toEqual([
      '{"msg":"incoming request"}\n',
      "The Lys backend could not write to its standard error, so what it writes there is lost while writing fails: ENOSPC: no space left on device, write\n",
      '{"msg":"request completed"}\n'
    ])
    expect(errorWrites).toEqual([STANDARD_OUTPUT_DISK_FULL_REPORT])
  })
})
