import { describe, expect, it } from "vitest"
import {
  getVmoHealth,
  getVmoStatus,
  startVmo,
  stopVmo
} from "@/lib/apis/tauri/vmo"
import { startNativeHostFake } from "../../../support/nativeHostFake"

describe.each([
  {
    operation: "startVmo",
    sendCommand: startVmo,
    command: "start_vmo",
    result: { status: "running", pid: 4343 }
  },
  {
    operation: "getVmoStatus",
    sendCommand: getVmoStatus,
    command: "get_vmo_status",
    result: { status: "stopping", pid: 4343 }
  },
  {
    operation: "stopVmo",
    sendCommand: stopVmo,
    command: "stop_vmo",
    result: { status: "killed" }
  },
  {
    operation: "getVmoHealth",
    sendCommand: getVmoHealth,
    command: "get_vmo_health",
    result: "not-ready"
  }
])("$operation", ({ sendCommand, command, result }) => {
  it(`invokes ${command} and resolves to what the host reports`, async () => {
    const host = startNativeHostFake({ [command]: () => result })

    await expect(sendCommand()).resolves.toEqual(result)
    expect(host.commands).toEqual([{ command, args: {} }])
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      [command]: () => Promise.reject("vmo is still stopping")
    })

    await expect(sendCommand()).rejects.toBe("vmo is still stopping")
  })
})
