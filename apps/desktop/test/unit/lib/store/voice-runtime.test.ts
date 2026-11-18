import { afterEach, describe, expect, it, vi } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createVoiceRuntimeSlice,
  type VoiceRuntimeSlice,
  type VoiceServerInfo
} from "@/lib/store/voice-runtime"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Status of the owned voice while it runs. */
const RUNNING_VOICE = Object.freeze({ status: "running", pid: 4343 })

/** Status while no voice is owned. */
const STOPPED_VOICE = Object.freeze({ status: "stopped" })

/** Status while a stop waits for the owned voice to exit. */
const STOPPING_VOICE = Object.freeze({ status: "stopping", pid: 4343 })

/** Outcome of a stop that ended voice within the stop timeout. */
const STOPPED_OUTCOME = Object.freeze({ status: "stopped" })

/** Problem of a voice killed after the stop timeout. */
const KILLED_PROBLEM = Object.freeze({ kind: "killed" })

/** Host's reason for a stop that failed. */
const STOP_FAILURE = "Failed to stop voice process 4343: failed to inspect it"

/**
 * Creates a store owning one voice runtime slice.
 *
 * @returns The store.
 */
function createVoiceRuntimeStore() {
  return createStore<VoiceRuntimeSlice>()((set, get) =>
    createVoiceRuntimeSlice(set, get)
  )
}

/**
 * Lists the command names a host received, in order.
 *
 * @param host - Host observation handle.
 * @returns The command names.
 */
function listCommandNames(host: ReturnType<typeof startNativeHostFake>) {
  return host.commands.map((invoked) => invoked.command)
}

/**
 * Starts a host whose voice is stopped until `start_voice` spawns it, and whose
 * health route then answers as `health` says.
 *
 * @param health - Answer of every health check.
 * @returns The host observation handle.
 */
