import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { LlmModelReference } from "@lys/share"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerModelMenu from "@/components/ComposerComponents/ComposerModelMenu"
import {
  listComposerModelGroups,
  type ComposerModelGroup
} from "@/components/ComposerComponents/composer-presentation"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type { ModelInventoryState } from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  buildComposerRuntime,
  type ProviderModelArrangement
} from "../../support/providerModelFixtures"
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
  modelLoading: "provider",
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

/** LM Studio connected with {@link LM_STUDIO_INVENTORY}, the only provider on. */
const LM_STUDIO_READY: ProviderModelArrangement = {
  enabledProviders: ["lmStudio"],
  providers: {
    lmStudio: { status: "connected", inventory: LM_STUDIO_INVENTORY }
  }
}

/** LM Studio and local Ollama connected, both listing `qwen3-8b`. */
const BOTH_READY: ProviderModelArrangement = {
  enabledProviders: ["ollama", "lmStudio"],
  providers: {
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
  }
}

/** What one rendered menu shows. */
type ModelMenuArrangement = {
  /** The providers, their states, and which are on. */
  readonly providers: ProviderModelArrangement
  /** The conversation's model, or null. */
  readonly selectedModel: LlmModelReference | null
  /** Its availability, or null. */
  readonly availability: ModelAvailability | null
  /** Trigger label. */
  readonly label: string
  /** Whether the menu starts open; closed by default. */
  readonly isInitiallyOpen?: boolean
}

/**
 * Builds the menu's groups the way the composer does.
 *
 * @param providers - The providers, their states, and which are on.
 * @returns One group per turned-on provider.
 */
function buildGroups(
  providers: ProviderModelArrangement
): readonly ComposerModelGroup[] {
  return listComposerModelGroups(buildComposerRuntime(providers))
}

/**
 * Renders the menu under a parent that owns its open state, as the composer
 * does, with spies for its requests.
 *
 * @param arrangement - What the menu shows.
 * @returns The spies.
 */
function startModelMenu(arrangement: ModelMenuArrangement) {
  const spies = {
    onSelectModel: vi.fn<(model: LlmModelReference) => void>(),
    onOpenProviders: vi.fn<() => void>(),
    onIsOpenChange: vi.fn<(isOpen: boolean) => void>()
  }
  const groups = buildGroups(arrangement.providers)

  /**
   * Holds the menu's open state as the composer does.
   *
   * @returns The menu.
   */
  function ModelMenuParent() {
    const [isOpen, setIsOpen] = useState(arrangement.isInitiallyOpen ?? false)
    return (
      <ComposerModelMenu
        availability={arrangement.availability}
        groups={groups}
        isOpen={isOpen}
        label={arrangement.label}
        onIsOpenChange={(proposedIsOpen) => {
          spies.onIsOpenChange(proposedIsOpen)
          setIsOpen(proposedIsOpen)
        }}
        onOpenProviders={spies.onOpenProviders}
        onSelectModel={spies.onSelectModel}
        selectedModel={arrangement.selectedModel}
      />
    )
  }

  render(<ModelMenuParent />)
  return spies
}

/**
 * Opens the menu from its trigger with the keyboard.
 *
 * @param user - User-event session of the case.
 * @param label - Trigger's label.
 */
async function openModelMenu(
  user: ReturnType<typeof userEvent.setup>,
  label: string
): Promise<void> {
  await openMenuWithKeyboard(user, screen.getByRole("button", { name: label }))
}

