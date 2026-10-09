import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ModelRequestFeedback from "@/components/SettingsViewComponents/ModelRequestFeedback"
import {
  SettingsContext,
  type SettingsContextValue
} from "@/components/SettingsViewComponents/SettingsContext"
import { initialModelState, type ModelState } from "@/lib/store/model-runtime"
import { initialSettingsState } from "@/lib/store/settings"

/**
 * Builds the settings authority a pane reads, with the model state a case
 * arranges.
 *
 * @param modelState - Model fields the case varies.
 * @returns A complete context value with spy callbacks.
 */
function buildSettingsContext(
  modelState: Partial<ModelState>
): SettingsContextValue {
  return {
    ...initialModelState,
    ...modelState,
    settings: initialSettingsState,
    onRuntimeChange: vi.fn(),
    onModelChange: vi.fn(),
    onGenerationChange: vi.fn(),
    onLoadModel: vi.fn(() => Promise.resolve()),
    onUnloadModel: vi.fn(() => Promise.resolve()),
    onTestModel: vi.fn(() => Promise.resolve()),
    onRefreshModels: vi.fn(() => Promise.resolve())
  }
}

/**
 * Renders the feedback under a settings authority.
 *
 * @param modelState - Model fields the case varies.
 */
function renderFeedback(modelState: Partial<ModelState>): void {
  render(
    <SettingsContext value={buildSettingsContext(modelState)}>
      <ModelRequestFeedback />
    </SettingsContext>
  )
}

describe("ModelRequestFeedback", () => {
  it("keeps an empty status and alert while nothing happens", () => {
    renderFeedback({})

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.getByRole("alert")).toBeEmptyDOMElement()
  })

  it.each<[ModelState["modelRequest"], string]>([
    [{ status: "listing" }, "Refreshing model inventory…"],
    [{ status: "loading", modelKey: "qwen3-8b" }, "loading qwen3-8b…"],
    [{ status: "unloading", modelKey: "qwen3-8b" }, "unloading qwen3-8b…"],
    [{ status: "testing", modelKey: "qwen3-8b" }, "testing qwen3-8b…"]
  ])("announces the pending request %o", (modelRequest, announcement) => {
    renderFeedback({ modelRequest })

    expect(screen.getByRole("status")).toHaveTextContent(announcement)
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  })

  it("reports a loaded-state health check without claiming inference ran", () => {
    renderFeedback({
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
      renderFeedback({
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
    renderFeedback({
      modelRequest: { status: "listing" },
      modelHealth: { status: "ready", modelId: "qwen3-8b", latencyMs: 42 }
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      "Refreshing model inventory…"
    )
  })

  it("alerts the latest request failure", () => {
    renderFeedback({ modelError: "LM Studio could not load qwen3-8b." })

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
