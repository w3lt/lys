import { CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateComposerActivity,
  calculateLocalRuntimeConnection,
  formatComposerActivity,
  formatComposerModelLabel,
  formatComposerPlaceholder,
  formatReconnectAction,
  formatUnavailableRuntimeMessage
} from "@/components/ComposerComponents/composer-presentation"
import { LM_STUDIO_ADDRESS } from "@/lib/models/lm-studio-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { ConversationAgent } from "@/lib/store/agents/conversation-agent"
import type { ChatRequestState } from "@/lib/store/chat-view"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

/** Backend origin named in the banner copy. */
const BACKEND_ADDRESS = "http://127.0.0.1:12345"

/** Weights resident in LM Studio. */
const LOADED: ModelRuntimeState = { status: "loaded", modelKey: "qwen3-8b" }

/** Inventory read with nothing loaded. */
const NONE: ModelRuntimeState = { status: "none" }

/** Inventory that could not be read. */
const UNKNOWN: ModelRuntimeState = { status: "unknown" }

/** Inventory that cannot be read yet, as while LM Studio is not connected. */
const UNAVAILABLE: ModelRuntimeState = { status: "unavailable" }

/** Weights being loaded. */
const LOADING: ModelRuntimeState = { status: "loading", modelKey: "qwen3-8b" }

/** Weights being released. */
const UNLOADING: ModelRuntimeState = {
  status: "unloading",
  modelKey: "qwen3-8b"
}

/** Backend states in which the process does not answer requests. */
const NOT_RUNNING: readonly BackendServerStatus[] = [
  "stopped",
  "starting",
  "stopping",
  "unresponsive"
]

/** Request phases, each with the token the store would give it. */
const REQUEST_PHASES: Readonly<
  Record<ChatRequestState["status"], ChatRequestState>
> = {
  idle: { status: "idle" },
  "awaiting-turn": { status: "awaiting-turn", token: 1 },
  "reply-streaming": {
    status: "reply-streaming",
    token: 1,
    assistantMessageId: "reply"
  },
  "reply-completed": {
    status: "reply-completed",
    token: 1,
    assistantMessageId: "reply"
  }
}

/** No stored conversation is being opened. */
const NOT_OPENING = { status: "idle" } as const

/** A stored conversation is being opened. */
const OPENING = {
  status: "opening",
  conversationId: "conversation",
  replacedComposerDraft: ""
} as const

/** Lysiptera as the read agent list lists her. */
const LYSIPTERA: ConversationAgent = {
  status: "listed",
  agent: {
    code: LYSIPTERA_AGENT_CODE,
    name: "Lysiptera",
    bio: "Lys's light side.",
    kind: "built-in"
  }
}

/** Caliginia while the agent list is unread, known only by her code. */
const UNREAD_AGENT: ConversationAgent = {
  status: "unread",
  code: CALIGINIA_AGENT_CODE
}

/** A stored agent the read agent list no longer holds. */
const DELETED_AGENT: ConversationAgent = {
  status: "deleted",
  code: "web-researcher"
}

describe("calculateLocalRuntimeConnection", () => {
  it.each(NOT_RUNNING)(
    "is offline while the backend is %s, whatever LM Studio reports",
    (backendStatus) => {
      expect(
        calculateLocalRuntimeConnection(backendStatus, "connected", LOADED)
      ).toBe("offline")
    }
  )

  it.each<LmStudioStatus>(["unknown", "connecting", "unreachable"])(
    "waits on LM Studio while it is %s",
    (lmStudioStatus) => {
      expect(
        calculateLocalRuntimeConnection("running", lmStudioStatus, LOADED)
      ).toBe("provider-unavailable")
    }
  )

  it.each([NONE, UNKNOWN, LOADING, UNLOADING])(
    "has no model while the weights are %o",
    (modelRuntime) => {
      expect(
        calculateLocalRuntimeConnection("running", "connected", modelRuntime)
      ).toBe("no-model")
    }
  )

  it("is ready once LM Studio is connected and weights are loaded", () => {
    expect(
      calculateLocalRuntimeConnection("running", "connected", LOADED)
    ).toBe("ready")
  })
})

