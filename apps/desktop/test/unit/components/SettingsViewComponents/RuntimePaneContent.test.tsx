import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { LM_STUDIO_ADDRESS } from "@/lib/models/lm-studio-connection"
import type { BackendServerStatus } from "@/lib/store"
import { initialSettingsState } from "@/lib/store/settings"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
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

/** LM Studio connected, the chosen default on disk and nothing loaded. */
const NOTHING_LOADED: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: { status: "ready", models: [buildLlmInfo("qwen3-8b")] }
}

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

/**
 * Lists the route keys of the requests a backend received, in order.
 *
 * @param backend - Backend observation handle.
 * @returns `<METHOD> <path>` of each request.
 */
function listRouteKeys(backend: ReturnType<typeof startBackendFake>) {
  return backend.requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`
  )
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
        expect(screen.getByRole("button", { name: "Start" })).toHaveProperty(
          "disabled",
          !canStart
        )
        expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty(
          "disabled",
          !canStop
        )
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

      await user.click(screen.getByRole("button", { name: "Start" }))
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

      await user.click(screen.getByRole("button", { name: "Stop" }))
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

    // Known defect, found by this suite: the switch changes the setting only
    // in memory, so the choice is lost before the next time Lys opens, the
    // only time it applies. #12 asked that the user can make the backend
    // start when Lys starts.
    it.fails("keeps the choice for the next time Lys opens", async () => {
      const saves: unknown[] = []
      startNativeHostFake({
        load_settings: () => initialSettingsState,
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
      expect(screen.getByText(LM_STUDIO_ADDRESS)).toBeInTheDocument()
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
      expect(progress.closest("section")).toHaveAttribute("aria-busy", "true")
      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
      expect(screen.getByText("loading qwen3-8b…")).toBeInTheDocument()
      expect(
        backend.requests.find((request) => request.method === "POST")?.body
      ).toEqual({ modelId: "qwen3-8b" })

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

    it("offers no model command while LM Studio is not reachable", async () => {
      await startRuntimePane(buildUnreachableRuntime("running", "unreachable"))

      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()
    })
  })
})
