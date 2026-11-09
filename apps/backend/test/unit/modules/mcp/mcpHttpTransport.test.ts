import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"
import McpHttpTransport from "../../../../src/modules/mcp/mcpHttpTransport"
import { waitForMicrotasks } from "../../support/microtasks"

/** Endpoint the scripted transports name; nothing is ever sent to it. */
const UNUSED_ENDPOINT = new URL("http://127.0.0.1:9/mcp")

/** A notification the server accepts without answering. */
const CANCELLED_NOTIFICATION = Object.freeze({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: Object.freeze({ requestId: 1 })
} as const)

/**
 * The notification that ends the handshake, after which the SDK transport
 * requests the server's event stream.
 */
const INITIALIZED_NOTIFICATION = Object.freeze({
  jsonrpc: "2.0",
  method: "notifications/initialized"
} as const)

/**
 * Builds a fetch that accepts every message and leaves the event stream
 * request pending until its signal aborts, as a server that is slow to open
 * its stream does.
 *
 * @returns The fetch: HTTP 202 for a message, and for the stream request a
 * promise that rejects with the signal's reason once the signal aborts.
 */
function buildFetchHoldingTheEventStream(): typeof fetch {
  return (_url, init) => {
    if (init?.method !== "GET")
      return Promise.resolve(new Response(null, { status: 202 }))
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    })
  }
}

describe("McpHttpTransport", () => {
  it("drops the abort failure the SDK reports for the event stream request its close cut short", async () => {
    const sdkTransport = new StreamableHTTPClientTransport(UNUSED_ENDPOINT, {
      fetch: buildFetchHoldingTheEventStream()
    })
    const transport = new McpHttpTransport(sdkTransport)
    const errors: Error[] = []
    transport.onerror = (error) => errors.push(error)
    await transport.start()
    await transport.send(INITIALIZED_NOTIFICATION)

    await transport.close()
    await waitForMicrotasks()

    expect(errors).toEqual([])
  })

  it("passes on an abort failure the SDK reports before the close started", async () => {
    const reported = new DOMException(
      "This operation was aborted",
      "AbortError"
    )
    const sdkTransport: StreamableHTTPClientTransport =
      new StreamableHTTPClientTransport(UNUSED_ENDPOINT, {
        fetch: () => {
          sdkTransport.onerror?.(reported)
          return Promise.resolve(new Response(null, { status: 202 }))
        }
      })
    const transport = new McpHttpTransport(sdkTransport)
    const errors: Error[] = []
    transport.onerror = (error) => errors.push(error)
    await transport.start()

    await transport.send(CANCELLED_NOTIFICATION)

    expect(errors).toEqual([reported])
  })

  it("passes on a failure the SDK transport reports during a send that the send does not reject with, once the send settles", async () => {
    // The SDK transport reports such a failure when an event stream of an
    // earlier answer breaks while this send is pending; the scripted fetch
    // reports one at that point of the send.
    const reported = new Error("An earlier answer's event stream broke")
    const sdkTransport: StreamableHTTPClientTransport =
      new StreamableHTTPClientTransport(UNUSED_ENDPOINT, {
        fetch: () => {
          sdkTransport.onerror?.(reported)
          return Promise.resolve(new Response(null, { status: 202 }))
        }
      })
    const transport = new McpHttpTransport(sdkTransport)
    const errors: Error[] = []
    transport.onerror = (error) => errors.push(error)
    await transport.start()

    await transport.send(CANCELLED_NOTIFICATION)

    expect(errors).toEqual([reported])
  })
})
