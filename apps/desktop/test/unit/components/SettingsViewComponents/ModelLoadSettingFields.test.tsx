import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MAXIMUM_MODEL_LOAD_SETTING_VALUE } from "@lys/share"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import ModelLoadSettingFields from "@/components/SettingsViewComponents/ModelLoadSettingFields"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

/** Properties a case may vary; the others have the defaults below. */
type FieldsVariation = Partial<
  Pick<
    ComponentProps<typeof ModelLoadSettingFields>,
    "maxContextLength" | "configuration" | "isAutomaticExpertCountAvailable"
  >
>

/**
 * Renders the load settings of `qwen3-8b`, a model that tops out at 8,192
 * tokens and would be loaded with the committed default, with an automatic
 * expert count available.
 *
 * @param variation - Properties the case depends on.
 * @returns The recorders of the two requests and the rendered container.
 */
function startLoadSettingFields(variation: FieldsVariation = {}) {
  const requests = {
    onAssignModelLoadSettings: vi.fn(),
    onRemoveModelExpertCount: vi.fn()
  }
  const { container } = render(
    <ModelLoadSettingFields
      configuration={FIRST_RUN_LOAD_CONFIGURATION}
      isAutomaticExpertCountAvailable
      maxContextLength={8192}
      modelKey="qwen3-8b"
      {...variation}
      {...requests}
    />
  )
  return { ...requests, container }
}

/**
 * Builds the committed default with other values for some settings.
 *
 * @param settings - Settings that differ from the committed default.
 * @returns The configuration.
 */
function buildConfiguration(
  settings: Partial<CompleteModelLoadConfiguration>
): CompleteModelLoadConfiguration {
  return { ...FIRST_RUN_LOAD_CONFIGURATION, ...settings }
}

/**
 * Gets the context length slider's thumb.
 *
 * @returns The thumb's range input.
 * @remarks Base UI keeps the thumb hidden until it has measured the track,
 * which jsdom never lays out, so the hidden input is queried.
 */
function getContextLengthSlider(): HTMLElement {
  return screen.getByRole("slider", { name: "Context length", hidden: true })
}

/**
 * Gets the evaluation batch size box.
 *
 * @returns The number box.
 */
function getBatchSizeBox(): HTMLElement {
  return screen.getByRole("spinbutton", { name: "Evaluation batch size" })
}

