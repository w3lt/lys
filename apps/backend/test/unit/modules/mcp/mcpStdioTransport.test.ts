import { SdkErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/client"
import { describe, expect, it, vi } from "vitest"
import type { McpServerProcessHandlers } from "../../../../src/modules/mcp/mcpServerProcess"
import McpStdioTransport from "../../../../src/modules/mcp/mcpStdioTransport"

/** A message the tests send. */
const PING: JSONRPCMessage = Object.freeze({
  jsonrpc: "2.0",
  id: 1,
  method: "ping"
})

/** A process the transport started, with what the test controls. */
type StartedProcess = {
  /** Handlers the transport gave the process. */
  handlers: McpServerProcessHandlers | undefined
  /** Calls of the process's stop. */
  readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>
  /** Calls of the process's send. */
  readonly send: ReturnType<
    typeof vi.fn<(message: JSONRPCMessage) => Promise<void>>
  >
}

/**
 * Creates a transport whose process is a stand-in the test controls.
 *
 * @param stop - What the stand-in's stop does.
 * @returns The transport, the stand-in, and the transport's close count.
 */
function createTransport(stop: () => Promise<void> = () => Promise.resolve()): {
  transport: McpStdioTransport
  started: StartedProcess
  closes: () => number
} {
  const started: StartedProcess = {
    handlers: undefined,
    stop: vi.fn(stop),
    send: vi.fn(() => Promise.resolve())
  }
  const transport = new McpStdioTransport((handlers) => {
    started.handlers = handlers
    return Promise.resolve({ stop: started.stop, send: started.send })
  })
  let closeCount = 0
  transport.onclose = () => {
    closeCount += 1
  }
  return { transport, started, closes: () => closeCount }
}

describe("McpStdioTransport", () => {
  it("refuses a message before it started", async () => {
    const { transport } = createTransport()

    await expect(transport.send(PING)).rejects.toMatchObject({
      code: SdkErrorCode.NotConnected
    })
  })

  it("writes a message to the started process", async () => {
    const { transport, started } = createTransport()
    await transport.start()

    await transport.send(PING)

    expect(started.send).toHaveBeenCalledWith(PING)
  })

  it("passes the process's messages and failures to the installed callbacks", async () => {
    const { transport, started } = createTransport()
    const messages: JSONRPCMessage[] = []
    const errors: Error[] = []
    transport.onmessage = (message) => messages.push(message)
    transport.onerror = (error) => errors.push(error)
    await transport.start()
    const failure = new Error("not json")

    started.handlers?.handleMessage(PING)
    started.handlers?.handleError(failure)

    expect(messages).toEqual([PING])
    expect(errors).toEqual([failure])
  })

  it("stops the process once for every close and reports its close once", async () => {
    const { transport, started, closes } = createTransport()
    await transport.start()

    const first = transport.close()
    const second = transport.close()
    await first

    expect(second).toBe(first)
    expect(started.stop).toHaveBeenCalledOnce()
    expect(closes()).toBe(1)
  })

  it("reports its close only once the process's group ended", async () => {
    const stopped = Promise.withResolvers<void>()
    const { transport, closes } = createTransport(() => stopped.promise)
    await transport.start()

    const closing = transport.close()
    await Promise.resolve()

    expect(closes()).toBe(0)
    stopped.resolve()
    await closing
    expect(closes()).toBe(1)
  })

  it("refuses a message once a close started", async () => {
    const { transport, started } = createTransport()
    await transport.start()
    void transport.close()

    await expect(transport.send(PING)).rejects.toMatchObject({
      code: SdkErrorCode.NotConnected
    })
    expect(started.send).not.toHaveBeenCalled()
  })

  it("closes itself through the same close once the process closed by itself", async () => {
    const { transport, started, closes } = createTransport()
    await transport.start()

    started.handlers?.handleClose()
    await vi.waitFor(() => expect(closes()).toBe(1))
    await transport.close()

    expect(started.stop).toHaveBeenCalledOnce()
    expect(closes()).toBe(1)
  })

  it("reports a close it started itself that failed as a failure, and its close", async () => {
    const failure = new Error("still running after SIGKILL")
    const { transport, started, closes } = createTransport(() =>
      Promise.reject(failure)
    )
    const errors: Error[] = []
    transport.onerror = (error) => errors.push(error)
    await transport.start()

    started.handlers?.handleClose()

    await vi.waitFor(() => expect(errors).toEqual([failure]))
    expect(closes()).toBe(1)
  })

  it("closes without stopping anything after its process failed to start, and reports its close", async () => {
    const startFailure = Object.assign(new Error("spawn missing ENOENT"), {
      syscall: "spawn missing"
    })
    const transport = new McpStdioTransport(() => Promise.reject(startFailure))
    let closeCount = 0
    transport.onclose = () => {
      closeCount += 1
    }

    await expect(transport.start()).rejects.toBe(startFailure)
    await transport.close()

    expect(closeCount).toBe(1)
  })

  it("closes before it started without starting anything", async () => {
    const { transport, started, closes } = createTransport()

    await transport.close()

    expect(started.handlers).toBeUndefined()
    expect(closes()).toBe(1)
  })
})
