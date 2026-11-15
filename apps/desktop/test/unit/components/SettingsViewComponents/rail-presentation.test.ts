import type { LlmModelReference } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildLysEmailRailMarker,
  buildMcpRailMarker,
  formatRailStatus,
  type RailStatusFacts
} from "@/components/SettingsViewComponents/rail-presentation"
import {
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  buildMcpServerStatus
} from "../../support/mcpFixtures"
import { buildLlmInfo } from "../../support/modelFixtures"

/** The model a new conversation uses in these cases. */
const QWEN: LlmModelReference = Object.freeze({
  provider: "lmStudio",
  modelKey: "qwen3-8b"
})

/** A running backend and a connected provider with the model loaded. */
const LOADED: RailStatusFacts = {
  backendStatus: "running",
  shownModel: {
    model: QWEN,
    availability: { status: "loaded", model: buildLlmInfo("qwen3-8b") }
  },
  shownProvider: "lmStudio",
  providerAvailability: "available"
}

/** Facts that differ from {@link LOADED}, and the dot's tone they make. */
type RailToneCase = {
  /** Names the case. */
  readonly label: string
  /** The facts that differ. */
  readonly facts: Partial<RailStatusFacts>
  /** The expected tone. */
  readonly tone: string
}

describe("formatRailStatus", () => {
  it.each<RailToneCase>([
    { label: "a loaded model", facts: {}, tone: "success" },
    {
      label: "no model",
      facts: {
        shownModel: {
          model: QWEN,
          availability: {
            status: "not-loaded",
            modelLoading: "lys",
            model: buildLlmInfo("qwen3-8b")
          }
        }
      },
      tone: "neutral"
    },
    {
      label: "loading weights",
      facts: {
        shownModel: { model: QWEN, availability: { status: "loading" } }
      },
      tone: "pending"
    },
    {
      label: "an unreachable provider",
      facts: {
        shownModel: {
          model: QWEN,
          availability: { status: "provider-unreachable" }
        }
      },
      tone: "danger"
    },
    {
      label: "a starting backend",
      facts: { backendStatus: "starting" },
      tone: "pending"
    },
    {
      label: "an unresponsive backend",
      facts: { backendStatus: "unresponsive" },
      tone: "danger"
    }
  ])("colors $label's dot $tone", ({ facts, tone }) => {
    expect(formatRailStatus({ ...LOADED, ...facts }).tone).toBe(tone)
  })

  it("names the provider the panes show while no model is chosen", () => {
    expect(
      formatRailStatus({
        ...LOADED,
        shownModel: { model: null, availability: null },
        shownProvider: "ollama",
        providerAvailability: "provider-connecting"
      })
    ).toEqual({ text: "backend up · connecting to Ollama", tone: "pending" })
  })
})

describe("buildMcpRailMarker", () => {
  it("marks the MCP entry with a danger dot while a server failed, and nothing otherwise", () => {
    const files = buildMcpServerStatus(
      "files",
      "stdio",
      buildConnectedMcpState(2)
    )
    const notes = buildMcpServerStatus(
      "notes",
      "http",
      buildFailedMcpState("closed")
    )

    expect(buildMcpRailMarker({ status: "loading" })).toBeNull()
    expect(
      buildMcpRailMarker({ status: "loaded", ...buildMcpServerList([files]) })
    ).toBeNull()
    expect(
      buildMcpRailMarker({
        status: "loaded",
        ...buildMcpServerList([files, notes])
      })
    ).toEqual({
      kind: "dot",
      tone: "danger",
      label: "a server needs attention"
    })
  })
})

describe("buildLysEmailRailMarker", () => {
  it("says Lys's mailbox is not set up, or names its connection beside its dot", () => {
    expect(buildLysEmailRailMarker("not-set-up")).toEqual({
      kind: "text",
      label: "Not set up"
    })
    expect(buildLysEmailRailMarker("connected")).toEqual({
      kind: "dot",
      tone: "success",
      label: "connected"
    })
    expect(buildLysEmailRailMarker("needs-attention")).toEqual({
      kind: "dot",
      tone: "danger",
      label: "needs attention"
    })
  })
})
