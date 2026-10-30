import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"
import McpHttpTransport from "../../../../src/modules/mcp/mcpHttpTransport"

/** Endpoint the scripted transports name; nothing is ever sent to it. */
const UNUSED_ENDPOINT = new URL("http://127.0.0.1:9/mcp")

/** A notification the server accepts without answering. */
const CANCELLED_NOTIFICATION = Object.freeze({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: Object.freeze({ requestId: 1 })
} as const)

describe("McpHttpTransport", () => {
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
