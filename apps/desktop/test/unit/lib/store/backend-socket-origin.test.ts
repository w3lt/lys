import { describe, expect, it, onTestFinished } from "vitest"
import { useLysStore } from "@/lib/store"
import { getBackendSocketOrigin } from "@/lib/store/backend-socket-origin"

/**
 * Names the backend's URL in the application store for one test.
 *
 * @param backendUrl - The URL the store names during the test.
 */
function updateBackendUrl(backendUrl: string): void {
  const previous = useLysStore.getState().backendUrl
  onTestFinished(() => {
    useLysStore.setState({ backendUrl: previous })
  })
  useLysStore.setState({ backendUrl })
}

describe("getBackendSocketOrigin", () => {
  it.each([
    ["http://127.0.0.1:12345", "ws://127.0.0.1:12345"],
    ["https://lys.example", "wss://lys.example"]
  ])("reads %s as %s", (backendUrl, origin) => {
    updateBackendUrl(backendUrl)

    expect(getBackendSocketOrigin()).toBe(origin)
  })
})
