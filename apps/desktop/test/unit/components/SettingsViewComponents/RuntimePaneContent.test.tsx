import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
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
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Backend origin the settings name. */
const BACKEND_ADDRESS = initialSettingsState.runtime.backendAddress

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
async function renderRuntimePane(
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
  await settle()
  return { useLysStore, backend }
}

/**
 * Lets pending requests and store updates settle inside a React update scope.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
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
      startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
      const { useLysStore, SettingsView } =
        await loadFreshSettingsView("runtime")
      useLysStore.setState({
        backendServerInfo: {
          status: "running",
          startedAt: new Date(Date.now() - 65_500)
        }
      })

      render(<SettingsView onDone={vi.fn()} />)
      await screen.findByRole("switch", { name: "Start it when Lys opens" })
      await settle()

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
        await renderRuntimePane(buildUnreachableRuntime(backendStatus))

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
      await renderRuntimePane(buildUnreachableRuntime("stopped"))
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Start" }))
      await settle()

      expect(
        screen.getByRole("heading", { name: "Backend starting" })
      ).toBeInTheDocument()
      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_backend_status",
        "start_backend"
      ])

      start.resolve({ running: false })
      await settle()
      expect(
        screen.getByRole("heading", { name: "Backend stopped" })
      ).toBeInTheDocument()
    })

    it("stops a running backend", async () => {
      const host = startNativeHostFake({
        get_backend_status: () => ({ running: true, pid: 4242 }),
        stop_backend: () => ({ running: false })
      })
      await renderRuntimePane()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Stop" }))
      await settle()

      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_backend_status",
        "stop_backend"
      ])
      expect(
        screen.getByRole("heading", { name: "Backend stopped" })
      ).toBeInTheDocument()
    })

    it("switches whether the backend starts when Lys opens", async () => {
      const { useLysStore } = await renderRuntimePane()
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
      await renderRuntimePane()
      const user = userEvent.setup()

      await user.click(
        screen.getByRole("switch", { name: "Start it when Lys opens" })
      )
      await settle()

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
      const { backend } = await renderRuntimePane(runtime, {
        "POST /api/v1/llm/runtime/connect": () =>
          buildJsonResponse(200, { status: "connected" })
      })
      const user = userEvent.setup()
      expect(
        screen.getByRole("heading", { name: "LM Studio not reachable" })
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Refresh" }))
      await settle()

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
      const { backend } = await renderRuntimePane(READY_RUNTIME, {
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
      await settle()

      const unload = backend.requests.find(
        (request) => request.method === "PATCH"
      )
      expect(unload?.body).toEqual({ modelId: "qwen3-8b" })
    })

    it("loads the chosen default while nothing is loaded, showing progress meanwhile", async () => {
      const load = createControlledPromise<Response>()
      const { backend } = await renderRuntimePane(NOTHING_LOADED, {
        "POST /api/v1/llm/load": () => load.promise
      })
      const user = userEvent.setup()
      expect(
        screen.getByRole("heading", { name: "No model loaded" })
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()

      await user.click(screen.getByRole("button", { name: "Load" }))
      await settle()

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
      await settle()
      expect(screen.queryByRole("progressbar")).toBeNull()
    })

    it("cannot load without a chosen default", async () => {
      await renderRuntimePane({ ...NOTHING_LOADED, defaultModel: null })

      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
    })

    it("offers no model command while LM Studio is not reachable", async () => {
      await renderRuntimePane(buildUnreachableRuntime("running", "unreachable"))

      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()
    })
  })
})
