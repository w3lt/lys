import { describe, expect, it } from "vitest"
import { buildModelDescriptor } from "@/lib/models/inventory"
import {
  findEligibleChatModel,
  formatComposerModelRowTag,
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  formatModelRowTag,
  readLoadedModelKey,
  readModelResidencyTone,
  readModelRowTone
} from "@/lib/models/model-residency"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Row for weights that are resident according to the inventory. */
const RESIDENT_ROW = buildModelDescriptor(
  buildLlmInfo("resident", { loaded: true })
)

/** Row for weights that are only on disk. */
const ON_DISK_ROW = buildModelDescriptor(buildLlmInfo("on-disk"))

/** Residency summaries that name no model. */
const NONE: ModelRuntimeState = { status: "none" }
const UNKNOWN: ModelRuntimeState = { status: "unknown" }

describe("readLoadedModelKey", () => {
  it("names the loaded model", () => {
    expect(readLoadedModelKey({ status: "loaded", modelKey: "qwen" })).toBe(
      "qwen"
    )
  })

  it.each<ModelRuntimeState>([
    NONE,
    UNKNOWN,
    { status: "loading", modelKey: "qwen" },
    { status: "unloading", modelKey: "qwen" }
  ])("names no model while the summary is $status", (modelRuntime) => {
    expect(readLoadedModelKey(modelRuntime)).toBeNull()
  })
})

describe("findEligibleChatModel", () => {
  it("offers the loaded model while the backend runs", () => {
    expect(
      findEligibleChatModel("running", { status: "loaded", modelKey: "qwen" })
    ).toBe("qwen")
  })

  it.each(["starting", "stopping", "stopped", "unresponsive"] as const)(
    "offers no model while the backend is %s",
    (backendStatus) => {
      expect(
        findEligibleChatModel(backendStatus, {
          status: "loaded",
          modelKey: "qwen"
        })
      ).toBeNull()
    }
  )

  it("offers no model while weights are still loading", () => {
    expect(
      findEligibleChatModel("running", { status: "loading", modelKey: "qwen" })
    ).toBeNull()
  })
})

describe("readModelResidencyTone", () => {
  it.each<[ModelRuntimeState, string]>([
    [{ status: "loaded", modelKey: "qwen" }, "active"],
    [{ status: "loading", modelKey: "qwen" }, "pending"],
    [{ status: "unloading", modelKey: "qwen" }, "pending"],
    [NONE, "idle"],
    [UNKNOWN, "idle"]
  ])("shows %o in the %s tone", (modelRuntime, tone) => {
    expect(readModelResidencyTone(modelRuntime)).toBe(tone)
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
    expect(readModelRowTone(NONE, ON_DISK_ROW)).toBe("idle")
  })

  it("leaves every row idle while residency is unknown", () => {
    expect(readModelRowTone(UNKNOWN, RESIDENT_ROW)).toBe("idle")
  })
})

describe("formatModelResidencyHeading", () => {
  it.each<[ModelRuntimeState, string]>([
    [{ status: "loaded", modelKey: "qwen" }, "Model loaded"],
    [{ status: "loading", modelKey: "qwen" }, "Loading weights"],
    [{ status: "unloading", modelKey: "qwen" }, "Unloading"],
    [NONE, "No model loaded"],
    [UNKNOWN, "Model state unavailable"]
  ])("heads %o with %j", (modelRuntime, heading) => {
    expect(formatModelResidencyHeading(modelRuntime)).toBe(heading)
  })
})

describe("formatModelResidencyMeta", () => {
  it.each<[ModelRuntimeState, string]>([
    [{ status: "loaded", modelKey: "qwen" }, "qwen · loaded in LM Studio"],
    [{ status: "loading", modelKey: "qwen" }, "qwen"],
    [{ status: "unloading", modelKey: "qwen" }, "releasing qwen"],
    [UNKNOWN, "refresh the model inventory to check loaded weights"]
  ])("describes %o as %j", (modelRuntime, meta) => {
    expect(formatModelResidencyMeta(modelRuntime, "available", "qwen")).toBe(
      meta
    )
  })

  it.each([
    ["backend-offline", "qwen", "start the backend first"],
    ["lm-studio-connecting", "qwen", "connecting to LM Studio"],
    ["lm-studio-unreachable", "qwen", "LM Studio is not reachable"],
    ["available", null, "no default model chosen · pick one in Model"],
    ["available", "qwen", "qwen is default · not in memory"]
  ] as const)(
    "explains no resident weights when %s with default %s",
    (availability, defaultModel, meta) => {
      expect(formatModelResidencyMeta(NONE, availability, defaultModel)).toBe(
        meta
      )
    }
  )
})

describe("formatModelRowTag", () => {
  it.each(["loading", "loaded", "unloading"] as const)(
    "tags the row in play as %s",
    (status) => {
      expect(
        formatModelRowTag({ status, modelKey: "on-disk" }, ON_DISK_ROW)
      ).toBe(status)
    }
  )

  it("tags another resident row as loaded", () => {
    expect(
      formatModelRowTag(
        { status: "loading", modelKey: "on-disk" },
        RESIDENT_ROW
      )
    ).toBe("loaded")
  })

  it("tags a row that is only on disk with its size", () => {
    expect(formatModelRowTag(NONE, ON_DISK_ROW)).toBe("4.0 GB on disk")
  })

  it("tags every row as unavailable while residency is unknown", () => {
    expect(formatModelRowTag(UNKNOWN, RESIDENT_ROW)).toBe("state unavailable")
  })
})

describe("formatComposerModelRowTag", () => {
  it("tags the loaded row in play as resident", () => {
    expect(
      formatComposerModelRowTag(
        { status: "loaded", modelKey: "on-disk" },
        ON_DISK_ROW,
        null
      )
    ).toBe("resident")
  })

  it.each(["loading", "unloading"] as const)(
    "tags the row in play as %s",
    (status) => {
      expect(
        formatComposerModelRowTag(
          { status, modelKey: "on-disk" },
          ON_DISK_ROW,
          null
        )
      ).toBe(status)
    }
  )

  it("tags another resident row as resident, even when it is not the selected one", () => {
    expect(formatComposerModelRowTag(NONE, RESIDENT_ROW, "on-disk")).toBe(
      "resident"
    )
  })

  it("tags the selected row that is only on disk as selected", () => {
    expect(formatComposerModelRowTag(NONE, ON_DISK_ROW, "on-disk")).toBe(
      "selected"
    )
  })

  it("tags an unselected row that is only on disk with its size", () => {
    expect(formatComposerModelRowTag(NONE, ON_DISK_ROW, "resident")).toBe(
      "4.0 GB on disk"
    )
  })

  it("tags every row as unavailable while residency is unknown", () => {
    expect(formatComposerModelRowTag(UNKNOWN, ON_DISK_ROW, "on-disk")).toBe(
      "state unavailable"
    )
  })
})
