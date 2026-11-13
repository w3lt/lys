import type { LlmModelReference } from "@lys/share"
import { describe, expect, it } from "vitest"
import { buildModelDescriptor } from "@/lib/models/inventory"
import type { ModelAvailability } from "@/lib/models/model-availability"
import {
  formatComposerModelRowTag,
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  formatModelRowTag,
  readModelResidencyTone,
  readModelRowTone
} from "@/lib/models/model-residency"
import type { ModelRequestState } from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Row for weights that are resident according to the inventory. */
const RESIDENT_ROW = buildModelDescriptor(
  buildLlmInfo("resident", { loaded: true })
)

/** Row for weights that are only on disk. */
const ON_DISK_ROW = buildModelDescriptor(buildLlmInfo("on-disk"))

/** No request in flight. */
const IDLE: ModelRequestState = { status: "idle" }

/** The model a case shows: `qwen` of LM Studio. */
const QWEN: LlmModelReference = { provider: "lmStudio", modelKey: "qwen" }

/** Inventory entry of {@link QWEN} while it is loaded. */
const LOADED_QWEN = buildLlmInfo("qwen", { loaded: true })

/** Inventory entry of {@link QWEN} while it is on disk only. */
const ON_DISK_QWEN = buildLlmInfo("qwen")

/** Every availability whose model is neither loaded nor in a transition. */
const UNAVAILABLE_STATES: readonly ModelAvailability[] = [
  { status: "backend-not-running" },
  { status: "provider-off" },
  { status: "provider-connecting" },
  { status: "provider-unreachable" },
  { status: "inventory-unread" },
  { status: "inventory-failed" },
  { status: "not-listed" },
  { status: "not-loaded", modelLoading: "lys", model: ON_DISK_QWEN }
]

describe("readModelResidencyTone", () => {
  it.each<[ModelAvailability | null, string]>([
    [{ status: "loaded", model: LOADED_QWEN }, "active"],
    [{ status: "loading" }, "pending"],
    [{ status: "unloading" }, "pending"],
    [null, "idle"],
    ...UNAVAILABLE_STATES.map((availability): [ModelAvailability, string] => [
      availability,
      "idle"
    ])
  ])("shows %o in the %s tone", (availability, tone) => {
    expect(readModelResidencyTone(availability)).toBe(tone)
  })
})

describe("readModelRowTone", () => {
  it("shows the row in play in the transition's tone", () => {
    expect(
      readModelRowTone({ status: "loading", modelKey: "on-disk" }, ON_DISK_ROW)
    ).toBe("pending")
  })

  it("keeps another resident row active while a different model loads", () => {
    expect(
      readModelRowTone({ status: "loading", modelKey: "on-disk" }, RESIDENT_ROW)
    ).toBe("active")
  })

  it("leaves a row that is only on disk idle", () => {
    expect(readModelRowTone(IDLE, ON_DISK_ROW)).toBe("idle")
  })

  it("keeps a resident row active while the inventory is refreshed", () => {
    expect(readModelRowTone({ status: "listing" }, RESIDENT_ROW)).toBe("active")
  })
})

describe("formatModelResidencyHeading", () => {
  it.each<[ModelAvailability | null, string]>([
    [{ status: "loaded", model: LOADED_QWEN }, "Model loaded"],
    [{ status: "loading" }, "Loading weights"],
    [{ status: "unloading" }, "Unloading"],
    [
      { status: "not-loaded", modelLoading: "lys", model: ON_DISK_QWEN },
      "No model loaded"
    ],
    [null, "No model loaded"],
    [{ status: "not-listed" }, "Model not listed"],
    [{ status: "backend-not-running" }, "Model state unavailable"],
    [{ status: "provider-off" }, "Model state unavailable"],
    [{ status: "provider-connecting" }, "Model state unavailable"],
    [{ status: "provider-unreachable" }, "Model state unavailable"],
    [{ status: "inventory-unread" }, "Model state unavailable"],
    [{ status: "inventory-failed" }, "Model state unavailable"]
  ])("heads %o with %j", (availability, heading) => {
    expect(formatModelResidencyHeading(availability)).toBe(heading)
  })
})

describe("formatModelResidencyMeta", () => {
  it.each<[ModelAvailability, string]>([
    [{ status: "loaded", model: LOADED_QWEN }, "qwen · loaded in LM Studio"],
    [{ status: "loading" }, "qwen"],
    [{ status: "unloading" }, "releasing qwen"],
    [{ status: "backend-not-running" }, "start the backend first"],
    [{ status: "provider-off" }, "LM Studio is off · turn it on in Providers"],
    [{ status: "provider-connecting" }, "connecting to LM Studio"],
    [{ status: "provider-unreachable" }, "LM Studio is not reachable"],
    [
      { status: "inventory-unread" },
      "refresh the model inventory to check loaded weights"
    ],
    [
      { status: "inventory-failed" },
      "refresh the model inventory to check loaded weights"
    ],
    [{ status: "not-listed" }, "qwen is not listed by LM Studio"],
    [
      { status: "not-loaded", modelLoading: "lys", model: ON_DISK_QWEN },
      "qwen is default · not in memory"
    ]
  ])("describes %o as %j", (availability, meta) => {
    expect(formatModelResidencyMeta(QWEN, availability)).toBe(meta)
  })

  it("names the provider holding the weights", () => {
    expect(
      formatModelResidencyMeta(
        { provider: "groq", modelKey: "qwen" },
        { status: "loaded", model: LOADED_QWEN }
      )
    ).toBe("qwen · loaded in Groq")
  })

  it("asks for a model to be chosen while there is none", () => {
    expect(formatModelResidencyMeta(null, null)).toBe(
      "no default model chosen · pick one in Model"
    )
  })
})

describe("formatModelRowTag", () => {
  it.each(["loading", "unloading"] as const)(
    "tags the row in play as %s",
    (status) => {
      expect(
        formatModelRowTag({ status, modelKey: "on-disk" }, ON_DISK_ROW)
      ).toBe(status)
    }
  )

  it("tags a resident row as loaded, also while another model loads", () => {
    expect(formatModelRowTag(IDLE, RESIDENT_ROW)).toBe("loaded")
    expect(
      formatModelRowTag(
        { status: "loading", modelKey: "on-disk" },
        RESIDENT_ROW
      )
    ).toBe("loaded")
  })

  it("tags a row that is only on disk with its size", () => {
    expect(formatModelRowTag(IDLE, ON_DISK_ROW)).toBe("4.0 GB on disk")
  })
})

describe("formatComposerModelRowTag", () => {
  it.each(["loading", "unloading"] as const)(
    "tags the row in play as %s",
    (status) => {
      expect(
        formatComposerModelRowTag(
          { status, modelKey: "on-disk" },
          ON_DISK_ROW,
          false
        )
      ).toBe(status)
    }
  )

  it("tags a resident row as resident, even when it is not the selected one", () => {
    expect(formatComposerModelRowTag(IDLE, RESIDENT_ROW, false)).toBe(
      "resident"
    )
  })

  it("tags the selected row that is only on disk as selected", () => {
    expect(formatComposerModelRowTag(IDLE, ON_DISK_ROW, true)).toBe("selected")
  })

  it("tags an unselected row that is only on disk with its size", () => {
    expect(formatComposerModelRowTag(IDLE, ON_DISK_ROW, false)).toBe(
      "4.0 GB on disk"
    )
  })
})
