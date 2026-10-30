import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { BackendServerStatus } from "@/lib/store"
import { initialSettingsState } from "@/lib/store/settings"
import {
  buildJsonResponse,
  listRouteKeys,
  startBackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  FIRST_RUN_LOAD_CONFIGURATION,
  type SettingsDocument
} from "../../support/settingsFixtures"
import {
  buildUnreachableRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import { createControlledPromise } from "../../support/settlement"
import { waitForRenderedWork } from "../../support/rendering"

/** Backend origin the settings name. */
const BACKEND_ADDRESS = initialSettingsState.runtime.backendAddress

/** Wall-clock time at which the uptime case reads the backend's uptime. */
const UPTIME_READ_AT_MS = Date.UTC(2026, 9, 9, 12, 0, 0)

/** What the Runtime pane says after a failed save of the startup switches. */
const FAILED_SAVE_LINE =
  "Lys couldn't save the startup switches. The next launch follows the switches last saved; changing a switch tries again."

/** LM Studio connected, the chosen default on disk and nothing loaded. */
const NOTHING_LOADED: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    modelLoading: "lys",
    models: [buildLlmInfo("qwen3-8b")]
  }
}

/**
 * Settings document of a first run: every group at its default, no load
 * setting stored, no Tavily API key saved, no tool on Just run or switched,
 * no location saved. Its backend
 * starts when Lys opens, so a saved `false` can only come from the switch.
 */
const FIRST_RUN_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  runtime: initialSettingsState.runtime,
  generation: initialSettingsState.generation,
  loadConfiguration: Object.freeze({ default: {}, models: {} }),
  secrets: initialSettingsState.secrets,
  providers: initialSettingsState.providers,
  tools: Object.freeze({
    justRun: Object.freeze([]),
    switches: Object.freeze({})
  }),
  location: initialSettingsState.location
})

/**
 * Renders the settings view on the Runtime pane and waits for the pane.
 *
 * @param runtime - Backend, LM Studio, and model facts.
 * @param routes - Backend routes the case needs besides the inventory read.
 * @returns The application store and the backend observation handle.
 */
async function startRuntimePane(
  runtime: RuntimeArrangement = READY_RUNTIME,
  routes: BackendRoutes = {}
) {
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    ...routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "runtime",
    runtime
  )
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("switch", { name: "Start it when Lys opens" })
  await waitForRenderedWork()
  return { useLysStore, backend }
}