function startHostSpawningVoice(health: () => unknown) {
  let isRunning = false
  return startNativeHostFake({
    get_voice_status: () => (isRunning ? RUNNING_VOICE : STOPPED_VOICE),
    start_voice: () => {
      isRunning = true
      return RUNNING_VOICE
    },
    get_voice_health: health
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createVoiceRuntimeSlice", () => {
  it("starts with voice stopped and no problem", () => {
    const store = createVoiceRuntimeStore()

    expect(store.getState().voiceServerInfo).toEqual({
      status: "stopped",
      problem: null
    })
  })

  describe("startVoice", () => {
    it("starts voice, shows it starting, and shows it running once it answers its health route", async () => {
      const health = createControlledPromise<string>()
      const host = startHostSpawningVoice(() => health.promise)
      const store = createVoiceRuntimeStore()

      const start = store.getState().startVoice()
      await waitForMicrotasks()
      const whileStarting = store.getState().voiceServerInfo
      health.resolve("ready")
      await start

      expect(whileStarting).toEqual({ status: "starting", problem: null })
      expect(store.getState().voiceServerInfo).toEqual({
        status: "running",
        problem: null
      })
      expect(listCommandNames(host)).toEqual([
        "get_voice_status",
        "start_voice",
        "get_voice_status",
        "get_voice_health"
      ])
    })

    it("adopts the voice the desktop already owns without starting another", async () => {
      const host = startNativeHostFake({
        get_voice_status: () => RUNNING_VOICE,
        get_voice_health: () => "ready"
      })
      const store = createVoiceRuntimeStore()

      await store.getState().startVoice()

      expect(store.getState().voiceServerInfo.status).toBe("running")
      expect(listCommandNames(host)).not.toContain("start_voice")
    })

    it("shows voice stopped when it exits before it answers", async () => {
      startNativeHostFake({
        get_voice_status: () => STOPPED_VOICE,
        start_voice: () => RUNNING_VOICE
      })
      const store = createVoiceRuntimeStore()

      await store.getState().startVoice()

      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("shows voice not responding when it runs for ten minutes without answering", async () => {
      vi.useFakeTimers()
      startHostSpawningVoice(() => "not-ready")
      const store = createVoiceRuntimeStore()

      const start = store.getState().startVoice()
      await vi.advanceTimersByTimeAsync(600_000)
      await start

      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem: null
      })
    })

    it("shows voice stopped with the host's reason when it cannot be started, without rejecting", async () => {
      const reason =
        "Failed to run /Users/test/.lys/runtime/voice/voice: No such file or directory (os error 2)"
      startNativeHostFake({
        get_voice_status: () => STOPPED_VOICE,
        start_voice: () => Promise.reject(reason)
      })
      const store = createVoiceRuntimeStore()

      await expect(store.getState().startVoice()).resolves.toBeUndefined()

      const problem = { kind: "start-failed", message: reason }
      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem
      })
    })

    it("shows voice not responding, so Stop stays offered, when the start is refused because the host still stops voice", async () => {
      const reason =
        "voice is still stopping; start it again once it has stopped"
      startNativeHostFake({
        get_voice_status: () => STOPPING_VOICE,
        start_voice: () => Promise.reject(reason)
      })
      const store = createVoiceRuntimeStore()

      await store.getState().startVoice()

      const problem = { kind: "start-failed", message: reason }
      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem
      })
    })

    it.each([
      {
        shape: "an error",
        createRejection: () => new Error("IPC channel closed"),
        message: "IPC channel closed"
      },
      {
        shape: "an error without a message",
        createRejection: () => new Error(""),
        message: "the host gave no reason"
      },
      {
        shape: "an empty string",
        createRejection: () => "",
        message: "the host gave no reason"
      },
      {
        shape: "no value",
        createRejection: () => undefined,
        message: "the host gave no reason"
      }
    ])(
      "shows a start rejected with $shape with a presentable reason",
      async ({ createRejection, message }) => {
        startNativeHostFake({
          get_voice_status: () => STOPPED_VOICE,
          start_voice: () => Promise.reject(createRejection())
        })
        const store = createVoiceRuntimeStore()

        await store.getState().startVoice()

        const problem = { kind: "start-failed", message }
        expect(store.getState().voiceServerInfo).toEqual({
          status: "stopped",
          problem
        })
      }
    )

    it("shows voice not responding with the host's reason when its health check fails after it was spawned", async () => {
      const reason =
        "The voice health check ended unexpectedly: task 7 panicked"
      startHostSpawningVoice(() => Promise.reject(reason))
      const store = createVoiceRuntimeStore()

      await expect(store.getState().startVoice()).resolves.toBeUndefined()

      const problem = { kind: "start-failed", message: reason }
      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem
      })
    })

    it("shows voice not responding with the host's reason when its status cannot be read after it was spawned", async () => {
      const reason =
        "Failed to inspect voice process: Interrupted system call (os error 4)"
      let isRunning = false
      startNativeHostFake({
        get_voice_status: () =>
          isRunning ? Promise.reject(reason) : STOPPED_VOICE,
        start_voice: () => {
          isRunning = true
          return RUNNING_VOICE
        }
      })
      const store = createVoiceRuntimeStore()

      await expect(store.getState().startVoice()).resolves.toBeUndefined()

      const problem = { kind: "start-failed", message: reason }
      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem
      })
    })

    it("shows voice not responding, so Stop stays offered, when the start fails and its status then cannot be read", async () => {
      const reason = "Failed to inspect voice process: Resource busy"
      let hasStartFailed = false
      startNativeHostFake({
        get_voice_status: () =>
          hasStartFailed ? Promise.reject(reason) : STOPPED_VOICE,
        start_voice: () => {
          hasStartFailed = true
          return Promise.reject(reason)
        }
      })
      const store = createVoiceRuntimeStore()

      await expect(store.getState().startVoice()).resolves.toBeUndefined()

      const problem = { kind: "start-failed", message: reason }
      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem
      })
    })

    it("publishes nothing when a stop took over while it waited for voice", async () => {
      const health = createControlledPromise<string>()
      let isRunning = true
      startNativeHostFake({
        get_voice_status: () => (isRunning ? RUNNING_VOICE : STOPPED_VOICE),
        get_voice_health: () => health.promise,
        stop_voice: () => {
          isRunning = false
          return STOPPED_OUTCOME
        }
      })
      const store = createVoiceRuntimeStore()

      const start = store.getState().startVoice()
      await waitForMicrotasks()
      await store.getState().stopVoice()
      health.resolve("ready")
      await start

      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("publishes nothing when its check fails after a stop took over", async () => {
      const health = createControlledPromise<string>()
      let isRunning = true
      startNativeHostFake({
        get_voice_status: () => (isRunning ? RUNNING_VOICE : STOPPED_VOICE),
        get_voice_health: () => health.promise,
        stop_voice: () => {
          isRunning = false
          return STOPPED_OUTCOME
        }
      })
      const store = createVoiceRuntimeStore()

      const start = store.getState().startVoice()
      await waitForMicrotasks()
      await store.getState().stopVoice()
      health.reject("The voice health check ended unexpectedly: task cancelled")
      await start

      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("publishes nothing from a start that a stop and a newer start replaced", async () => {
      vi.useFakeTimers()
      let isRunning = false
      let health = "not-ready"
      let heldStatus: Promise<unknown> | undefined
      const newerStartStatus = createControlledPromise<unknown>()
      startNativeHostFake({
        get_voice_status: () => {
          const status =
            heldStatus ?? (isRunning ? RUNNING_VOICE : STOPPED_VOICE)
          heldStatus = undefined
          return status
        },
        start_voice: () => {
          isRunning = true
          return RUNNING_VOICE
        },
        get_voice_health: () => health,
        stop_voice: () => {
          isRunning = false
          return STOPPED_OUTCOME
        }
      })
      const store = createVoiceRuntimeStore()
      const replacedStart = store.getState().startVoice()
      await waitForMicrotasks()
      await store.getState().stopVoice()
      heldStatus = newerStartStatus.promise
      const newerStart = store.getState().startVoice()
      await waitForMicrotasks()

      // The replaced start's next check finds voice stopped while the newer
      // start still waits for its first status read.
      await vi.advanceTimersByTimeAsync(1_000)
      const afterReplacedCheck = store.getState().voiceServerInfo
      health = "ready"
      newerStartStatus.resolve(STOPPED_VOICE)
      await Promise.all([replacedStart, newerStart])

      expect(afterReplacedCheck).toEqual({ status: "starting", problem: null })
      expect(store.getState().voiceServerInfo).toEqual({
        status: "running",
        problem: null
      })
    })

    it("clears the problem an earlier stop left", async () => {
      startNativeHostFake({
        get_voice_status: () => RUNNING_VOICE,
        stop_voice: () => ({ status: "killed" }),
        get_voice_health: () => "ready"
      })
      const store = createVoiceRuntimeStore()
      await store.getState().stopVoice()
      const afterKill = store.getState().voiceServerInfo

      await store.getState().startVoice()

      expect(afterKill.problem).toEqual({ kind: "killed" })
      expect(store.getState().voiceServerInfo).toEqual({
        status: "running",
        problem: null
      })
    })
  })

  describe("stopVoice", () => {
    it("shows voice stopping while it exits, then stopped", async () => {
      const stop = createControlledPromise<unknown>()
      let isRunning = true
      const host = startNativeHostFake({
        get_voice_status: () => (isRunning ? RUNNING_VOICE : STOPPED_VOICE),
        stop_voice: () => {
          isRunning = false
          return stop.promise
        }
      })
      const store = createVoiceRuntimeStore()

      const stopping = store.getState().stopVoice()
      await waitForMicrotasks()
      const whileStopping = store.getState().voiceServerInfo
      stop.resolve({ status: "stopped" })
      await stopping

      expect(whileStopping).toEqual({ status: "stopping", problem: null })
      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
      expect(listCommandNames(host)).toEqual(["get_voice_status", "stop_voice"])
    })

    it("joins a stop already in progress", async () => {
      const host = startNativeHostFake({
        get_voice_status: () => ({ status: "stopping", pid: 4343 }),
        stop_voice: () => ({ status: "stopped" })
      })
      const store = createVoiceRuntimeStore()

      await store.getState().stopVoice()

      expect(store.getState().voiceServerInfo.status).toBe("stopped")
      expect(listCommandNames(host)).toEqual(["get_voice_status", "stop_voice"])
    })

    it("says voice was killed when it did not stop in time", async () => {
      startNativeHostFake({
        get_voice_status: () => RUNNING_VOICE,
        stop_voice: () => ({ status: "killed" })
      })
      const store = createVoiceRuntimeStore()

      await store.getState().stopVoice()

      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: KILLED_PROBLEM
      })
    })

    it("shows voice stopped without stopping anything when no voice is owned", async () => {
      const host = startNativeHostFake({
        get_voice_status: () => STOPPED_VOICE
      })
      const store = createVoiceRuntimeStore()
      const voiceServerInfo: VoiceServerInfo = {
        status: "unresponsive",
        problem: null
      }
      store.setState({ voiceServerInfo })

      await store.getState().stopVoice()

      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
      expect(listCommandNames(host)).toEqual(["get_voice_status"])
    })

    it.each([
      { statusAfter: RUNNING_VOICE, shownStatus: "unresponsive" },
      { statusAfter: STOPPING_VOICE, shownStatus: "unresponsive" },
      { statusAfter: STOPPED_VOICE, shownStatus: "stopped" }
    ])(
      "shows voice $shownStatus with the host's reason when the stop fails and voice is then $statusAfter.status, without rejecting",
      async ({ statusAfter, shownStatus }) => {
        let hasStopFailed = false
        startNativeHostFake({
          get_voice_status: () => (hasStopFailed ? statusAfter : RUNNING_VOICE),
          stop_voice: () => {
            hasStopFailed = true
            return Promise.reject(STOP_FAILURE)
          }
        })
        const store = createVoiceRuntimeStore()

        await expect(store.getState().stopVoice()).resolves.toBeUndefined()

        const problem = { kind: "stop-failed", message: STOP_FAILURE }
        expect(store.getState().voiceServerInfo).toEqual({
          status: shownStatus,
          problem
        })
      }
    )

    it("shows voice not responding, so Stop stays offered, when the stop fails and its status then cannot be read", async () => {
      let hasStopFailed = false
      startNativeHostFake({
        get_voice_status: () =>
          hasStopFailed
            ? Promise.reject("Failed to inspect voice process: Resource busy")
            : RUNNING_VOICE,
        stop_voice: () => {
          hasStopFailed = true
          return Promise.reject(STOP_FAILURE)
        }
      })
      const store = createVoiceRuntimeStore()

      await expect(store.getState().stopVoice()).resolves.toBeUndefined()

      const problem = { kind: "stop-failed", message: STOP_FAILURE }
      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem
      })
    })
  })

  describe("checkVoice", () => {
    /** State of a voice shown as running. */
    const SHOWN_RUNNING: VoiceServerInfo = Object.freeze({
      status: "running",
      problem: null
    })

    /**
     * Creates a store that shows voice as running.
     *
     * @returns The store.
     */
    function createRunningVoiceStore() {
      const store = createVoiceRuntimeStore()
      store.setState({ voiceServerInfo: SHOWN_RUNNING })
      return store
    }

    it("shows voice stopped once the host owns no running voice", async () => {
      startNativeHostFake({ get_voice_status: () => STOPPED_VOICE })
      const store = createRunningVoiceStore()

      await expect(store.getState().checkVoice()).resolves.toBeUndefined()

      expect(store.getState().voiceServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("shows voice not responding once it stops answering its health route", async () => {
      startNativeHostFake({
        get_voice_status: () => RUNNING_VOICE,
        get_voice_health: () => "not-ready"
      })
      const store = createRunningVoiceStore()

      await store.getState().checkVoice()

      expect(store.getState().voiceServerInfo).toEqual({
        status: "unresponsive",
        problem: null
      })
    })

    it("shows voice not responding when the host cannot be asked", async () => {
      startNativeHostFake({
        get_voice_status: () =>
          Promise.reject("Failed to inspect voice process: Resource busy")
      })
      const store = createRunningVoiceStore()

      await store.getState().checkVoice()

      expect(store.getState().voiceServerInfo.status).toBe("unresponsive")
    })

    it("publishes nothing while voice still answers", async () => {
      startNativeHostFake({
        get_voice_status: () => RUNNING_VOICE,
        get_voice_health: () => "ready"
      })
      const store = createRunningVoiceStore()
      const listener = vi.fn()
      store.subscribe(listener)

      await store.getState().checkVoice()

      expect(listener).not.toHaveBeenCalled()
      expect(store.getState().voiceServerInfo).toBe(SHOWN_RUNNING)
    })

    it("asks nothing while voice is not shown as running", async () => {
      const host = startNativeHostFake({})
      const store = createVoiceRuntimeStore()

      await store.getState().checkVoice()

      expect(listCommandNames(host)).toEqual([])
      expect(store.getState().voiceServerInfo.status).toBe("stopped")
    })

    it("publishes nothing when a stop took over while it asked", async () => {
      const status = createControlledPromise<unknown>()
      startNativeHostFake({ get_voice_status: () => status.promise })
      const store = createRunningVoiceStore()

      const check = store.getState().checkVoice()
      store.setState({
        voiceServerInfo: Object.freeze({ status: "stopping", problem: null })
      })
      status.resolve(STOPPED_VOICE)
      await check

      expect(store.getState().voiceServerInfo.status).toBe("stopping")
    })
  })
})
