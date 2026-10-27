import type { LlmInfo } from "@lys/protocol"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ModelResidencyCard from "@/components/SettingsViewComponents/ModelResidencyCard"
import type { ModelRuntimeAvailability } from "@/lib/models/lm-studio-connection"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import type {
  ModelInventoryState,
  ModelRequestState,
  ModelRuntimeState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"

/** What the card shows and whether its commands can be sent. */
type ModelResidencyArrangement = {
  readonly availability: ModelRuntimeAvailability
  readonly defaultModel: string | null
  readonly modelInventory: ModelInventoryState
  readonly modelRequest: ModelRequestState
  readonly modelRuntime: ModelRuntimeState
}

/** Callbacks of one rendered card, as spies. */
type ModelResidencyCardSpies = {
  readonly onLoadModel: (modelKey: string) => void
  readonly onUnloadModel: (modelKey: string) => void
}

/** Key of the chosen default model. */
const DEFAULT_MODEL = "qwen3-8b"

/** Key of a listed model that is not the default. */
const OTHER_MODEL = "gemma-3-4b"

/** Text the cases pass as the request feedback. */
const REQUEST_FEEDBACK = "Request feedback"

/** No model request in flight. */
const IDLE_REQUEST: ModelRequestState = Object.freeze({ status: "idle" })

/** A refresh of the model inventory in flight. */
const LISTING_REQUEST: ModelRequestState = Object.freeze({ status: "listing" })

/** Nothing resident in memory. */
const NOTHING_RESIDENT: ModelRuntimeState = Object.freeze({ status: "none" })

/** The default model resident in memory. */
const DEFAULT_RESIDENT: ModelRuntimeState = Object.freeze({
  status: "loaded",
  modelKey: DEFAULT_MODEL
})

/** The default model being loaded. */
const DEFAULT_LOADING: ModelRuntimeState = Object.freeze({
  status: "loading",
  modelKey: DEFAULT_MODEL
})

/** The default model being unloaded. */
const DEFAULT_UNLOADING: ModelRuntimeState = Object.freeze({
  status: "unloading",
  modelKey: DEFAULT_MODEL
})

/** Residency observation failed. */
const RESIDENCY_UNKNOWN: ModelRuntimeState = Object.freeze({
  status: "unknown"
})

/** Residency cannot be read yet. */
const RESIDENCY_UNAVAILABLE: ModelRuntimeState = Object.freeze({
  status: "unavailable"
})

/** The default model on disk only. */
const DEFAULT_ON_DISK: LlmInfo = buildLlmInfo(DEFAULT_MODEL)

/** The default model in memory. */
const DEFAULT_IN_MEMORY: LlmInfo = buildLlmInfo(DEFAULT_MODEL, {
  loaded: true
})

/** Another model, on disk only. */
const OTHER_ON_DISK: LlmInfo = buildLlmInfo(OTHER_MODEL)

/** Inventory listing the default model on disk. */
const DEFAULT_LISTED_MODELS: readonly LlmInfo[] = Object.freeze([
  DEFAULT_ON_DISK,
  OTHER_ON_DISK
])

/** Inventory listing the default model in memory. */
const DEFAULT_RESIDENT_MODELS: readonly LlmInfo[] = Object.freeze([
  DEFAULT_IN_MEMORY,
  OTHER_ON_DISK
])

/** Inventory without the default model. */
const DEFAULT_MISSING_MODELS: readonly LlmInfo[] = Object.freeze([
  OTHER_ON_DISK
])

/** Read inventory with the default model on disk. */
const DEFAULT_LISTED: ModelInventoryState = Object.freeze({
  status: "ready",
  models: DEFAULT_LISTED_MODELS
})

/** Read inventory with the default model in memory. */
const DEFAULT_LISTED_RESIDENT: ModelInventoryState = Object.freeze({
  status: "ready",
  models: DEFAULT_RESIDENT_MODELS
})

/** Read inventory without the default model. */
const DEFAULT_NOT_LISTED: ModelInventoryState = Object.freeze({
  status: "ready",
  models: DEFAULT_MISSING_MODELS
})

/** Inventory that cannot be read yet. */
const INVENTORY_UNAVAILABLE: ModelInventoryState = Object.freeze({
  status: "unavailable"
})

/** Inventory whose read failed. */
const INVENTORY_FAILED: ModelInventoryState = Object.freeze({
  status: "failed"
})

/** LM Studio connected, the default on disk, nothing loaded, no request. */
const READY_TO_LOAD: ModelResidencyArrangement = Object.freeze({
  availability: "available",
  defaultModel: DEFAULT_MODEL,
  modelInventory: DEFAULT_LISTED,
  modelRequest: IDLE_REQUEST,
  modelRuntime: NOTHING_RESIDENT
})

/** LM Studio connected, the default in memory, no request. */
const READY_TO_UNLOAD: ModelResidencyArrangement = Object.freeze({
  availability: "available",
  defaultModel: DEFAULT_MODEL,
  modelInventory: DEFAULT_LISTED_RESIDENT,
  modelRequest: IDLE_REQUEST,
  modelRuntime: DEFAULT_RESIDENT
})

/** The default in memory while an inventory refresh is in flight. */
const LISTING_WHILE_RESIDENT: ModelResidencyArrangement = Object.freeze({
  ...READY_TO_UNLOAD,
  modelRequest: LISTING_REQUEST
})

/** Nothing loaded and no default chosen. */
const NO_DEFAULT_CHOSEN: ModelResidencyArrangement = Object.freeze({
  ...READY_TO_LOAD,
  defaultModel: null
})

/** Nothing loaded and the default not in the inventory. */
const DEFAULT_NOT_IN_INVENTORY: ModelResidencyArrangement = Object.freeze({
  ...READY_TO_LOAD,
  modelInventory: DEFAULT_NOT_LISTED
})

/** Nothing loaded and the inventory not read yet. */
const INVENTORY_NOT_READ: ModelResidencyArrangement = Object.freeze({
  ...READY_TO_LOAD,
  modelInventory: INVENTORY_UNAVAILABLE
})

/** Nothing loaded and the inventory read failed. */
const INVENTORY_READ_FAILED: ModelResidencyArrangement = Object.freeze({
  ...READY_TO_LOAD,
  modelInventory: INVENTORY_FAILED
})

/**
 * Renders the card with spies for its callbacks and a stand-in for the
 * request feedback.
 *
 * @param arrangement - What the card shows.
 * @param provider - Active provider; LM Studio, whose loading Lys manages,
 * when omitted.
 * @returns The spies and the render result's rerender function.
 */
function startModelResidencyCard(
  arrangement: ModelResidencyArrangement,
  provider: LlmProviderTarget = LM_STUDIO_TARGET
) {
  const spies: ModelResidencyCardSpies = {
    onLoadModel: vi.fn(),
    onUnloadModel: vi.fn()
  }
  const { rerender } = render(
    <ModelResidencyCard
      provider={provider}
      availability={arrangement.availability}
      defaultModel={arrangement.defaultModel}
      modelInventory={arrangement.modelInventory}
      modelRequest={arrangement.modelRequest}
      modelRuntime={arrangement.modelRuntime}
      {...spies}
    >
      <p>{REQUEST_FEEDBACK}</p>
    </ModelResidencyCard>
  )
  return { spies, rerender }
}

describe("ModelResidencyCard", () => {
  it.each([
    {
      modelRuntime: NOTHING_RESIDENT,
      heading: "No model loaded",
      meta: `${DEFAULT_MODEL} is default · not in memory`
    },
    {
      modelRuntime: DEFAULT_RESIDENT,
      heading: "Model loaded",
      meta: `${DEFAULT_MODEL} · loaded in LM Studio`
    },
    {
      modelRuntime: DEFAULT_LOADING,
      heading: "Loading weights",
      meta: DEFAULT_MODEL
    },
    {
      modelRuntime: DEFAULT_UNLOADING,
      heading: "Unloading",
      meta: `releasing ${DEFAULT_MODEL}`
    },
    {
      modelRuntime: RESIDENCY_UNKNOWN,
      heading: "Model state unavailable",
      meta: "refresh the model inventory to check loaded weights"
    },
    {
      modelRuntime: RESIDENCY_UNAVAILABLE,
      heading: "Model state unavailable",
      meta: "refresh the model inventory to check loaded weights"
    }
  ])(
    "shows $modelRuntime.status residency as $heading",
    ({ modelRuntime, heading, meta }) => {
      startModelResidencyCard({ ...READY_TO_LOAD, modelRuntime })

      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument()
      expect(screen.getByText(meta)).toBeInTheDocument()
    }
  )

  it.each([
    { availability: "backend-offline", meta: "start the backend first" },
    { availability: "lm-studio-connecting", meta: "connecting to LM Studio" },
    {
      availability: "lm-studio-unreachable",
      meta: "LM Studio is not reachable"
    }
  ] as const)(
    "says why residency is unavailable and offers no command while $availability",
    ({ availability, meta }) => {
      startModelResidencyCard({
        ...READY_TO_LOAD,
        availability,
        modelInventory: INVENTORY_UNAVAILABLE,
        modelRuntime: RESIDENCY_UNAVAILABLE
      })

      expect(
        screen.getByRole("heading", { name: "Model state unavailable" })
      ).toBeInTheDocument()
      expect(screen.getByText(meta)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Load" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Unload" })).toBeDisabled()
    }
  )

  it.each([
    {
      name: "nothing loaded, the default on disk",
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
      arrangement: LISTING_WHILE_RESIDENT,
      canLoad: false,
      canUnload: false
    },
    {
      name: "no default is chosen",
      arrangement: NO_DEFAULT_CHOSEN,
      canLoad: false,
      canUnload: false
    },
    {
      name: "the default is not listed",
      arrangement: DEFAULT_NOT_IN_INVENTORY,
      canLoad: false,
      canUnload: false
    },
    {
      name: "the inventory cannot be read yet",
      arrangement: INVENTORY_NOT_READ,
      canLoad: false,
      canUnload: false
    },
    {
      name: "the inventory read failed",
      arrangement: INVENTORY_READ_FAILED,
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

  it("says to pick a default when none is chosen", () => {
    startModelResidencyCard(NO_DEFAULT_CHOSEN)

    expect(
      screen.getByText("no default model chosen · pick one in Model")
    ).toBeInTheDocument()
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
    { modelRuntime: DEFAULT_LOADING, progress: "Loading weights" },
    { modelRuntime: DEFAULT_UNLOADING, progress: "Unloading" }
  ])(
    "marks the card busy and shows indeterminate progress while $modelRuntime.status",
    ({ modelRuntime, progress }) => {
      startModelResidencyCard({ ...READY_TO_LOAD, modelRuntime })

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
      modelRuntime: DEFAULT_LOADING
    })

    rerender(
      <ModelResidencyCard
        provider={LM_STUDIO_TARGET}
        availability="available"
        defaultModel={DEFAULT_MODEL}
        modelInventory={DEFAULT_LISTED_RESIDENT}
        modelRequest={IDLE_REQUEST}
        modelRuntime={DEFAULT_RESIDENT}
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
      "Loading and unloading use LM Studio through the backend. This summary prefers the loaded default; manage every loaded model in Model settings."
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

  it("offers no Load or Unload for a provider that loads its own models", () => {
    startModelResidencyCard(READY_TO_UNLOAD, GROQ_TARGET)

    expect(
      screen.getByText(`${DEFAULT_MODEL} · loaded in Groq`)
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Unload" })).toBeNull()
    expect(
      screen.getByText(
        "Groq decides which models are in memory, so Lys does not load or unload them. This summary prefers the default; see every model in Model settings."
      )
    ).toBeInTheDocument()
  })
})
