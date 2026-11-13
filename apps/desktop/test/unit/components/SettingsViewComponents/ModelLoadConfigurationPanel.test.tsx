import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "@/lib/store/settings"
import { updateProviderModelState } from "@/lib/store/model-runtime"
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
 * Renders the settings view on the Model pane, showing the default model,
 * and waits for its load settings.
 *
 * @param arrangement - Runtime, routes, and settings of the case.
 * @returns The application store, the backend observation handle, and a
 * user-event session.
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
  const { settings, providerModels } = useLysStore.getState()
  useLysStore.setState({
    settings: {
      ...settings,
      loadConfiguration:
        arrangement.loadConfiguration ?? settings.loadConfiguration
    },
    ...(arrangement.sentConfiguration === undefined
      ? {}
      : {
          providerModels: updateProviderModelState(providerModels, "lmStudio", {
            loadedModelConfigurations: new Map([
              [
                "qwen3-8b",
                { origin: "sent", configuration: arrangement.sentConfiguration }
              ]
            ])
          })
        })
  })
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("heading", { level: 4, name: "Load settings" })
  await waitForRenderedWork()
  return { useLysStore, backend, user: userEvent.setup() }
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
 * Types an evaluation batch size into its box.
 *
 * @param batchSize - Size to type.
 */
async function updateEvalBatchSize(batchSize: number): Promise<void> {
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Evaluation batch size" }),
    { target: { value: String(batchSize) } }
  )
  await waitForRenderedWork()
}

/**
 * Gets the status line that says a change is saved and how it applies.
 *
 * @returns The status region of the change notice.
 */
function getChangeNote(): HTMLElement {
  return screen.getByRole("status", { name: "Load settings changes" })
}

/**
 * Gets the status line that reports the automatic save.
 *
 * @returns The polite status region of the save feedback.
 */
function getSaveStatus(): HTMLElement {
  return screen.getByRole("status", { name: "Load settings save" })
}

/**
 * Gets the context length slider's thumb.
 *
 * @returns The thumb's range input, which jsdom leaves hidden.
 */
function getContextLengthSlider(): HTMLElement {
  return screen.getByRole("slider", { name: "Context length", hidden: true })
}

