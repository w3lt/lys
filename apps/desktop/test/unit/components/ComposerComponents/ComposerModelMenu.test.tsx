import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { LlmModelReference, LlmProvider } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type {
  ModelInventoryState,
  ProviderModelStates
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"
import { buildProviderModelStates } from "../../support/providerModelFixtures"
import { openMenuWithKeyboard } from "../../support/rendering"

/** LM Studio inventory with one resident model and one on disk. */
const LM_STUDIO_INVENTORY: ModelInventoryState = {
  status: "ready",
  modelLoading: "lys",
  models: [buildLlmInfo("qwen3-8b", { loaded: true }), buildLlmInfo("gemma-3")]
}

/** Local Ollama inventory that lists a key LM Studio lists too. */
const OLLAMA_INVENTORY: ModelInventoryState = {
  status: "ready",
  modelLoading: "lys",
  models: [buildLlmInfo("qwen3-8b")]
}

/** LM Studio's resident model. */
const QWEN_MODEL: LlmModelReference = Object.freeze({
  provider: "lmStudio",
  modelKey: "qwen3-8b"
})

/** Availability of {@link QWEN_MODEL}, which is loaded. */
const QWEN_LOADED: ModelAvailability = {
  status: "loaded",
  model: buildLlmInfo("qwen3-8b", { loaded: true })
}

/** LM Studio connected with {@link LM_STUDIO_INVENTORY}. */
const LM_STUDIO_READY = buildProviderModelStates({
  lmStudio: { status: "connected", inventory: LM_STUDIO_INVENTORY }
})

/**
 * Loads a fresh application store holding the providers' states, and the
 * menu that reads them.
 *
 * @param providerModels - Every provider's state the store holds.
 * @param enabledProviders - Providers the settings turn on; LM Studio only
 * by default.
 * @returns The menu component.
 */
async function loadFreshModelMenu(
  providerModels: ProviderModelStates,
  enabledProviders: readonly LlmProvider[] = ["lmStudio"]
) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { default: ComposerModelMenu } =
    await import("@/components/ComposerComponents/ComposerModelMenu")
  const { settings } = useLysStore.getState()
  useLysStore.setState({
    providerModels,
    settings: {
      ...settings,
      providers: { ...settings.providers, enabled: enabledProviders }
    }
  })
  return ComposerModelMenu
}

describe("ComposerModelMenu", () => {
  it("names the model answering the conversation on its trigger", async () => {
    const ComposerModelMenu = await loadFreshModelMenu(LM_STUDIO_READY)

    render(
      <ComposerModelMenu
        availability={{ status: "loading" }}
        label="qwen3-8b · LM Studio · loading"
        onSelectModel={vi.fn()}
        selectedModel={QWEN_MODEL}
      />
    )

    expect(
      screen.getByRole("button", { name: "qwen3-8b · LM Studio · loading" })
    ).toHaveAttribute("aria-haspopup", "menu")
  })

  it("lists every model with its provider and its condition in words, checking the selected one", async () => {
    const ComposerModelMenu = await loadFreshModelMenu(LM_STUDIO_READY)
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        availability={QWEN_LOADED}
        label="qwen3-8b · LM Studio"
        onSelectModel={vi.fn()}
        selectedModel={QWEN_MODEL}
      />
    )

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "qwen3-8b · LM Studio" })
    )

    const options = screen.getAllByRole("menuitemradio")
    expect(options.map((option) => option.textContent)).toEqual([
      "qwen3-8b · LM Studio7B · Q4_K_M · 4.0 GBresident",
      "gemma-3 · LM Studio7B · Q4_K_M · 4.0 GB4.0 GB on disk"
    ])
    expect(
      options.map((option) => option.getAttribute("aria-checked"))
    ).toEqual(["true", "false"])
  })

  it("lists every turned-on provider's models in provider order, one row for the same key on each provider, and none of a provider that is off", async () => {
    const providerModels = buildProviderModelStates({
      lmStudio: { status: "connected", inventory: LM_STUDIO_INVENTORY },
      ollama: { status: "connected", inventory: OLLAMA_INVENTORY },
      groq: {
        status: "connected",
        inventory: {
          status: "ready",
          modelLoading: "provider",
          models: [buildLlmInfo("llama-3.3-70b", { loaded: true })]
        }
      }
    })
    const ComposerModelMenu = await loadFreshModelMenu(providerModels, [
      "ollama",
      "lmStudio"
    ])
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        availability={QWEN_LOADED}
        label="qwen3-8b · LM Studio"
        onSelectModel={vi.fn()}
        selectedModel={QWEN_MODEL}
      />
    )

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "qwen3-8b · LM Studio" })
    )

    const options = screen.getAllByRole("menuitemradio")
    expect(
      options.map((option) => [
        option.querySelector(".composer__model-option-name")?.textContent,
        option.getAttribute("aria-checked")
      ])
    ).toEqual([
      ["qwen3-8b · LM Studio", "true"],
      ["gemma-3 · LM Studio", "false"],
      ["qwen3-8b · Ollama", "false"]
    ])
  })

  it("tags a selected model that is not loaded as selected", async () => {
    const ComposerModelMenu = await loadFreshModelMenu(LM_STUDIO_READY)
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        availability={{
          status: "not-loaded",
          modelLoading: "lys",
          model: buildLlmInfo("gemma-3")
        }}
        label="gemma-3 · LM Studio"
        onSelectModel={vi.fn()}
        selectedModel={{ provider: "lmStudio", modelKey: "gemma-3" }}
      />
    )

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "gemma-3 · LM Studio" })
    )

    expect(
      screen.getByRole("menuitemradio", { name: /^gemma-3/, checked: true })
    ).toHaveTextContent(/selected$/)
  })

  it("hands over the provider and key of the model the user picks", async () => {
    const onSelectModel = vi.fn()
    const providerModels = buildProviderModelStates({
      lmStudio: { status: "connected", inventory: LM_STUDIO_INVENTORY },
      ollama: { status: "connected", inventory: OLLAMA_INVENTORY }
    })
    const ComposerModelMenu = await loadFreshModelMenu(providerModels, [
      "lmStudio",
      "ollama"
    ])
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        availability={QWEN_LOADED}
        label="qwen3-8b · LM Studio"
        onSelectModel={onSelectModel}
        selectedModel={QWEN_MODEL}
      />
    )
    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "qwen3-8b · LM Studio" })
    )

    await user.click(
      screen.getByRole("menuitemradio", { name: /^qwen3-8b · Ollama/ })
    )

    expect(onSelectModel).toHaveBeenCalledOnce()
    expect(onSelectModel.mock.calls[0]?.[0]).toEqual({
      provider: "ollama",
      modelKey: "qwen3-8b"
    })
  })

  it.each<ModelInventoryState>([
    { status: "unavailable" },
    { status: "failed" }
  ])(
    "points to Model settings without an inventory (%o)",
    async (modelInventory) => {
      const ComposerModelMenu = await loadFreshModelMenu(
        buildProviderModelStates({ lmStudio: { inventory: modelInventory } })
      )
      const user = userEvent.setup()
      render(
        <ComposerModelMenu
          availability={null}
          label="no model selected"
          onSelectModel={vi.fn()}
          selectedModel={null}
        />
      )

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "no model selected" })
      )

      expect(
        screen.getByText("No model inventory · open Model settings")
      ).toBeInTheDocument()
      expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument()
    }
  )
})
