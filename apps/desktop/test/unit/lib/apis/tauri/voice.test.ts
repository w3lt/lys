import { describe, expect, it } from "vitest"
import {
  getVoiceHealth,
  getVoiceStatus,
  startVoice,
  stopVoice,
  type VoiceProcessStatus,
  type VoiceStopOutcome
} from "@/lib/apis/tauri/voice"
import {
  NO_NATIVE_COMMAND_ARGS,
  startNativeHostFake
} from "../../../support/nativeHostFake"

/** Status of a voice the host spawned or found running. */
const RUNNING_STATUS: VoiceProcessStatus = Object.freeze({
  status: "running",
  pid: 4343
})

/** Status of a voice that a stop signalled and still waits for. */
const STOPPING_STATUS: VoiceProcessStatus = Object.freeze({
  status: "stopping",
  pid: 4343
})

/** Outcome of a stop that killed voice after the stop timeout. */
const KILLED_OUTCOME: VoiceStopOutcome = Object.freeze({ status: "killed" })

describe.each([
  {
    operation: "startVoice",
    sendCommand: startVoice,
    command: "start_voice",
    result: RUNNING_STATUS
  },
  {
    operation: "getVoiceStatus",
    sendCommand: getVoiceStatus,
    command: "get_voice_status",
    result: STOPPING_STATUS
  },
  {
    operation: "stopVoice",
    sendCommand: stopVoice,
    command: "stop_voice",
    result: KILLED_OUTCOME
  },
  {
    operation: "getVoiceHealth",
    sendCommand: getVoiceHealth,
    command: "get_voice_health",
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
      [command]: () => Promise.reject("voice is still stopping")
    })

    await expect(sendCommand()).rejects.toBe("voice is still stopping")
  })
})