describe("RuntimePaneContent", () => {
  describe("backend", () => {
    it("shows the running backend's address and uptime", async () => {
      // Uptime is read from the wall clock whenever the lazy pane mounts, so
      // only that clock is fixed; rendering and waiting keep real timers.
      vi.useFakeTimers({ now: UPTIME_READ_AT_MS, toFake: ["Date"] })
      onTestFinished(() => {
        vi.useRealTimers()
      })
      startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
      const { useLysStore, SettingsView } =
        await loadFreshSettingsView("runtime")
      useLysStore.setState({
        backendServerInfo: {
          status: "running",
          startedAt: new Date(UPTIME_READ_AT_MS - 65_500)
        }
      })

      render(<SettingsView onDone={vi.fn()} />)
      await screen.findByRole("switch", { name: "Start it when Lys opens" })
      await waitForRenderedWork()

      expect(
        screen.getByRole("heading", { name: "Backend running" })
      ).toBeInTheDocument()
      expect(
        screen.getByText(`${BACKEND_ADDRESS} · up 1m 5s`)
      ).toBeInTheDocument()
    })

    it.each<[BackendServerStatus, string, boolean, boolean]>([
      ["stopped", "Backend stopped", true, false],
      ["starting", "Backend starting", false, false],
      ["stopping", "Backend stopping", false, false],
      ["unresponsive", "Backend not responding", false, true]
    ])(
      "names a %s backend and offers only the commands that apply",
      async (backendStatus, heading, canStart, canStop) => {
        await startRuntimePane(buildUnreachableRuntime(backendStatus))

        expect(
          screen.getByRole("heading", { name: heading })
        ).toBeInTheDocument()
        expect(
          screen.getByRole("button", { name: "Start backend" })
        ).toHaveProperty("disabled", !canStart)
        expect(
          screen.getByRole("button", { name: "Stop backend" })
        ).toHaveProperty("disabled", !canStop)
      }
    )

    it("starts a stopped backend", async () => {
      const start = createControlledPromise<unknown>()
      const host = startNativeHostFake({
        get_backend_status: () => ({ running: false }),
        start_backend: () => start.promise
      })
      await startRuntimePane(buildUnreachableRuntime("stopped"))
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Start backend" }))
      await waitForRenderedWork()

      expect(
        screen.getByRole("heading", { name: "Backend starting" })
      ).toBeInTheDocument()
      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_backend_status",
        "start_backend"
      ])

      start.resolve({ running: false })
      await waitForRenderedWork()
      expect(
        screen.getByRole("heading", { name: "Backend stopped" })
      ).toBeInTheDocument()
    })

    it("stops a running backend", async () => {
      const host = startNativeHostFake({
        get_backend_status: () => ({ running: true, pid: 4242 }),
        stop_backend: () => ({ running: false })
      })
      await startRuntimePane()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Stop backend" }))
      await waitForRenderedWork()

      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_backend_status",
        "stop_backend"
      ])
      expect(
        screen.getByRole("heading", { name: "Backend stopped" })
      ).toBeInTheDocument()
    })

    it("switches whether the backend starts when Lys opens", async () => {
      const { useLysStore } = await startRuntimePane()
      const user = userEvent.setup()
      const autoStart = screen.getByRole("switch", {
        name: "Start it when Lys opens"
      })
      expect(autoStart).toBeChecked()

      await user.click(autoStart)

      expect(autoStart).not.toBeChecked()
      expect(useLysStore.getState().settings.runtime.autoStartBackend).toBe(
        false
      )
    })

    it("keeps the choice for the next time Lys opens", async () => {
      const saves: unknown[] = []
      startNativeHostFake({
        load_settings: () => FIRST_RUN_SETTINGS_DOCUMENT,
        save_settings: (args) => {
          saves.push(args)
        }
      })
      await startRuntimePane()
      const user = userEvent.setup()

      await user.click(
        screen.getByRole("switch", { name: "Start it when Lys opens" })
      )
      await waitForRenderedWork()

      expect(saves).toContainEqual({
        newSettings: expect.objectContaining({
          runtime: expect.objectContaining({ autoStartBackend: false })
        })
      })
    })

    it("says the next launch follows the switches last saved when they cannot be saved", async () => {
      startNativeHostFake({
        load_settings: () => FIRST_RUN_SETTINGS_DOCUMENT,
        save_settings: () => Promise.reject("Disk full")
      })
      await startRuntimePane()
      const user = userEvent.setup()
      const status = screen.getByRole("status", {
        name: "Startup switches save"
      })
      const before = status.textContent

      await user.click(
        screen.getByRole("switch", { name: "Start it when Lys opens" })
      )
      await waitForRenderedWork()

      expect(before).toBe("")
      expect(status).toHaveTextContent(FAILED_SAVE_LINE)
      expect(
        screen.getByRole("switch", { name: "Start it when Lys opens" })
      ).not.toBeChecked()
    })

    it("clears the failed save once the switches are saved again, without moving focus", async () => {
      const failedSave = createControlledPromise<void>()
      const nextSave = createControlledPromise<void>()
      const saveResults = [failedSave.promise, nextSave.promise]
      startNativeHostFake({
        load_settings: () => FIRST_RUN_SETTINGS_DOCUMENT,
        save_settings: () => saveResults.shift()
      })
      await startRuntimePane()
      const user = userEvent.setup()
      const status = screen.getByRole("status", {
        name: "Startup switches save"
      })
      const autoStart = screen.getByRole("switch", {
        name: "Start it when Lys opens"
      })

      await user.click(autoStart)
      failedSave.reject("Disk full")
      await waitForRenderedWork()
      const afterFailure = status.textContent
      await user.click(autoStart)
      await waitForRenderedWork()
      const whileSaving = status.textContent
      nextSave.resolve()
      await waitForRenderedWork()

      expect(afterFailure).toBe(FAILED_SAVE_LINE)
      expect(whileSaving).toBe("")
      expect(saveResults).toEqual([])
      expect(
        screen.getByRole("status", { name: "Startup switches save" })
      ).toBe(status)
      expect(status).toBeEmptyDOMElement()
      expect(autoStart).toBeChecked()
      expect(autoStart).toHaveFocus()
    })
  })

  describe("vmo", () => {
    it("shows vmo under the backend and above LM Studio", async () => {
      await startRuntimePane()

      const vmoCard = screen.getByRole("region", { name: "vmo page reader" })
      const backendSwitch = screen.getByRole("switch", {
        name: "Start it when Lys opens"
      })
      const lmStudioCard = screen.getByRole("region", {
        name: "LM Studio connection"
      })
      expect(
        backendSwitch.compareDocumentPosition(vmoCard) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        vmoCard.compareDocumentPosition(lmStudioCard) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        screen.getByRole("heading", { name: "vmo stopped" })
      ).toBeInTheDocument()
    })

    it("starts a stopped vmo and stops it again", async () => {
      let isRunning = false
      const host = startNativeHostFake({
        get_vmo_status: () =>
          isRunning ? { status: "running", pid: 4343 } : { status: "stopped" },
        start_vmo: () => {
          isRunning = true
          return { status: "running", pid: 4343 }
        },
        get_vmo_health: () => "ready",
        stop_vmo: () => {
          isRunning = false
          return { status: "stopped" }
        }
      })
      await startRuntimePane()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Start vmo" }))
      await waitForRenderedWork()
      const afterStart = screen.getByRole("heading", { name: "vmo running" })
      await user.click(screen.getByRole("button", { name: "Stop vmo" }))
      await waitForRenderedWork()

      expect(afterStart).toBeInTheDocument()
      expect(
        screen.getByRole("heading", { name: "vmo stopped" })
      ).toBeInTheDocument()
      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_vmo_status",
        "start_vmo",
        "get_vmo_status",
        "get_vmo_health",
        "get_vmo_status",
        "stop_vmo"
      ])
    })

    it("keeps whether vmo starts when Lys opens for the next time Lys opens", async () => {
      const saves: unknown[] = []
      startNativeHostFake({
        load_settings: () => FIRST_RUN_SETTINGS_DOCUMENT,
        save_settings: (args) => {
          saves.push(args)
        }
      })
      const { useLysStore } = await startRuntimePane()
      const user = userEvent.setup()
      const autoStart = screen.getByRole("switch", {
        name: "Start vmo when Lys opens"
      })
      expect(autoStart).toBeChecked()

      await user.click(autoStart)
      await waitForRenderedWork()

      expect(autoStart).not.toBeChecked()
      expect(useLysStore.getState().settings.runtime.autoStartVmo).toBe(false)
      const savedRuntime = expect.objectContaining({
        autoStartBackend: true,
        autoStartVmo: false
      })
      const savedSettings = expect.objectContaining({ runtime: savedRuntime })
      expect(saves).toContainEqual({ newSettings: savedSettings })
    })
  })

  describe("LM Studio", () => {
    it("asks the backend to reconnect and shows the result", async () => {
      const runtime = buildUnreachableRuntime("running", "unreachable")
      const { backend } = await startRuntimePane(runtime, {
        "POST /api/v1/llm/runtime/connect": () =>
          buildJsonResponse(200, { status: "connected" }),
        // Once reconnected, the backend lists the models again.
        [INVENTORY_ROUTE]: buildInventoryRoute(NOTHING_LOADED)
      })
      const user = userEvent.setup()
      expect(
        screen.getByRole("heading", { name: "LM Studio not reachable" })
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Refresh" }))
      await waitForRenderedWork()

      expect(
        screen.getByRole("heading", { name: "LM Studio connected" })
      ).toBeInTheDocument()
      expect(screen.getByText("127.0.0.1:1234")).toBeInTheDocument()
      expect(listRouteKeys(backend)).toContain(
        "POST /api/v1/llm/runtime/connect"
      )
    })
  })

  describe("model residency", () => {
    it("shows loaded weights and unloads them", async () => {
      const { backend } = await startRuntimePane(READY_RUNTIME, {
        "PATCH /api/v1/llm/unload": () => new Response(null, { status: 204 })
      })
      const user = userEvent.setup()

      expect(
        screen.getByRole("heading", { name: "Model loaded" })
      ).toBeInTheDocument()
      expect(
        screen.getByText("qwen3-8b · loaded in LM Studio")
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()

      await user.click(screen.getByRole("button", { name: "Unload" }))
      await waitForRenderedWork()

      const unload = backend.requests.find(
        (request) => request.method === "PATCH"
      )
      expect(unload?.body).toEqual({ modelId: "qwen3-8b" })
    })

    it("loads the chosen default while nothing is loaded, showing progress meanwhile", async () => {
      const load = createControlledPromise<Response>()
      const { backend } = await startRuntimePane(NOTHING_LOADED, {
        "POST /api/v1/llm/load": () => load.promise
      })
      const user = userEvent.setup()
      expect(
        screen.getByRole("heading", { name: "No model loaded" })
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()

      await user.click(screen.getByRole("button", { name: "Load" }))
      await waitForRenderedWork()

      const progress = screen.getByRole("progressbar", {
        name: "Loading weights"
      })
      // The model card is the one part of the pane marked busy meanwhile.
      const busyParts = document.querySelectorAll('[aria-busy="true"]')
      expect(busyParts).toHaveLength(1)
      expect(busyParts[0]).toContainElement(progress)
      expect(busyParts[0]).toContainElement(
        screen.getByRole("heading", { name: "Loading weights" })
      )
      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
      expect(screen.getByText("loading qwen3-8b…")).toBeInTheDocument()
      expect(
        backend.requests.find((request) => request.method === "POST")?.body
      ).toEqual({
        modelId: "qwen3-8b",
        configuration: FIRST_RUN_LOAD_CONFIGURATION
      })

      load.resolve(
        buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: true }))
      )
      await waitForRenderedWork()
      expect(screen.queryByRole("progressbar")).toBeNull()
    })

    it("cannot load without a chosen default", async () => {
      await startRuntimePane({ ...NOTHING_LOADED, defaultModel: null })

      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
    })

    it.each([
      ["the backend is stopped", buildUnreachableRuntime("stopped")],
      [
        "LM Studio is not reachable",
        buildUnreachableRuntime("running", "unreachable")
      ]
    ])(
      "shows the model state as unavailable, not as empty, while %s",
      async (_case, runtime) => {
        await startRuntimePane(runtime)

        expect(
          screen.getByRole("heading", { name: "Model state unavailable" })
        ).toBeInTheDocument()
      }
    )

    it("offers no model command while LM Studio is not reachable", async () => {
      await startRuntimePane(buildUnreachableRuntime("running", "unreachable"))

      expect(screen.queryByRole("button", { name: "Load" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Unload" })).toBeNull()
    })
  })
})
