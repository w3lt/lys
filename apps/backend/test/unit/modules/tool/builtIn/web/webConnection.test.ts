import type { LookupAddress } from "node:dns"
import { describe, expect, it } from "vitest"
import { isBlockedAddress } from "../../../../../../src/modules/tool/builtIn/web/webAddresses"
import {
  ConnectionAddressError,
  createCheckedLookup,
  hasErrorCode,
  parseResponseChunk,
  type ConnectionAddressRule
} from "../../../../../../src/modules/tool/builtIn/web/webConnection"

/** Outcome a Node lookup callback received. */
type LookupCallbackOutcome = Readonly<{
  error: NodeJS.ErrnoException | null
  addresses: string | LookupAddress[]
  family: number | undefined
}>

/**
 * Runs a checked lookup the way Node's connection does.
 *
 * @param rule - Lookup and address rule.
 * @param options - Node lookup options.
 * @returns What the callback received.
 */
function runCheckedLookup(
  rule: ConnectionAddressRule,
  options: { all?: boolean; family?: number }
): Promise<LookupCallbackOutcome> {
  return new Promise((resolve) => {
    createCheckedLookup(rule)(
      "api.example",
      options,
      (error, addresses, family) => resolve({ error, addresses, family })
    )
  })
}

describe("createCheckedLookup", () => {
  it("delivers the first public address when one is asked for", async () => {
    const outcome = await runCheckedLookup(
      {
        lookupHostAddresses: () =>
          Promise.resolve([
            { address: "93.184.216.34", family: 4 },
            { address: "2606:2800:220:1::1", family: 6 }
          ]),
        isBlockedAddress
      },
      {}
    )

    expect(outcome).toEqual({
      error: null,
      addresses: "93.184.216.34",
      family: 4
    })
  })

  it("refuses a host when any of its addresses is blocked", async () => {
    const outcome = await runCheckedLookup(
      {
        lookupHostAddresses: () =>
          Promise.resolve([
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 }
          ]),
        isBlockedAddress
      },
      { all: true }
    )

    expect(outcome.error).toBeInstanceOf(ConnectionAddressError)
    expect((outcome.error as ConnectionAddressError).kind).toBe(
      "blocked-address"
    )
  })

  it("reports a name without addresses as unresolvable", async () => {
    const outcome = await runCheckedLookup(
      { lookupHostAddresses: () => Promise.resolve([]), isBlockedAddress },
      {}
    )

    expect((outcome.error as ConnectionAddressError).kind).toBe(
      "unresolvable-host"
    )
  })

  it("passes on a lookup failure without a system code unchanged", async () => {
    const failure = new Error("resolver defect")
    const outcome = await runCheckedLookup(
      { lookupHostAddresses: () => Promise.reject(failure), isBlockedAddress },
      {}
    )

    expect(outcome.error).toBe(failure)
  })
})

describe("hasErrorCode", () => {
  it.each([
    [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), true],
    [Object.assign(new Error("empty"), { code: "" }), false],
    [new Error("plain"), false],
    [{ code: "ECONNREFUSED" }, false]
  ])("answers for %o", (error, expected) => {
    expect(hasErrorCode(error)).toBe(expected)
  })
})

describe("parseResponseChunk", () => {
  it("passes bytes through", () => {
    const bytes = Uint8Array.from([1, 2, 3])

    expect(parseResponseChunk(bytes)).toBe(bytes)
  })

  it("rejects a chunk that is not bytes", () => {
    expect(() => parseResponseChunk("text")).toThrow(TypeError)
  })
})