describe("ModelLoadSettingFields", () => {
  it("presents the five load settings in the pane's order", () => {
    const { container } = startLoadSettingFields()

    expect(container).toHaveTextContent(
      /Context length.*Evaluation batch size.*Flash attention.*KV cache on GPU.*Active experts/
    )
  })

  describe("context length", () => {
    it("shows the length in tokens at its stop among the model's stops, labelling each stop", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ contextLength: 4096 })
      })

      const slider = getContextLengthSlider()
      expect(slider).toHaveValue("1")
      expect(slider).toHaveAttribute("min", "0")
      expect(slider).toHaveAttribute("max", "2")
      expect(slider).toHaveAttribute("aria-valuetext", "4,096 tokens")
      expect(slider).toHaveAccessibleDescription(
        "The composer's context meter and the Agents pane measure against this length."
      )
      expect(screen.getByText("4,096 tokens")).toBeInTheDocument()
      expect(
        screen
          .getAllByRole("listitem", { hidden: true })
          .map((stop) => stop.textContent)
      ).toEqual(["2k", "4k", "8k"])
    })

    it("shows a length between two stops at the lower one", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ contextLength: 5000 })
      })

      expect(getContextLengthSlider()).toHaveValue("1")
      expect(screen.getByText("5,000 tokens")).toBeInTheDocument()
    })

    it("asks for the stop the slider moves to", () => {
      const requests = startLoadSettingFields({
        configuration: buildConfiguration({ contextLength: 4096 })
      })

      fireEvent.keyDown(getContextLengthSlider(), { key: "ArrowRight" })
      fireEvent.keyDown(getContextLengthSlider(), { key: "ArrowLeft" })

      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { contextLength: 8192 }],
        ["qwen3-8b", { contextLength: 2048 }]
      ])
    })

    it("offers no slider for a model whose maximum gives a single stop", () => {
      startLoadSettingFields({
        maxContextLength: 2048,
        configuration: buildConfiguration({ contextLength: 2048 })
      })

      expect(
        screen.queryByRole("slider", { hidden: true })
      ).not.toBeInTheDocument()
      expect(screen.getByText("2,048 tokens")).toBeInTheDocument()
    })
  })

  describe("evaluation batch size", () => {
    it("shows the size, described by what it does", () => {
      startLoadSettingFields()

      expect(getBatchSizeBox()).toHaveValue(512)
      expect(getBatchSizeBox()).toHaveAttribute("aria-invalid", "false")
      expect(getBatchSizeBox()).toHaveAccessibleDescription(
        "Prompt tokens read at once. Larger is faster and uses more memory."
      )
    })

    it("asks for each accepted size typed", () => {
      const requests = startLoadSettingFields()

      fireEvent.change(getBatchSizeBox(), { target: { value: "1024" } })

      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { evalBatchSize: 1024 }]
      ])
    })

    it.each(["0", "8193", "1.5", ""])(
      "keeps %j in the box as invalid, says what to enter, and asks for nothing",
      (typed) => {
        const requests = startLoadSettingFields()

        fireEvent.change(getBatchSizeBox(), { target: { value: typed } })

        expect(getBatchSizeBox()).toHaveAttribute("aria-invalid", "true")
        expect(getBatchSizeBox()).toHaveAccessibleDescription(
          "Enter a whole number from 1 to 8,192."
        )
        expect(requests.onAssignModelLoadSettings).not.toHaveBeenCalled()
      }
    )

    it("shows the size again once an accepted size replaces invalid text", () => {
      startLoadSettingFields()

      fireEvent.change(getBatchSizeBox(), { target: { value: "0" } })
      fireEvent.change(getBatchSizeBox(), { target: { value: "256" } })

      expect(getBatchSizeBox()).toHaveAttribute("aria-invalid", "false")
      expect(getBatchSizeBox()).toHaveValue(512)
    })
  })

  describe("flash attention and KV cache", () => {
    it("shows each switch's state and asks for the other state when it is operated", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields({
        configuration: buildConfiguration({ offloadKVCacheToGpu: false })
      })
      const flashAttention = screen.getByRole("switch", {
        name: "Flash attention"
      })
      const kvCache = screen.getByRole("switch", { name: "KV cache on GPU" })
      const statesBefore = [flashAttention, kvCache].map((control) =>
        control.getAttribute("aria-checked")
      )

      await user.click(flashAttention)
      await user.click(kvCache)

      expect(statesBefore).toEqual(["true", "false"])
      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { flashAttention: false }],
        ["qwen3-8b", { offloadKVCacheToGpu: true }]
      ])
    })

    it("repeats each switch's state as text for the eye only", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ offloadKVCacheToGpu: false })
      })

      expect(screen.getByText("On")).toHaveAttribute("aria-hidden", "true")
      expect(screen.getByText("Off")).toHaveAttribute("aria-hidden", "true")
    })

    it.each([
      [
        "Flash attention",
        "Faster attention that uses less memory, on models that support it."
      ],
      [
        "KV cache on GPU",
        "Keeps the context cache in GPU memory. Faster, but it uses VRAM."
      ]
    ])("describes what %s does", (name, note) => {
      startLoadSettingFields()

      expect(screen.getByRole("switch", { name })).toHaveAccessibleDescription(
        note
      )
    })
  })

  describe("active experts", () => {
    /**
     * Gets the two stepper buttons.
     *
     * @returns The step-down and step-up buttons.
     */
    function getStepperButtons() {
      return {
        fewer: screen.getByRole("button", { name: "Fewer experts" }),
        more: screen.getByRole("button", { name: "More experts" })
      }
    }

    it("reads auto while no count is set, with nothing below it, and asks for one expert on a step up", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields()
      const { fewer, more } = getStepperButtons()

      await user.click(more)

      expect(
        screen.getByRole("status", { name: "Active experts" })
      ).toHaveTextContent(/^Auto$/)
      expect(fewer).toBeDisabled()
      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { numExperts: 1 }]
      ])
    })

    it("asks for one expert fewer or more than the current count", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields({
        configuration: buildConfiguration({ numExperts: 3 })
      })
      const { fewer, more } = getStepperButtons()

      await user.click(fewer)
      await user.click(more)

      expect(
        screen.getByRole("status", { name: "Active experts" })
      ).toHaveTextContent(/^3$/)
      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { numExperts: 2 }],
        ["qwen3-8b", { numExperts: 4 }]
      ])
      expect(requests.onRemoveModelExpertCount).not.toHaveBeenCalled()
    })

    it("asks to remove the model's own count on a step down from one expert, when that leaves the count to the model", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields({
        configuration: buildConfiguration({ numExperts: 1 })
      })

      await user.click(getStepperButtons().fewer)

      expect(requests.onRemoveModelExpertCount.mock.calls).toEqual([
        ["qwen3-8b"]
      ])
      expect(requests.onAssignModelLoadSettings).not.toHaveBeenCalled()
    })

    it("offers no step below one expert when removing the count would apply a default's count instead", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ numExperts: 1 }),
        isAutomaticExpertCountAvailable: false
      })

      expect(getStepperButtons().fewer).toBeDisabled()
    })

    it("still steps down from two experts when no automatic count is available", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields({
        configuration: buildConfiguration({ numExperts: 2 }),
        isAutomaticExpertCountAvailable: false
      })

      await user.click(getStepperButtons().fewer)

      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { numExperts: 1 }]
      ])
    })

    it("offers no step above the largest count a load setting accepts", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({
          numExperts: MAXIMUM_MODEL_LOAD_SETTING_VALUE
        })
      })

      expect(getStepperButtons().more).toBeDisabled()
      expect(getStepperButtons().fewer).toBeEnabled()
    })
  })
})
