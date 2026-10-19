import { describe, expect, it } from "vitest"
import {
  getVmoHealth,
  getVmoStatus,
  startVmo,
  stopVmo,
  type VmoProcessStatus,
  type VmoStopOutcome
} from "@/lib/apis/tauri/vmo"
import {
  NO_NATIVE_COMMAND_ARGS,
  startNativeHostFake
} from "../../../support/nativeHostFake"

/** Status of a vmo the host spawned or found running. */
const RUNNING_STATUS: VmoProcessStatus = Object.freeze({
  status: "running",
  pid: 4343
})

/** Status of a vmo that a stop signalled and still waits for. */
const STOPPING_STATUS: VmoProcessStatus = Object.freeze({
  status: "stopping",
  pid: 4343
})

/** Outcome of a stop that killed vmo after the stop timeout. */
const KILLED_OUTCOME: VmoStopOutcome = Object.freeze({ status: "killed" })

describe.each([
  {
    operation: "startVmo",
    sendCommand: startVmo,
    command: "start_vmo",
    result: RUNNING_STATUS
  },
  {
    operation: "getVmoStatus",
    sendCommand: getVmoStatus,
    command: "get_vmo_status",
    result: STOPPING_STATUS
  },
  {
    operation: "stopVmo",
    sendCommand: stopVmo,
    command: "stop_vmo",
    result: KILLED_OUTCOME
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
    expect(host.commands).toEqual([{ command, args: NO_NATIVE_COMMAND_ARGS }])
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      [command]: () => Promise.reject("vmo is still stopping")
    })

    await expect(sendCommand()).rejects.toBe("vmo is still stopping")
  })
})
