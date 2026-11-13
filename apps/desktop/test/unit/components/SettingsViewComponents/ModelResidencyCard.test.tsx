import type { LlmInfo } from "@lys/protocol"
import type { LlmModelReference } from "@lys/share"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ModelResidencyCard from "@/components/SettingsViewComponents/ModelResidencyCard"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type {
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** What the card shows and whether its commands can be sent. */
type ModelResidencyArrangement = {
  readonly isProviderAvailable: boolean
  readonly model: LlmModelReference | null
  readonly availability: ModelAvailability | null
  readonly modelInventory: ModelInventoryState
  readonly modelRequest: ModelRequestState
}

/** Callbacks of one rendered card, as spies. */
type ModelResidencyCardSpies = {
  readonly onLoadModel: (model: LlmModelReference) => void
  readonly onUnloadModel: (model: LlmModelReference) => void
}

/** Key of the model a new conversation uses. */
const DEFAULT_KEY = "qwen3-8b"

/** The model a new conversation uses, on LM Studio. */
const DEFAULT_MODEL: LlmModelReference = Object.freeze({
  provider: "lmStudio",
  modelKey: DEFAULT_KEY
})

/** Text the cases pass as the request feedback. */
const REQUEST_FEEDBACK = "Request feedback"

/** No model request in flight. */
const IDLE_REQUEST: ModelRequestState = Object.freeze({ status: "idle" })

/** A refresh of the model inventory in flight. */
const LISTING_REQUEST: ModelRequestState = Object.freeze({ status: "listing" })

/** The default model on disk only. */
const DEFAULT_ON_DISK: LlmInfo = buildLlmInfo(DEFAULT_KEY)

/** The default model in memory. */
const DEFAULT_IN_MEMORY: LlmInfo = buildLlmInfo(DEFAULT_KEY, { loaded: true })

/** Another model, on disk only. */
const OTHER_ON_DISK: LlmInfo = buildLlmInfo("gemma-3-4b")

/** Read inventory with the default model on disk. */
const DEFAULT_LISTED: ModelInventoryState = Object.freeze({
  status: "ready",
  modelLoading: "lys",
  models: Object.freeze([DEFAULT_ON_DISK, OTHER_ON_DISK])
})

/** Read inventory with the default model in memory. */
const DEFAULT_LISTED_RESIDENT: ModelInventoryState = Object.freeze({
  status: "ready",
  modelLoading: "lys",
  models: Object.freeze([DEFAULT_IN_MEMORY, OTHER_ON_DISK])
})

/** Read inventory with the default in memory in a provider that loads its own models. */
const PROVIDER_LOADED_RESIDENT: ModelInventoryState = Object.freeze({
  status: "ready",
  modelLoading: "provider",
  models: Object.freeze([DEFAULT_IN_MEMORY])
})

/** Inventory that cannot be read yet. */
const INVENTORY_UNAVAILABLE: ModelInventoryState = Object.freeze({
  status: "unavailable"
})

/** Inventory whose read failed. */
const INVENTORY_FAILED: ModelInventoryState = Object.freeze({
  status: "failed"
})

/** The default is listed and Lys can load it. */
const NOT_LOADED: ModelAvailability = Object.freeze({
  status: "not-loaded",
  modelLoading: "lys",
  model: DEFAULT_ON_DISK
})

/** The default is loaded. */
const LOADED: ModelAvailability = Object.freeze({
  status: "loaded",
  model: DEFAULT_IN_MEMORY
})

/** LM Studio connected, the default on disk, no request. */
const READY_TO_LOAD: ModelResidencyArrangement = Object.freeze({
  isProviderAvailable: true,
  model: DEFAULT_MODEL,
  availability: NOT_LOADED,
  modelInventory: DEFAULT_LISTED,
  modelRequest: IDLE_REQUEST
})

/** LM Studio connected, the default in memory, no request. */
const READY_TO_UNLOAD: ModelResidencyArrangement = Object.freeze({
  isProviderAvailable: true,
  model: DEFAULT_MODEL,
  availability: LOADED,
  modelInventory: DEFAULT_LISTED_RESIDENT,
  modelRequest: IDLE_REQUEST
})

/** No default chosen and nothing loaded. */
const NO_MODEL: ModelResidencyArrangement = Object.freeze({
  ...READY_TO_LOAD,
  model: null,
  availability: null
})

/**
 * Renders the card with spies for its callbacks and a stand-in for the
 * request feedback.
 *
 * @param arrangement - What the card shows.
 * @returns The spies and the render result's rerender function.
 */
function startModelResidencyCard(arrangement: ModelResidencyArrangement) {
  const spies: ModelResidencyCardSpies = {
    onLoadModel: vi.fn(),
    onUnloadModel: vi.fn()
  }
  const { rerender } = render(
    <ModelResidencyCard
      isProviderAvailable={arrangement.isProviderAvailable}
      model={arrangement.model}
      availability={arrangement.availability}
      modelInventory={arrangement.modelInventory}
      modelRequest={arrangement.modelRequest}
      {...spies}
    >
      <p>{REQUEST_FEEDBACK}</p>
    </ModelResidencyCard>
  )
  return { spies, rerender }
}

/**
 * Gets the card the cases render.
 *
 * @returns The card's section.
 */
function getCard(): HTMLElement {
  const card = screen.getByText(REQUEST_FEEDBACK).closest("section")
  if (card === null) throw new Error("The card renders a section")
  return card
}

describe("ModelResidencyCard", () => {
  it.each<{
    availability: ModelAvailability
    heading: string
    meta: string
  }>([
    {
      availability: NOT_LOADED,
      heading: "No model loaded",
      meta: `${DEFAULT_KEY} is default · not in memory`
    },
    {
      availability: LOADED,
      heading: "Model loaded",
      meta: `${DEFAULT_KEY} · loaded in LM Studio`
    },
    {
      availability: { status: "loading" },
      heading: "Loading weights",
      meta: DEFAULT_KEY
    },
    {
      availability: { status: "unloading" },
      heading: "Unloading",
      meta: `releasing ${DEFAULT_KEY}`
    },
    {
      availability: { status: "not-listed" },
      heading: "Model not listed",
      meta: `${DEFAULT_KEY} is not listed by LM Studio`
    },
    {
      availability: { status: "inventory-failed" },
      heading: "Model state unavailable",
      meta: "refresh the model inventory to check loaded weights"
    },
    {
      availability: { status: "inventory-unread" },
      heading: "Model state unavailable",
      meta: "refresh the model inventory to check loaded weights"
    }
  ])(
    "shows the $availability.status model as $heading",
    ({ availability, heading, meta }) => {
      startModelResidencyCard({ ...READY_TO_LOAD, availability })

      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument()
      expect(screen.getByText(meta)).toBeInTheDocument()
    }
  )

  it.each<{
    availability: ModelAvailability
    meta: string
  }>([
    {
      availability: { status: "backend-not-running" },
      meta: "start the backend first"
    },
    {
      availability: { status: "provider-off" },
      meta: "LM Studio is off · turn it on in Providers"
    },
    {
      availability: { status: "provider-connecting" },
      meta: "connecting to LM Studio"
    },
    {
      availability: { status: "provider-unreachable" },
      meta: "LM Studio is not reachable"
    }
  ])(
    "says why the model's state is unavailable, recedes, and offers no command while $availability.status",
    ({ availability, meta }) => {
      startModelResidencyCard({
        ...READY_TO_LOAD,
        isProviderAvailable: false,
        availability,
        modelInventory: INVENTORY_UNAVAILABLE
      })

      expect(
        screen.getByRole("heading", { name: "Model state unavailable" })
      ).toBeInTheDocument()
      expect(screen.getByText(meta)).toBeInTheDocument()
      expect(getCard()).toHaveAttribute("data-dimmed")
      expect(screen.queryByRole("button", { name: "Load" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Unload" })).toBeNull()
    }
  )

  it("does not recede while the provider can be reached", () => {
    startModelResidencyCard(READY_TO_LOAD)

    expect(getCard()).not.toHaveAttribute("data-dimmed")
  })

  it.each([
    {
      name: "the default is listed and not loaded",
      arrangement: READY_TO_LOAD,
      canLoad: true,
      canUnload: false
    },
    {
      name: "the default is loaded",
      arrangement: READY_TO_UNLOAD,
      canLoad: false,
      canUnload: true
    },
    {
      name: "a model request is in flight",
      arrangement: { ...READY_TO_UNLOAD, modelRequest: LISTING_REQUEST },
      canLoad: false,
      canUnload: false
    },
    {
      name: "there is no model",
      arrangement: NO_MODEL,
      canLoad: false,
      canUnload: false
    },
    {
      name: "the default is not listed",
      arrangement: {
        ...READY_TO_LOAD,
        availability: { status: "not-listed" } as const
      },
      canLoad: false,
      canUnload: false
    }
  ])(
    "offers Load and Unload only when they apply: $name",
    ({ arrangement, canLoad, canUnload }) => {
      startModelResidencyCard(arrangement)

      expect(screen.getByRole("button", { name: "Load" })).toHaveProperty(
        "disabled",
        !canLoad
      )
      expect(screen.getByRole("button", { name: "Unload" })).toHaveProperty(
        "disabled",
        !canUnload
      )
    }
  )

  it("says to pick a default when there is none, and names no model", () => {
    startModelResidencyCard(NO_MODEL)

    expect(
      screen.getByRole("heading", { name: "No model loaded" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("no default model chosen · pick one in Model")
    ).toBeInTheDocument()
    expect(getCard()).not.toHaveTextContent(" · LM Studio")
    expect(
      screen.getByText(
        "This summary shows the model a new conversation uses; see every model in Model settings."
      )
    ).toBeInTheDocument()
  })

  it.each<{ model: LlmModelReference; label: string }>([
    { model: DEFAULT_MODEL, label: `${DEFAULT_KEY} · LM Studio` },
    {
      model: { provider: "groq", modelKey: "llama-3.3-70b" },
      label: "llama-3.3-70b · Groq"
    }
  ])("names the model with its provider as $label", ({ model, label }) => {
    startModelResidencyCard({ ...READY_TO_LOAD, model })

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it("asks to load the default once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startModelResidencyCard(READY_TO_LOAD)

    await user.click(screen.getByRole("button", { name: "Load" }))

    expect(spies.onLoadModel).toHaveBeenCalledExactlyOnceWith(DEFAULT_MODEL)
    expect(spies.onUnloadModel).not.toHaveBeenCalled()
  })

  it("asks to unload the loaded model once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startModelResidencyCard(READY_TO_UNLOAD)

    await user.click(screen.getByRole("button", { name: "Unload" }))

    expect(spies.onUnloadModel).toHaveBeenCalledExactlyOnceWith(DEFAULT_MODEL)
    expect(spies.onLoadModel).not.toHaveBeenCalled()
  })

  it.each([
    {
      availability: { status: "loading" } as const,
      progress: "Loading weights"
    },
    { availability: { status: "unloading" } as const, progress: "Unloading" }
  ])(
    "marks the card busy and shows indeterminate progress while $availability.status",
    ({ availability, progress }) => {
      startModelResidencyCard({ ...READY_TO_LOAD, availability })

      const progressbar = screen.getByRole("progressbar", { name: progress })
      const busyParts = document.querySelectorAll('[aria-busy="true"]')
      expect(busyParts).toHaveLength(1)
      expect(busyParts[0]).toContainElement(progressbar)
      expect(progressbar).not.toHaveAttribute("value")
    }
  )

  it("clears the busy state and the progress once the weights are loaded", () => {
    const { spies, rerender } = startModelResidencyCard({
      ...READY_TO_LOAD,
      availability: { status: "loading" }
    })

    rerender(
      <ModelResidencyCard
        isProviderAvailable
        model={DEFAULT_MODEL}
        availability={LOADED}
        modelInventory={DEFAULT_LISTED_RESIDENT}
        modelRequest={IDLE_REQUEST}
        {...spies}
      >
        <p>{REQUEST_FEEDBACK}</p>
      </ModelResidencyCard>
    )

    expect(
      screen.getByRole("heading", { name: "Model loaded" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it("explains where the commands go and shows the request feedback last", () => {
    startModelResidencyCard(READY_TO_LOAD)

    const note = screen.getByText(
      "Loading and unloading use LM Studio through the backend. This summary shows the model a new conversation uses; manage every loaded model in Model settings."
    )
    const feedback = screen.getByText(REQUEST_FEEDBACK)
    expect(
      note.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Unload" })
        .compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it.each([
    {
      name: "the inventory cannot be read yet",
      arrangement: {
        ...READY_TO_LOAD,
        availability: { status: "inventory-unread" } as const,
        modelInventory: INVENTORY_UNAVAILABLE
      }
    },
    {
      name: "the inventory read failed",
      arrangement: {
        ...READY_TO_LOAD,
        availability: { status: "inventory-failed" } as const,
        modelInventory: INVENTORY_FAILED
      }
    }
  ])(
    "offers no Load or Unload, and says nothing about who loads the models, while $name",
    ({ arrangement }) => {
      startModelResidencyCard(arrangement)

      expect(screen.queryByRole("button", { name: "Load" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Unload" })).toBeNull()
      expect(
        screen.getByText(
          "This summary shows the model a new conversation uses; see every model in Model settings."
        )
      ).toBeInTheDocument()
    }
  )

  it("offers Load and Unload when the inventory reports that Lys loads the models, whatever the provider", () => {
    startModelResidencyCard({
      ...READY_TO_UNLOAD,
      model: { provider: "groq", modelKey: DEFAULT_KEY }
    })

    expect(screen.getByRole("button", { name: "Load" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Unload" })).toBeEnabled()
  })

  it("offers no Load or Unload when the inventory reports that the provider loads its own models", () => {
    startModelResidencyCard({
      ...READY_TO_UNLOAD,
      model: { provider: "groq", modelKey: DEFAULT_KEY },
      modelInventory: PROVIDER_LOADED_RESIDENT
    })

    expect(
      screen.getByText(`${DEFAULT_KEY} · loaded in Groq`)
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Unload" })).toBeNull()
    expect(
      screen.getByText(
        "Groq decides which models are in memory, so Lys does not load or unload them. This summary shows the model a new conversation uses; see every model in Model settings."
      )
    ).toBeInTheDocument()
  })
})