describe("ModelLoadConfigurationPanel", () => {
  describe("the model it edits", () => {
    it("edits the selected model, and follows another selection", async () => {
      const { user } = await startLoadConfigurationPanel()
      const stopsBefore = getContextLengthSlider().getAttribute("max")

      await user.click(screen.getByRole("button", { name: /^gemma-3/ }))

      expect(stopsBefore).toBe("2")
      expect(getContextLengthSlider()).toHaveAttribute("max", "4")
    })
  })

  describe("an edit", () => {
    it("applies to the model in memory at once and is saved for that model, announcing the save while it runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      const { useLysStore } = await startLoadConfigurationPanel()

      await updateEvalBatchSize(1024)
      const statusWhileSaving = getSaveStatus().textContent
      writes[0]?.resolve(null)
      await waitForRenderedWork()

      expect(
        Object.fromEntries(
          useLysStore.getState().settings.loadConfiguration.models
        )
      ).toEqual({ "qwen3-8b": { evalBatchSize: 1024 } })
      expect(
        screen.getByRole("spinbutton", { name: "Evaluation batch size" })
      ).toHaveValue(1024)
      expect(statusWhileSaving).toBe("Saving the load settings…")
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
      const { useLysStore, user } = await startLoadConfigurationPanel()
      await updateEvalBatchSize(1024)
      const statusAfterFailure = getSaveStatus().textContent

      await user.click(screen.getByRole("button", { name: "Retry saving" }))
      await waitForRenderedWork()

      expect(statusAfterFailure).toBe(
        "Couldn’t save the load settings. Your edits still apply to models loaded in this session."
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
      const { useLysStore, user } = await startLoadConfigurationPanel({
        loadConfiguration: {
          default: {},
          models: new Map([["qwen3-8b", { numExperts: 1 }]])
        }
      })

      await user.click(screen.getByRole("button", { name: "Fewer experts" }))
      await waitForRenderedWork()

      expect(
        useLysStore.getState().settings.loadConfiguration.models.size
      ).toBe(0)
      expect(
        screen.getByRole("status", { name: "Active experts" })
      ).toHaveTextContent(/^Auto$/)
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

  describe("a changed model", () => {
    it("says nothing while the stored settings equal the ones the model runs with", async () => {
      await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION
      })

      expect(getChangeNote()).toBeEmptyDOMElement()
    })

    it("says a reload applies a change to a loaded model, and reloads it with the stored settings on request", async () => {
      startSavingSettingsHost()
      const { backend, user } = await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION,
        routes: {
          "PATCH /api/v1/llm/lmStudio/unload": () =>
            new Response(null, { status: 204 }),
          "POST /api/v1/llm/lmStudio/load": () =>
            buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: true }))
        }
      })
      await updateEvalBatchSize(1024)
      const noteBeforeReload = getChangeNote().textContent

      await user.click(screen.getByRole("button", { name: "Reload" }))
      await waitForRenderedWork()

      expect(noteBeforeReload).toBe(
        "Saved. Reload qwen3-8b to apply it.ReloadUndo"
      )
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
      expect(getChangeNote()).toBeEmptyDOMElement()
    })

    it("says a change to a model on disk applies when it loads, and undoes it", async () => {
      startSavingSettingsHost()
      const { useLysStore, user } = await startLoadConfigurationPanel()
      await user.click(screen.getByRole("button", { name: /^gemma-3/ }))

      await user.click(screen.getByRole("switch", { name: "Flash attention" }))

      expect(getChangeNote()).toHaveTextContent(
        /^Saved\. Applies when you load it\.Undo$/
      )
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull()

      await user.click(screen.getByRole("button", { name: "Undo" }))

      expect(getChangeNote()).toBeEmptyDOMElement()
      expect(
        screen.getByRole("switch", { name: "Flash attention" })
      ).toBeChecked()
      expect(
        useLysStore.getState().settings.loadConfiguration.models.get("gemma-3")
      ).toMatchObject({ flashAttention: true })
    })

    it("refuses a reload while another of LM Studio's requests is in flight", async () => {
      startSavingSettingsHost()
      const inventory = createControlledRoute()
      const { user } = await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION,
        routes: { [INVENTORY_ROUTE]: inventory.route }
      })
      const listed = () =>
        buildJsonResponse(200, {
          llms:
            TWO_MODELS.modelInventory.status === "ready"
              ? TWO_MODELS.modelInventory.models
              : [],
          modelLoading: "lys"
        })
      inventory.responses[0]?.resolve(listed())
      await waitForRenderedWork()
      await updateEvalBatchSize(1024)

      await user.click(screen.getByRole("button", { name: "Refresh" }))
      await waitForRenderedWork()
      const isDisabledDuringRequest = screen
        .getByRole("button", { name: "Reload" })
        .hasAttribute("disabled")
      inventory.responses[1]?.resolve(listed())
      await waitForRenderedWork()

      expect(isDisabledDuringRequest).toBe(true)
      expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled()
    })

    it("withholds the notice while the model itself is being unloaded and loaded", async () => {
      startSavingSettingsHost()
      const unload = createControlledRoute()
      const { user } = await startLoadConfigurationPanel({
        sentConfiguration: FIRST_RUN_LOAD_CONFIGURATION,
        routes: {
          "PATCH /api/v1/llm/lmStudio/unload": unload.route,
          "POST /api/v1/llm/lmStudio/load": () =>
            buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: true }))
        }
      })
      await updateEvalBatchSize(1024)

      await user.click(screen.getByRole("button", { name: "Reload" }))
      await waitForRenderedWork()
      const noteDuringReload = getChangeNote().textContent
      unload.responses[0]?.resolve(new Response(null, { status: 204 }))
      await waitForRenderedWork()

      expect(noteDuringReload).toBe("")
    })
  })
})
