import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "@/lib/store/settings"
import {
  buildJsonResponse,
  createControlledRoute,
  startBackendFake,
  type BackendRoutes
} from "../../support/backendFake"
import { buildLlmInfo } from "../../support/modelFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import {
  READY_RUNTIME,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"
import {
  FIRST_RUN_LOAD_CONFIGURATION,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import {
  createControlledPromise,
  type ControlledPromise
} from "../../support/settlement"

/**
 * `qwen3-8b` resident and chosen as default, and `gemma-3` on disk with a
 * larger maximum context.
 */
const TWO_MODELS: RuntimeArrangement = {
  ...READY_RUNTIME,
  modelInventory: {
    status: "ready",
    modelLoading: "lys",
    models: [
      buildLlmInfo("qwen3-8b", { loaded: true }),
      buildLlmInfo("gemma-3", { maxContextLength: 32_768 })
    ]
  }
}

/** What a case arranges before the Model pane appears. */
type PanelArrangement = Readonly<{
  /** Backend, LM Studio, and model facts; {@link TWO_MODELS} by default. */
  runtime?: RuntimeArrangement
  /** Backend routes beside the inventory read. */
  routes?: BackendRoutes
  /** Load settings held in memory; none by default, as on a first run. */
  loadConfiguration?: LoadConfigurationSettings
  /**
   * Configuration Lys loaded `qwen3-8b` with in this session. Without it the
   * model is found already loaded, so its configuration is only assumed.
   */
  sentConfiguration?: CompleteModelLoadConfiguration
}>

/**
 * Renders the settings view on the Model pane and waits for its load
 * configuration section.
 *
 * @param arrangement - Runtime, routes, and settings of the case.
 * @returns The application store and the backend observation handle.
 */
async function startLoadConfigurationPanel(arrangement: PanelArrangement = {}) {
  const runtime = arrangement.runtime ?? TWO_MODELS
  const backend = startBackendFake({
    [INVENTORY_ROUTE]: buildInventoryRoute(runtime),
    ...arrangement.routes
  })
  const { useLysStore, SettingsView } = await loadFreshSettingsView(
    "model",
    runtime
  )
  const { settings } = useLysStore.getState()
  useLysStore.setState({
    settings: {
      ...settings,
      loadConfiguration:
        arrangement.loadConfiguration ?? settings.loadConfiguration
    },
    ...(arrangement.sentConfiguration === undefined
      ? {}
      : {
          loadedModelConfigurations: new Map([
            [
              "qwen3-8b",
              { origin: "sent", configuration: arrangement.sentConfiguration }
            ]
          ])
        })
  })
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("heading", { name: "load configuration" })
  await waitForRenderedWork()
  return { useLysStore, backend }
}

/**
 * Starts a native host that loads the stored settings document and whose
 * settings writes stay pending until the case settles them.
 *
 * @returns The host observation handle and the pending writes in order.
 */
function startControlledSettingsHost() {
  const writes: ControlledPromise<null>[] = []
  const host = startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => {
      const write = createControlledPromise<null>()
      writes.push(write)
      return write.promise
    }
  })
  return { host, writes }
}

/**
 * Starts a native host that saves every settings write at once.
 *
 * @returns The host observation handle.
 */
function startSavingSettingsHost() {
  return startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => null
  })
}

/**
 * Gets the load configuration section of the Model pane.
 *
 * @returns The section holding the heading, the rows, and the feedback.
 */
function getLoadConfigurationSection(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: "load configuration" })
    .closest("section")
  if (section === null) throw new Error("The heading has no section")
  return section
}

/**
 * Presses one of the offered eval batch sizes.
 *
 * @param user - User-event session of the case.
 * @param batchSize - Offered size to press.
 */
async function updateEvalBatchSize(
  user: ReturnType<typeof userEvent.setup>,
  batchSize: number
): Promise<void> {
  await user.click(
    within(screen.getByRole("group", { name: "Eval batch size" })).getByRole(
      "button",
      { name: String(batchSize) }
    )
  )
  await waitForRenderedWork()
}

/**
 * Gets the status line that says what a reload would apply.
 *
 * @returns The polite status region of the reload control.
 */
function getReloadNote(): HTMLElement {
  return screen.getByRole("status", { name: "Load configuration changes" })
}

/**
 * Gets the status line that reports the automatic save.
 *
 * @returns The polite status region of the save feedback.
 */
function getSaveStatus(): HTMLElement {
  return screen.getByRole("status", { name: "Load configuration save" })
}

