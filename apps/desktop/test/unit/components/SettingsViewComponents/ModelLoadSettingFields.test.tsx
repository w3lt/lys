import { fireEvent, render, screen, within } from "@testing-library/react"
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
    | "maxContextLength"
    | "configuration"
    | "isAutomaticExpertCountAvailable"
    | "reloadPrompt"
  >
>

/**
 * Renders the load settings of `qwen3-8b`, a model that tops out at 8,192
 * tokens and would be loaded with the committed default, with no reload
 * prompt and an automatic expert count available.
 *
 * @param variation - Properties the case depends on.
 * @returns The recorders of the two requests.
 */
function startLoadSettingFields(variation: FieldsVariation = {}) {
  const requests = {
    onAssignModelLoadSettings: vi.fn(),
    onRemoveModelExpertCount: vi.fn()
  }
  render(
    <ModelLoadSettingFields
      configuration={FIRST_RUN_LOAD_CONFIGURATION}
      isAutomaticExpertCountAvailable
      maxContextLength={8192}
      modelKey="qwen3-8b"
      reloadPrompt={null}
      {...variation}
      {...requests}
    />
  )
  return requests
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
 * Gets the box that takes an exact context length.
 *
 * @returns The text box.
 */
function getContextLengthBox(): HTMLElement {
  return screen.getByRole("textbox", { name: "Context length in tokens" })
}

/**
 * Gets the row of one load setting by its heading.
 *
 * @param title - Heading of the setting.
 * @returns The element holding the setting's heading and loaded value.
 */
function getSettingTitle(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 3, name: title })
  if (heading.parentElement === null) {
    throw new Error(`The ${title} heading has no row`)
  }
  return heading.parentElement
}

