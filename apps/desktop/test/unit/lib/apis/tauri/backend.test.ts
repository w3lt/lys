import { describe, expect, it } from "vitest"
import {
  getBackendStatus,
  startBackend,
  stopBackend
} from "@/lib/apis/tauri/backend"
import { startNativeHostFake } from "../../../support/nativeHostFake"

describe.each([
  {
    operation: "startBackend",
    sendCommand: startBackend,
    command: "start_backend"
  },
  {
    operation: "stopBackend",
    sendCommand: stopBackend,
    command: "stop_backend"
  },
  {
    operation: "getBackendStatus",
    sendCommand: getBackendStatus,
    command: "get_backend_status"
  }
])("$operation", ({ sendCommand, command }) => {
  it(`invokes ${command} and resolves to the reported process status`, async () => {
    const host = startNativeHostFake({
      [command]: () => ({ pid: 4242, running: true })
    })

    await expect(sendCommand()).resolves.toEqual({ pid: 4242, running: true })
    expect(host.commands.map((invoked) => invoked.command)).toEqual([command])
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      [command]: () => Promise.reject("Failed to inspect the backend process")
    })

    await expect(sendCommand()).rejects.toBe(
      "Failed to inspect the backend process"
    )
  })
})
