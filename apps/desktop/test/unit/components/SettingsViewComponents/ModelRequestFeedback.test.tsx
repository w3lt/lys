import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ModelRequestFeedback from "@/components/SettingsViewComponents/ModelRequestFeedback"
import {
  SettingsContext,
  type SettingsContextValue
} from "@/components/SettingsViewComponents/SettingsContext"
import { INITIAL_PROVIDER_MODEL_STATES } from "@/lib/store/model-runtime"
import { initialSettingsState } from "@/lib/store/settings"

/** The request fields of the shown provider a case varies. */
type ModelFeedbackArrangement = Partial<
  Pick<SettingsContextValue, "modelRequest" | "modelError" | "modelHealth">
>

/**
 * Builds the settings authority a pane reads, with the request state of the
 * shown provider a case arranges.
 *
 * @param arrangement - Request fields the case varies; the others are LM
 * Studio's initial state.
 * @returns A complete context value with spy callbacks.
 */
function buildSettingsContext(
  arrangement: ModelFeedbackArrangement
): SettingsContextValue {
  const { inventory, request, error, health, loadedModelConfigurations } =
    INITIAL_PROVIDER_MODEL_STATES.lmStudio
  return {
    settings: initialSettingsState,
    shownProvider: "lmStudio",
    providerAvailability: "available",
    modelInventory: inventory,
    modelRequest: request,
    modelError: error,
    modelHealth: health,
    loadedModelConfigurations,
    newConversationModel: { model: null, availability: null },
    ...arrangement,
    onRuntimeChange: vi.fn(),
    onGenerationChange: vi.fn(),
    onAssignModelLoadSettings: vi.fn(),
    onRemoveModelExpertCount: vi.fn(),
    onLoadModel: vi.fn(() => Promise.resolve()),
    onUnloadModel: vi.fn(() => Promise.resolve()),
    onReloadModel: vi.fn(() => Promise.resolve()),
    onTestModel: vi.fn(() => Promise.resolve()),
    onRefreshModels: vi.fn(() => Promise.resolve())
  }
}

/**
 * Renders the feedback under a settings authority.
 *
 * @param arrangement - Request fields the case varies.
 */
function startFeedback(arrangement: ModelFeedbackArrangement): void {
  render(
    <SettingsContext value={buildSettingsContext(arrangement)}>
      <ModelRequestFeedback />
    </SettingsContext>
  )
}

describe("ModelRequestFeedback", () => {
  it("keeps an empty status and alert while nothing happens", () => {
    startFeedback({})

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.getByRole("alert")).toBeEmptyDOMElement()
  })

  it.each<[SettingsContextValue["modelRequest"], string]>([
    [{ status: "listing" }, "Refreshing model inventory…"],
    [{ status: "loading", modelKey: "qwen3-8b" }, "loading qwen3-8b…"],
    [{ status: "unloading", modelKey: "qwen3-8b" }, "unloading qwen3-8b…"],
    [{ status: "testing", modelKey: "qwen3-8b" }, "testing qwen3-8b…"]
  ])("announces the pending request %o", (modelRequest, announcement) => {
    startFeedback({ modelRequest })

    expect(screen.getByRole("status")).toHaveTextContent(announcement)
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  })

  it("reports a loaded-state health check without claiming inference ran", () => {
    startFeedback({
      modelHealth: { status: "ready", modelId: "qwen3-8b", latencyMs: 42 }
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      "qwen3-8b: loaded · health query 42 ms"
    )
  })

  it.each([
    ["model-not-loaded", "not loaded"],
    ["runtime-unavailable", "runtime unavailable"]
  ] as const)(
    "reports a health check that found the model %s",
    (reason, label) => {
      startFeedback({
        modelHealth: {
          status: "not-ready",
          reason,
          modelId: "qwen3-8b",
          latencyMs: 7
        }
      })

      expect(screen.getByRole("status")).toHaveTextContent(
        `qwen3-8b: ${label} · health query 7 ms`
      )
    }
  )

  it("prefers the pending request over the last health result", () => {
    startFeedback({
      modelRequest: { status: "listing" },
      modelHealth: { status: "ready", modelId: "qwen3-8b", latencyMs: 42 }
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      "Refreshing model inventory…"
    )
  })

  it("alerts the latest request failure", () => {
    startFeedback({ modelError: "LM Studio could not load qwen3-8b." })

    expect(screen.getByRole("alert")).toHaveTextContent(
      "LM Studio could not load qwen3-8b."
    )
  })

  it("fails outside a settings authority", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    expect(() => render(<ModelRequestFeedback />)).toThrow(
      "Settings pane components must be rendered within SettingsContext.Provider"
    )
  })
})
