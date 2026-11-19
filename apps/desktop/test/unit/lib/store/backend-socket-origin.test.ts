import { describe, expect, it, vi } from "vitest"

/**
 * Loads a fresh application store that names a backend URL, and the reader
 * of the backend's socket origin over it.
 *
 * @param backendUrl - The URL the store names.
 * @returns The reader of the socket origin.
 */
async function loadFreshSocketOriginReader(backendUrl: string) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { getBackendSocketOrigin } =
    await import("@/lib/store/backend-socket-origin")
  useLysStore.setState({ backendUrl })
  return getBackendSocketOrigin
}

describe("getBackendSocketOrigin", () => {
  it.each([
    ["http://127.0.0.1:12345", "ws://127.0.0.1:12345"],
    ["https://lys.example", "wss://lys.example"]
  ])("reads %s as %s", async (backendUrl, origin) => {
    const getBackendSocketOrigin = await loadFreshSocketOriginReader(backendUrl)

    expect(getBackendSocketOrigin()).toBe(origin)
  })
})