describe("formatUnavailableRuntimeMessage", () => {
  it.each<[BackendServerStatus, string]>([
    ["starting", `Starting the backend on ${BACKEND_ADDRESS}…`],
    ["stopping", "Stopping the backend…"],
    ["stopped", `The backend is not running on ${BACKEND_ADDRESS}.`],
    ["unresponsive", `The backend is not responding on ${BACKEND_ADDRESS}.`]
  ])("names the %s backend first", (backendStatus, message) => {
    expect(
      formatUnavailableRuntimeMessage({
        backendStatus,
        backendAddress: BACKEND_ADDRESS,
        lmStudioStatus: "unreachable",
        modelRuntime: UNAVAILABLE
      })
    ).toBe(message)
  })

  it.each<[LmStudioStatus, string]>([
    ["unreachable", `LM Studio is not reachable on ${LM_STUDIO_ADDRESS}.`],
    ["connecting", `Connecting to LM Studio on ${LM_STUDIO_ADDRESS}…`],
    ["unknown", `Connecting to LM Studio on ${LM_STUDIO_ADDRESS}…`]
  ])(
    "names LM Studio when it is %s while the backend runs",
    (lmStudioStatus, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          backendStatus: "running",
          backendAddress: BACKEND_ADDRESS,
          lmStudioStatus,
          modelRuntime: UNAVAILABLE
        })
      ).toBe(message)
    }
  )

  it.each<[ModelRuntimeState, string]>([
    [UNKNOWN, "The backend is up, but model state is unavailable."],
    [UNAVAILABLE, "The backend is up, but model state is unavailable."],
    [LOADING, "Loading model weights…"],
    [UNLOADING, "Unloading model weights…"],
    [NONE, "The backend is up, but no model is loaded."]
  ])(
    "names the weights once LM Studio is connected: %o",
    (modelRuntime, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          backendStatus: "running",
          backendAddress: BACKEND_ADDRESS,
          lmStudioStatus: "connected",
          modelRuntime
        })
      ).toBe(message)
    }
  )
})

describe("formatReconnectAction", () => {
  it.each<[BackendServerStatus, LmStudioStatus, ModelRuntimeState, string]>([
    ["stopped", "unknown", UNAVAILABLE, "Start backend"],
    ["unresponsive", "unknown", UNAVAILABLE, "Check backend"],
    ["running", "unreachable", UNAVAILABLE, "Check LM Studio"],
    ["running", "connected", UNKNOWN, "Check models"],
    ["running", "connected", UNAVAILABLE, "Check models"],
    ["running", "connected", NONE, "Load model"]
  ])(
    "offers %s/%s/%o recovery as %s",
    (backendStatus, lmStudioStatus, modelRuntime, label) => {
      expect(
        formatReconnectAction(backendStatus, lmStudioStatus, modelRuntime)
      ).toEqual({ label, isEnabled: true })
    }
  )

  it.each<[BackendServerStatus, LmStudioStatus, ModelRuntimeState]>([
    ["starting", "unknown", UNAVAILABLE],
    ["stopping", "connected", LOADED],
    ["running", "connecting", UNAVAILABLE],
    ["running", "unknown", UNAVAILABLE],
    ["running", "connected", LOADING],
    ["running", "connected", UNLOADING]
  ])(
    "offers no action while %s/%s/%o is already changing",
    (backendStatus, lmStudioStatus, modelRuntime) => {
      expect(
        formatReconnectAction(backendStatus, lmStudioStatus, modelRuntime)
      ).toEqual({ label: "Working", isEnabled: false })
    }
  )
})