describe("ModelLoadSettingFields", () => {
  it("presents the five load settings in the pane's order", () => {
    startLoadSettingFields()

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual([
      "Context length",
      "Eval batch size",
      "Flash attention",
      "KV cache on GPU",
      "Active experts"
    ])
  })

  describe("context length", () => {
    it("shows the length at its stop among the model's stops, announced in tokens, and names the model's maximum", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ contextLength: 4096 })
      })

      const slider = getContextLengthSlider()
      expect(slider).toHaveValue("1")
      expect(slider).toHaveAttribute("min", "0")
      expect(slider).toHaveAttribute("max", "2")
      expect(slider.getAttribute("aria-valuetext")).toMatch(/^4\D?096 tokens$/)
      expect(slider).toHaveAccessibleDescription(
        "Tokens the weights can hold at once. qwen3-8b tops out at 8k."
      )
      expect(getContextLengthBox()).toHaveValue("4096")
      expect(screen.getByText("max 8k")).toBeInTheDocument()
    })

    it("shows a length between two stops at the lower one", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ contextLength: 5000 })
      })

      expect(getContextLengthSlider()).toHaveValue("1")
      expect(getContextLengthBox()).toHaveValue("5000")
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
      expect(getContextLengthBox()).toHaveValue("2048")
      expect(screen.getByText("max 2k")).toBeInTheDocument()
    })

    it("offers only the box, and names no maximum, when the runtime reports no usable one", () => {
      startLoadSettingFields({ maxContextLength: 0 })

      expect(
        screen.queryByRole("slider", { hidden: true })
      ).not.toBeInTheDocument()
      expect(screen.queryByText(/^max\b/)).not.toBeInTheDocument()
      expect(getContextLengthBox()).toHaveAccessibleDescription(
        "Tokens the weights can hold at once."
      )
    })

    it.each([
      ["a value within the range", "6000", 6000],
      ["a value above the model's maximum", "99999", 8192],
      ["a value below 512 tokens", "100", 512]
    ])("asks for %s typed and entered as %s", async (_label, typed, tokens) => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields({
        configuration: buildConfiguration({ contextLength: 4096 })
      })
      const box = getContextLengthBox()

      await user.clear(box)
      await user.type(box, `${typed}{Enter}`)

      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { contextLength: tokens }]
      ])
    })

    it("keeps only the digits of what is typed, and no more than the largest setting has", async () => {
      const user = userEvent.setup()
      startLoadSettingFields()
      const box = getContextLengthBox()

      await user.clear(box)
      await user.type(box, "4k 0-9.6e")
      const digitsOnly = box.getAttribute("value")
      await user.type(box, "12345678901")

      expect(digitsOnly).toBe("4096")
      expect(box).toHaveValue("4096123456")
      expect(String(MAXIMUM_MODEL_LOAD_SETTING_VALUE)).toHaveLength(10)
    })

    it("asks for the typed value when the box is left", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields()
      const box = getContextLengthBox()

      await user.clear(box)
      await user.type(box, "3000")
      await user.tab()

      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { contextLength: 3000 }]
      ])
    })

    it("drops the typed value on Escape and shows the current length again", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields()
      const box = getContextLengthBox()

      await user.clear(box)
      await user.type(box, "3000{Escape}")
      await user.tab()

      expect(box).toHaveValue("8192")
      expect(requests.onAssignModelLoadSettings).not.toHaveBeenCalled()
    })

    it.each([
      ["nothing", ""],
      ["zero", "0"],
      ["the current length", "8192"]
    ])(
      "asks for nothing when %s is entered, and shows the current length again",
      async (_label, typed) => {
        const user = userEvent.setup()
        const requests = startLoadSettingFields()
        const box = getContextLengthBox()

        await user.clear(box)
        await user.type(box, `${typed}{Enter}`)

        expect(box).toHaveValue("8192")
        expect(requests.onAssignModelLoadSettings).not.toHaveBeenCalled()
      }
    )

    it("asks once for a value entered and then left", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields()
      const box = getContextLengthBox()

      await user.clear(box)
      await user.type(box, "3000{Enter}")
      await user.tab()

      expect(requests.onAssignModelLoadSettings).toHaveBeenCalledOnce()
    })
  })

  describe("eval batch size", () => {
    /**
     * Lists the offered batch sizes with whether each is pressed.
     *
     * @returns Each choice's text and `aria-pressed`, in order.
     */
    function listBatchSizeChoices(): [string | null, string | null][] {
      return within(screen.getByRole("group", { name: "Eval batch size" }))
        .getAllByRole("button")
        .map((choice) => [
          choice.textContent,
          choice.getAttribute("aria-pressed")
        ])
    }

    it("offers five sizes in ascending order and presses the current one", () => {
      startLoadSettingFields()

      expect(listBatchSizeChoices()).toEqual([
        ["128", "false"],
        ["256", "false"],
        ["512", "true"],
        ["1024", "false"],
        ["2048", "false"]
      ])
      expect(screen.queryByText(/^custom/)).not.toBeInTheDocument()
    })

    it("asks for the size the user presses, and for nothing when the pressed size is pressed again", async () => {
      const user = userEvent.setup()
      const requests = startLoadSettingFields()
      const group = screen.getByRole("group", { name: "Eval batch size" })

      await user.click(within(group).getByRole("button", { name: "1024" }))
      await user.click(within(group).getByRole("button", { name: "512" }))

      expect(requests.onAssignModelLoadSettings.mock.calls).toEqual([
        ["qwen3-8b", { evalBatchSize: 1024 }]
      ])
    })

    it("shows a stored size that is not offered as custom text and presses no choice", () => {
      startLoadSettingFields({
        configuration: buildConfiguration({ evalBatchSize: 300 })
      })

      expect(screen.getByText("custom · 300")).toBeInTheDocument()
      expect(listBatchSizeChoices().map(([, isPressed]) => isPressed)).toEqual([
        "false",
        "false",
        "false",
        "false",
        "false"
      ])
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

      expect(screen.getByText("on")).toHaveAttribute("aria-hidden", "true")
      expect(screen.getByText("off")).toHaveAttribute("aria-hidden", "true")
    })

    it.each([
      ["in GPU memory", true, /sits in GPU memory\. Off moves it to RAM/],
      ["in RAM", false, /^In RAM\. GPU memory goes to the weights instead/]
    ])(
      "describes what the placement costs while the KV cache is %s",
      (_label, offloadKVCacheToGpu, note) => {
        startLoadSettingFields({
          configuration: buildConfiguration({ offloadKVCacheToGpu })
        })

        expect(
          screen.getByRole("switch", { name: "KV cache on GPU" })
        ).toHaveAccessibleDescription(note)
      }
    )
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
      ).toHaveTextContent(/^auto$/)
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

  describe("a loaded model whose stored settings changed", () => {
    it("shows beside each changed setting the value the model was loaded with, in words", () => {
      startLoadSettingFields({
        reloadPrompt: {
          note: "loaded with ctx 4k, kv cache in ram · reload to apply ctx 8k, kv cache on gpu",
          differences: [
            {
              setting: "contextLength",
              loadedValue: "4k",
              loadedPhrase: "ctx 4k",
              storedPhrase: "ctx 8k"
            },
            {
              setting: "offloadKVCacheToGpu",
              loadedValue: "off",
              loadedPhrase: "kv cache in ram",
              storedPhrase: "kv cache on gpu"
            }
          ]
        }
      })

      expect(getSettingTitle("Context length")).toHaveTextContent("loaded · 4k")
      expect(getSettingTitle("KV cache on GPU")).toHaveTextContent(
        "loaded · off"
      )
      expect(screen.getAllByText(/^loaded · /)).toHaveLength(2)
    })

    it("shows no loaded value without a reload prompt", () => {
      startLoadSettingFields()

      expect(screen.queryByText(/^loaded · /)).not.toBeInTheDocument()
    })
  })
})
