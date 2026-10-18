import { afterEach, describe, expect, it, vi } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createVmoRuntimeSlice,
  type VmoRuntimeSlice
} from "@/lib/store/vmo-runtime"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Status of the owned vmo while it runs. */
const RUNNING_VMO = Object.freeze({ status: "running", pid: 4343 })

/** Status while no vmo is owned. */
const STOPPED_VMO = Object.freeze({ status: "stopped" })

/**
 * Creates a store owning one vmo runtime slice.
 *
 * @returns The store.
 */
function createVmoRuntimeStore() {
  return createStore<VmoRuntimeSlice>()((set, get) =>
    createVmoRuntimeSlice(set, get)
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
 * Starts a host whose vmo is stopped until `start_vmo` spawns it, and whose
 * health route then answers as `health` says.
 *
 * @param health - Answer of every health check.
 * @returns The host observation handle.
 */
function startHostSpawningVmo(health: () => unknown) {
  let isRunning = false
  return startNativeHostFake({
    get_vmo_status: () => (isRunning ? RUNNING_VMO : STOPPED_VMO),
    start_vmo: () => {
      isRunning = true
      return RUNNING_VMO
    },
    get_vmo_health: health
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createVmoRuntimeSlice", () => {
  it("starts with vmo stopped and no problem", () => {
    const store = createVmoRuntimeStore()

    expect(store.getState().vmoServerInfo).toEqual({
      status: "stopped",
      problem: null
    })
  })

  describe("startVmo", () => {
    it("starts vmo, shows it starting, and shows it running once it answers its health route", async () => {
      const health = createControlledPromise<string>()
      const host = startHostSpawningVmo(() => health.promise)
      const store = createVmoRuntimeStore()

      const start = store.getState().startVmo()
      await waitForMicrotasks()
      const whileStarting = store.getState().vmoServerInfo
      health.resolve("ready")
      await start

      expect(whileStarting).toEqual({ status: "starting", problem: null })
      expect(store.getState().vmoServerInfo).toEqual({
        status: "running",
        problem: null
      })
      expect(listCommandNames(host)).toEqual([
        "get_vmo_status",
        "start_vmo",
        "get_vmo_status",
        "get_vmo_health"
      ])
    })

    it("adopts the vmo the desktop already owns without starting another", async () => {
      const host = startNativeHostFake({
        get_vmo_status: () => RUNNING_VMO,
        get_vmo_health: () => "ready"
      })
      const store = createVmoRuntimeStore()

      await store.getState().startVmo()

      expect(store.getState().vmoServerInfo.status).toBe("running")
      expect(listCommandNames(host)).not.toContain("start_vmo")
    })

    it("shows vmo stopped when it exits before it answers", async () => {
      startNativeHostFake({
        get_vmo_status: () => STOPPED_VMO,
        start_vmo: () => RUNNING_VMO
      })
      const store = createVmoRuntimeStore()

      await store.getState().startVmo()

      expect(store.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("shows vmo not responding when it runs for ten minutes without answering", async () => {
      vi.useFakeTimers()
      startHostSpawningVmo(() => "not-ready")
      const store = createVmoRuntimeStore()

      const start = store.getState().startVmo()
      await vi.advanceTimersByTimeAsync(600_000)
      await start

      expect(store.getState().vmoServerInfo).toEqual({
        status: "unresponsive",
        problem: null
      })
    })

    it("shows vmo stopped with the host's reason when it cannot be started, without rejecting", async () => {
      startNativeHostFake({
        get_vmo_status: () => STOPPED_VMO,
        start_vmo: () =>
          Promise.reject(
            "Failed to run /Users/test/.lys/runtime/vmo/vmo: No such file or directory (os error 2)"
          )
      })
      const store = createVmoRuntimeStore()

      await expect(store.getState().startVmo()).resolves.toBeUndefined()

      expect(store.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: {
          kind: "start-failed",
          message:
            "Failed to run /Users/test/.lys/runtime/vmo/vmo: No such file or directory (os error 2)"
        }
      })
    })

    it("publishes nothing when a stop took over while it waited for vmo", async () => {
      const health = createControlledPromise<string>()
      let isRunning = true
      startNativeHostFake({
        get_vmo_status: () => (isRunning ? RUNNING_VMO : STOPPED_VMO),
        get_vmo_health: () => health.promise,
        stop_vmo: () => {
          isRunning = false
          return { status: "stopped" }
        }
      })
      const store = createVmoRuntimeStore()

      const start = store.getState().startVmo()
      await waitForMicrotasks()
      await store.getState().stopVmo()
      health.resolve("ready")
      await start

      expect(store.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
    })

    it("clears the problem an earlier stop left", async () => {
      startNativeHostFake({
        get_vmo_status: () => RUNNING_VMO,
        stop_vmo: () => ({ status: "killed" }),
        get_vmo_health: () => "ready"
      })
      const store = createVmoRuntimeStore()
      await store.getState().stopVmo()
      const afterKill = store.getState().vmoServerInfo

      await store.getState().startVmo()

      expect(afterKill.problem).toEqual({ kind: "killed" })
      expect(store.getState().vmoServerInfo).toEqual({
        status: "running",
        problem: null
      })
    })
  })

  describe("stopVmo", () => {
    it("shows vmo stopping while it deletes its VMs, then stopped", async () => {
      const stop = createControlledPromise<unknown>()
      let isRunning = true
      const host = startNativeHostFake({
        get_vmo_status: () => (isRunning ? RUNNING_VMO : STOPPED_VMO),
        stop_vmo: () => {
          isRunning = false
          return stop.promise
        }
      })
      const store = createVmoRuntimeStore()

      const stopping = store.getState().stopVmo()
      await waitForMicrotasks()
      const whileStopping = store.getState().vmoServerInfo
      stop.resolve({ status: "stopped" })
      await stopping

      expect(whileStopping).toEqual({ status: "stopping", problem: null })
      expect(store.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
      expect(listCommandNames(host)).toEqual(["get_vmo_status", "stop_vmo"])
    })

    it("joins a stop already in progress", async () => {
      const host = startNativeHostFake({
        get_vmo_status: () => ({ status: "stopping", pid: 4343 }),
        stop_vmo: () => ({ status: "stopped" })
      })
      const store = createVmoRuntimeStore()

      await store.getState().stopVmo()

      expect(store.getState().vmoServerInfo.status).toBe("stopped")
      expect(listCommandNames(host)).toEqual(["get_vmo_status", "stop_vmo"])
    })

    it("says vmo was killed when it did not stop in time", async () => {
      startNativeHostFake({
        get_vmo_status: () => RUNNING_VMO,
        stop_vmo: () => ({ status: "killed" })
      })
      const store = createVmoRuntimeStore()

      await store.getState().stopVmo()

      expect(store.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: { kind: "killed" }
      })
    })

    it("shows vmo stopped without stopping anything when no vmo is owned", async () => {
      const host = startNativeHostFake({
        get_vmo_status: () => STOPPED_VMO
      })
      const store = createVmoRuntimeStore()
      store.setState({
        vmoServerInfo: { status: "unresponsive", problem: null }
      })

      await store.getState().stopVmo()

      expect(store.getState().vmoServerInfo).toEqual({
        status: "stopped",
        problem: null
      })
      expect(listCommandNames(host)).toEqual(["get_vmo_status"])
    })

    it.each([
      { statusAfter: RUNNING_VMO, shownStatus: "unresponsive" },
      { statusAfter: STOPPED_VMO, shownStatus: "stopped" }
    ])(
      "shows vmo $shownStatus with the host's reason when the stop fails, without rejecting",
      async ({ statusAfter, shownStatus }) => {
        let hasStopFailed = false
        startNativeHostFake({
          get_vmo_status: () => (hasStopFailed ? statusAfter : RUNNING_VMO),
          stop_vmo: () => {
            hasStopFailed = true
            return Promise.reject(
              "Failed to stop vmo process 4343: failed to inspect it"
            )
          }
        })
        const store = createVmoRuntimeStore()

        await expect(store.getState().stopVmo()).resolves.toBeUndefined()

        expect(store.getState().vmoServerInfo).toEqual({
          status: shownStatus,
          problem: {
            kind: "stop-failed",
            message: "Failed to stop vmo process 4343: failed to inspect it"
          }
        })
      }
    )

    it("shows vmo not responding, so Stop stays offered, when the stop fails and its status then cannot be read", async () => {
      let hasStopFailed = false
      startNativeHostFake({
        get_vmo_status: () =>
          hasStopFailed
            ? Promise.reject("Failed to inspect vmo process: Resource busy")
            : RUNNING_VMO,
        stop_vmo: () => {
          hasStopFailed = true
          return Promise.reject(
            "Failed to stop vmo process 4343: failed to inspect it"
          )
        }
      })
      const store = createVmoRuntimeStore()

      await expect(store.getState().stopVmo()).resolves.toBeUndefined()

      expect(store.getState().vmoServerInfo).toEqual({
        status: "unresponsive",
        problem: {
          kind: "stop-failed",
          message: "Failed to stop vmo process 4343: failed to inspect it"
        }
      })
    })
  })
})