describe("ModelLoadConfigurationPanel", () => {
  describe("the model it edits", () => {
    it("edits the selected default model, named beside the heading, and follows a new choice", async () => {
      await startLoadConfigurationPanel()
      const user = userEvent.setup()
      const section = getLoadConfigurationSection()
      const targetBefore = within(section).getByText("qwen3-8b")
      const maximumBefore = within(section).getByText(/^max /).textContent

      await user.click(
        screen.getByRole("button", { name: /^gemma-3/, pressed: false })
      )

      expect(targetBefore).toBeInTheDocument()
      expect(maximumBefore).toBe("max 8k")
      expect(within(section).getByText("gemma-3")).toBeInTheDocument()
      expect(within(section).getByText(/^max /)).toHaveTextContent("max 32k")
    })

    it.each([
      [
        "no default model is chosen",
        { ...TWO_MODELS, defaultModel: null },
        "Choose a default model above to edit its load configuration."
      ],
      [
        "the inventory does not list the default model",
        { ...TWO_MODELS, defaultModel: "phi-4" },
        "Choose a default model above to edit its load configuration."
      ]
    ] as const)(
      "offers no setting and says why when %s",
      async (_label, runtime, message) => {
        await startLoadConfigurationPanel({ runtime })

        const section = getLoadConfigurationSection()
        expect(within(section).getByText(message)).toBeInTheDocument()
        expect(
          within(section).queryByRole("heading", { level: 3 })
        ).not.toBeInTheDocument()
      }
    )
  })

  describe("an edit", () => {
    it("applies to the model in memory at once and is saved for that model, announcing the save while it runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { useLysStore } = await startLoadConfigurationPanel()
      const user = userEvent.setup()

      await updateEvalBatchSize(user, 1024)
      const statusWhileSaving = getSaveStatus().textContent
      writes[0]?.resolve(null)
      await waitForRenderedWork()

      expect(
        Object.fromEntries(
          useLysStore.getState().settings.loadConfiguration.models
        )
      ).toEqual({ "qwen3-8b": { evalBatchSize: 1024 } })
      expect(
        within(
          screen.getByRole("group", { name: "Eval batch size" })
        ).getByRole("button", { pressed: true })
      ).toHaveTextContent("1024")
      expect(statusWhileSaving).toBe("Saving the load configuration…")
      expect(getSaveStatus()).toBeEmptyDOMElement()
      expect(
        host.commands.filter((invoked) => invoked.command === "save_settings")
      ).toEqual([
        {
          command: "save_settings",
          args: {
            newSettings: {
              ...STORED_SETTINGS_DOCUMENT,
              loadConfiguration: {
                default: STORED_SETTINGS_DOCUMENT.loadConfiguration.default,
                models: { "qwen3-8b": { evalBatchSize: 1024 } }
              }
            }
          }
        }
      ])
    })

    it("keeps the edit when its save fails, says so, and saves it on Retry saving", async () => {
      let writeCount = 0
      const host = startNativeHostFake({
        load_settings: () => STORED_SETTINGS_DOCUMENT,
        save_settings: () => {
          writeCount += 1
          return writeCount === 1 ? Promise.reject("Disk full") : null
        }
      })
      const { useLysStore } = await startLoadConfigurationPanel()
      const user = userEvent.setup()
      await updateEvalBatchSize(user, 1024)
      const statusAfterFailure = getSaveStatus().textContent

      await user.click(screen.getByRole("button", { name: "Retry saving" }))
      await waitForRenderedWork()

      expect(statusAfterFailure).toBe(
        "Could not save the load configuration. Your edits still apply to models loaded in this session."
      )
      expect(
        useLysStore.getState().settings.loadConfiguration.models.get("qwen3-8b")
      ).toEqual({ evalBatchSize: 1024 })
      expect(getSaveStatus()).toBeEmptyDOMElement()
      expect(
        screen.queryByRole("button", { name: "Retry saving" })
      ).not.toBeInTheDocument()
      expect(
        host.commands.filter((invoked) => invoked.command === "save_settings")
      ).toHaveLength(2)
    })

    it("removes the model's own expert count on a step down from one expert, leaving the count to the model", async () => {
      startSavingSettingsHost()
      const { useLysStore } = await startLoadConfigurationPanel({
        loadConfiguration: {
          default: {},
          models: new Map([["qwen3-8b", { numExperts: 1 }]])
        }
      })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Fewer experts" }))
      await waitForRenderedWork()

      expect(
        useLysStore.getState().settings.loadConfiguration.models.size
      ).toBe(0)
      expect(
        screen.getByRole("status", { name: "Active experts" })
      ).toHaveTextContent(/^auto$/)
    })

    it("offers no step below one expert when the stored default sets a count the model would then get", async () => {
      await startLoadConfigurationPanel({
        loadConfiguration: {
          default: { numExperts: 2 },
          models: new Map([["qwen3-8b", { numExperts: 1 }]])
        }
      })

      expect(
        screen.getByRole("button", { name: "Fewer experts" })
      ).toBeDisabled()
    })
  })

  describe("a loaded model whose stored settings changed", () => {
    it("says nothing while the stored settings equal the ones the model runs with", async () => {
      await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION
      })

      expect(getReloadNote()).toBeEmptyDOMElement()
      expect(
        screen.queryByRole("button", { name: "Reload now" })
      ).not.toBeInTheDocument()
    })

    it("names what a model Lys loaded runs with, and reloads it with the stored settings on request", async () => {
      startSavingSettingsHost()
      const { backend } = await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION,
        routes: {
          "PATCH /api/v1/llm/unload": () => new Response(null, { status: 204 }),
          "POST /api/v1/llm/load": () =>
            buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: true }))
        }
      })
      const user = userEvent.setup()
      await updateEvalBatchSize(user, 1024)
      const noteBeforeReload = getReloadNote().textContent
      const loadedValueBeforeReload = screen.getByText("loaded · 512")

      await user.click(screen.getByRole("button", { name: "Reload now" }))
      await waitForRenderedWork()

      expect(noteBeforeReload).toBe(
        "loaded with batch 512 · reload to apply batch 1024"
      )
      expect(loadedValueBeforeReload).not.toBeInTheDocument()
      expect(
        backend.requests
          .filter((request) => request.method !== "GET")
          .map((request) => [request.method, request.body])
      ).toEqual([
        ["PATCH", { modelId: "qwen3-8b" }],
        [
          "POST",
          {
            modelId: "qwen3-8b",
            configuration: {
              ...FIRST_RUN_LOAD_CONFIGURATION,
              evalBatchSize: 1024
            }
          }
        ]
      ])
      expect(getReloadNote()).toBeEmptyDOMElement()
      expect(
        screen.queryByRole("button", { name: "Reload now" })
      ).not.toBeInTheDocument()
    })

    it("claims no loaded value for a model found already loaded, only that changes wait for its next load", async () => {
      startSavingSettingsHost()
      await startLoadConfigurationPanel()
      const user = userEvent.setup()

      await updateEvalBatchSize(user, 1024)

      expect(getReloadNote()).toHaveTextContent(
        /^Changes apply the next time this model loads\.$/
      )
      expect(screen.queryByText(/^loaded · /)).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Reload now" })).toBeEnabled()
    })

    it("refuses a reload while another model request is in flight", async () => {
      startSavingSettingsHost()
      const health = createControlledRoute()
      await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION,
        routes: { "GET /api/v1/llm/qwen3-8b/health": health.route }
      })
      const user = userEvent.setup()
      await updateEvalBatchSize(user, 1024)

      await user.click(screen.getByRole("button", { name: "Test qwen3-8b" }))
      await waitForRenderedWork()
      const isDisabledDuringRequest = screen
        .getByRole("button", { name: "Reload now" })
        .hasAttribute("disabled")
      health.responses[0]?.resolve(
        buildJsonResponse(200, {
          status: "ready",
          modelId: "qwen3-8b",
          latencyMs: 12
        })
      )
      await waitForRenderedWork()

      expect(isDisabledDuringRequest).toBe(true)
      expect(screen.getByRole("button", { name: "Reload now" })).toBeEnabled()
    })

    it("withholds the prompt while the model itself is being unloaded and loaded", async () => {
      startSavingSettingsHost()
      const unload = createControlledRoute()
      await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION,
        routes: {
          "PATCH /api/v1/llm/unload": unload.route,
          "POST /api/v1/llm/load": () =>
            buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: true }))
        }
      })
      const user = userEvent.setup()
      await updateEvalBatchSize(user, 1024)

      await user.click(screen.getByRole("button", { name: "Reload now" }))
      await waitForRenderedWork()
      const promptDuringReload = {
        note: getReloadNote().textContent,
        loadedValues: screen.queryAllByText(/^loaded · /).length,
        isReloadOffered:
          screen.queryByRole("button", { name: "Reload now" }) !== null
      }
      unload.responses[0]?.resolve(new Response(null, { status: 204 }))
      await waitForRenderedWork()

      expect(promptDuringReload).toEqual({
        note: "",
        loadedValues: 0,
        isReloadOffered: false
      })
    })
  })
})