describe("calculateComposerActivity", () => {
  it.each<[ChatRequestState["status"], string]>([
    ["idle", "idle"],
    ["awaiting-turn", "awaiting-reply"],
    ["reply-streaming", "awaiting-reply"],
    ["reply-completed", "idle"]
  ])(
    "treats the %s request as %s, since a title may follow a final reply",
    (phase, activity) => {
      expect(
        calculateComposerActivity(REQUEST_PHASES[phase], NOT_OPENING)
      ).toBe(activity)
    }
  )

  it("reports opening while a stored conversation is read, in every request phase", () => {
    for (const request of Object.values(REQUEST_PHASES)) {
      expect(calculateComposerActivity(request, OPENING)).toBe(
        "opening-conversation"
      )
    }
  })
})

describe("formatComposerPlaceholder", () => {
  it.each([
    ["offline", "idle", "Waiting on the backend…"],
    ["provider-unavailable", "idle", "Waiting on LM Studio…"],
    ["no-model", "idle", "Waiting on LM Studio…"],
    ["ready", "idle", "Say something to Lysiptera"],
    [
      "ready",
      "awaiting-reply",
      "Keep typing — Send unlocks when the reply ends."
    ],
    ["ready", "opening-conversation", "Opening a past conversation…"]
  ] as const)(
    "reads %s/%s with a listed agent as %j",
    (connection, activity, placeholder) => {
      expect(formatComposerPlaceholder(connection, activity, LYSIPTERA)).toBe(
        placeholder
      )
    }
  )

  it("invites the agent by its code while the agent list is unread", () => {
    expect(formatComposerPlaceholder("ready", "idle", UNREAD_AGENT)).toBe(
      "Say something to caliginia"
    )
  })

  it("says a conversation whose agent was deleted is read-only", () => {
    expect(formatComposerPlaceholder("ready", "idle", DELETED_AGENT)).toBe(
      "This conversation is read-only."
    )
  })

  it.each([
    ["offline", "Waiting on the backend…"],
    ["provider-unavailable", "Waiting on LM Studio…"],
    ["no-model", "Waiting on LM Studio…"]
  ] as const)(
    "names what it waits on while %s, before a deleted agent",
    (connection, placeholder) => {
      expect(formatComposerPlaceholder(connection, "idle", DELETED_AGENT)).toBe(
        placeholder
      )
    }
  )
})

describe("formatComposerActivity", () => {
  it.each([
    ["idle", ""],
    ["awaiting-reply", "Generating…"],
    ["opening-conversation", "Opening…"]
  ] as const)("shows %s as %j", (activity, label) => {
    expect(formatComposerActivity(activity)).toBe(label)
  })
})

describe("formatComposerModelLabel", () => {
  it.each<[BackendServerStatus, string]>([
    ["starting", "starting backend…"],
    ["stopping", "stopping…"],
    ["stopped", "backend stopped"],
    ["unresponsive", "backend not responding"]
  ])("names the %s backend instead of weights", (backendStatus, label) => {
    expect(formatComposerModelLabel(backendStatus, LOADED, "qwen3-8b")).toBe(
      label
    )
  })

  it.each<[ModelRuntimeState, string]>([
    [LOADING, "qwen3-8b · loading"],
    [UNLOADING, "qwen3-8b · releasing"],
    [UNKNOWN, "model state unavailable"]
  ])(
    "names the weights and their transition in words: %o",
    (modelRuntime, label) => {
      expect(formatComposerModelLabel("running", modelRuntime, "other")).toBe(
        label
      )
    }
  )

  it("names the loaded weights rather than a different chosen default", () => {
    expect(formatComposerModelLabel("running", LOADED, "gemma-3")).toBe(
      "qwen3-8b"
    )
  })

  it("names the chosen default while nothing is loaded, or says none is chosen", () => {
    expect(formatComposerModelLabel("running", NONE, "gemma-3")).toBe("gemma-3")
    expect(formatComposerModelLabel("running", NONE, null)).toBe(
      "no model selected"
    )
  })

  it("keeps naming the chosen default while the inventory cannot be read yet", () => {
    expect(formatComposerModelLabel("running", UNAVAILABLE, "gemma-3")).toBe(
      "gemma-3"
    )
    expect(formatComposerModelLabel("running", UNAVAILABLE, null)).toBe(
      "no model selected"
    )
  })
})