describe("ComposerModelMenu", () => {
  it("names the model answering the conversation on its trigger", () => {
    startModelMenu({
      providers: LM_STUDIO_READY,
      selectedModel: QWEN_MODEL,
      availability: { status: "loading" },
      label: "qwen3-8b · LM Studio · loading"
    })

    expect(
      screen.getByRole("button", { name: "qwen3-8b · LM Studio · loading" })
    ).toHaveAttribute("aria-haspopup", "menu")
  })

  it("lists every model with its provider and its condition in words, checking the selected one", async () => {
    const user = userEvent.setup()
    startModelMenu({
      providers: LM_STUDIO_READY,
      selectedModel: QWEN_MODEL,
      availability: QWEN_LOADED,
      label: "qwen3-8b · LM Studio"
    })

    await openModelMenu(user, "qwen3-8b · LM Studio")

    const options = screen.getAllByRole("menuitemradio")
    expect(options.map((option) => option.textContent)).toEqual([
      "qwen3-8b · LM Studio7B · Q4_K_M · 4.0 GBresident",
      "gemma-3 · LM Studio7B · Q4_K_M · 4.0 GB4.0 GB on disk"
    ])
    expect(
      options.map((option) => option.getAttribute("aria-checked"))
    ).toEqual(["true", "false"])
  })

  it("groups the models under each turned-on provider's name in provider order, the same key once per provider, and none of a provider that is off", async () => {
    const user = userEvent.setup()
    startModelMenu({
      providers: BOTH_READY,
      selectedModel: QWEN_MODEL,
      availability: QWEN_LOADED,
      label: "qwen3-8b · LM Studio"
    })

    await openModelMenu(user, "qwen3-8b · LM Studio")

    const menu = screen.getByRole("menu")
    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => [
          group.querySelector("[data-slot='dropdown-menu-label']")?.textContent,
          within(group)
            .getAllByRole("menuitemradio")
            .map((option) => [
              option.querySelector(".composer__model-option-name")?.textContent,
              option.getAttribute("aria-checked")
            ])
        ])
    ).toEqual([
      [
        "LM Studio",
        [
          ["qwen3-8b · LM Studio", "true"],
          ["gemma-3 · LM Studio", "false"]
        ]
      ],
      ["Ollama", [["qwen3-8b · Ollama", "false"]]]
    ])
    expect(
      within(menu).getByRole("group", { name: "LM Studio" })
    ).toContainElement(
      screen.getByRole("menuitemradio", { name: /^gemma-3 · LM Studio/ })
    )
  })

  it("tags a selected model that is not loaded as selected", async () => {
    const user = userEvent.setup()
    startModelMenu({
      providers: LM_STUDIO_READY,
      selectedModel: { provider: "lmStudio", modelKey: "gemma-3" },
      availability: {
        status: "not-loaded",
        modelLoading: "lys",
        model: buildLlmInfo("gemma-3")
      },
      label: "gemma-3 · LM Studio"
    })

    await openModelMenu(user, "gemma-3 · LM Studio")

    expect(
      screen.getByRole("menuitemradio", { name: /^gemma-3/, checked: true })
    ).toHaveTextContent(/selected$/)
  })

  it("hands over the provider and key of the model the user picks", async () => {
    const user = userEvent.setup()
    const spies = startModelMenu({
      providers: BOTH_READY,
      selectedModel: QWEN_MODEL,
      availability: QWEN_LOADED,
      label: "qwen3-8b · LM Studio"
    })
    await openModelMenu(user, "qwen3-8b · LM Studio")

    await user.click(
      screen.getByRole("menuitemradio", { name: /^qwen3-8b · Ollama/ })
    )

    expect(spies.onSelectModel).toHaveBeenCalledExactlyOnceWith({
      provider: "ollama",
      modelKey: "qwen3-8b"
    })
  })

  it("says why a turned-on provider lists no model, in its group, instead of its models", async () => {
    const user = userEvent.setup()
    startModelMenu({
      providers: {
        enabledProviders: ["lmStudio", "ollama", "groq"],
        providers: {
          lmStudio: { status: "connected", inventory: LM_STUDIO_INVENTORY },
          ollama: { status: "unreachable" },
          groq: { status: "connecting" }
        }
      },
      selectedModel: QWEN_MODEL,
      availability: QWEN_LOADED,
      label: "qwen3-8b · LM Studio"
    })

    await openModelMenu(user, "qwen3-8b · LM Studio")

    const ollama = screen.getByRole("group", { name: "Ollama" })
    expect(within(ollama).queryByRole("menuitemradio")).toBeNull()
    expect(within(ollama).getByRole("menuitem")).toHaveTextContent(
      "Ollama can't be reached on 192.168.1.20:11434."
    )
    expect(within(ollama).getByRole("menuitem")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(
      within(screen.getByRole("group", { name: "Groq" })).getByRole("menuitem")
    ).toHaveTextContent("Connecting to Groq…")
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2)
  })

  it("says no provider is on and opens Providers, closing the menu", async () => {
    const user = userEvent.setup()
    const spies = startModelMenu({
      providers: { enabledProviders: [] },
      selectedModel: null,
      availability: null,
      label: "no model selected"
    })
    await openModelMenu(user, "no model selected")

    expect(
      screen.getByRole("group", { name: "No provider is on" })
    ).toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: "Open Providers" }))

    expect(spies.onOpenProviders).toHaveBeenCalledOnce()
    expect(spies.onIsOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("opens when the parent opens it", () => {
    startModelMenu({
      providers: LM_STUDIO_READY,
      selectedModel: QWEN_MODEL,
      availability: QWEN_LOADED,
      label: "qwen3-8b · LM Studio",
      isInitiallyOpen: true
    })

    expect(screen.getByRole("menu")).toBeInTheDocument()
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2)
  })
})
