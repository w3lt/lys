import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { createBackendLogger } from "../../src/log"
import { registerBackendStopHandlers } from "../../src/processStop"
import { CapturedLogDestination } from "./support/fastifyTestApp"

/**
 * Registers the stop handlers on a stand-in process.
 *
 * @param failures - What the stop of the MCP servers' groups returns.
 * @returns The stand-in process, its exit, the stop, and the captured log.
 */
function registerOnStandIn(failures: readonly unknown[] = []): {
  backendProcess: EventEmitter
  exitProcess: ReturnType<typeof vi.fn<(code: number) => void>>
  stopEveryMcpServerProcess: ReturnType<typeof vi.fn<() => readonly unknown[]>>
  log: CapturedLogDestination
} {
  const backendProcess = new EventEmitter()
  const exitProcess = vi.fn<(code: number) => void>()
  const stopEveryMcpServerProcess = vi.fn(() => failures)
  const log = new CapturedLogDestination()
  registerBackendStopHandlers({
    backendProcess,
    exitProcess,
    logger: createBackendLogger(log),
    stopEveryMcpServerProcess
  })
  return { backendProcess, exitProcess, stopEveryMcpServerProcess, log }
}

describe("registerBackendStopHandlers", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129]
  ] as const)(
    "on %s logs the signal, ends the MCP servers' groups, then exits with %i",
    (signal, exitCode) => {
      const standIn = registerOnStandIn()
      const order: string[] = []
      standIn.stopEveryMcpServerProcess.mockImplementation(() => {
        order.push("stop")
        return []
      })
      standIn.exitProcess.mockImplementation(() => order.push("exit"))

      standIn.backendProcess.emit(signal)

      expect(order).toEqual(["stop", "exit"])
      expect(standIn.exitProcess).toHaveBeenCalledWith(exitCode)
      expect(standIn.log.records).toEqual([
        expect.objectContaining({
          level: "info",
          msg: "The Lys backend is stopping on a signal",
          signal
        })
      ])
    }
  )

  it("ends the MCP servers' groups when the process exits", () => {
    const standIn = registerOnStandIn()

    standIn.backendProcess.emit("exit", 1)

    expect(standIn.stopEveryMcpServerProcess).toHaveBeenCalledOnce()
    expect(standIn.exitProcess).not.toHaveBeenCalled()
  })

  it("logs each group that could not be ended", () => {
    const failure = Object.assign(new Error("kill EINVAL"), { code: "EINVAL" })
    const standIn = registerOnStandIn([failure])

    standIn.backendProcess.emit("exit", 0)

    expect(standIn.log.records).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "An MCP server's process group could not be ended as the backend stopped",
        err: expect.objectContaining({ message: "kill EINVAL" })
      })
    ])
  })
})
