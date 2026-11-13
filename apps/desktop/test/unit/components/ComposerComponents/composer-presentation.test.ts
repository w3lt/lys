import {
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type LlmModelReference
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateComposerActivity,
  calculateLocalRuntimeConnection,
  findReconnectSettingsPane,
  formatComposerActivity,
  formatComposerModelLabel,
  formatComposerModelName,
  formatComposerPlaceholder,
  formatReconnectAction,
  formatUnavailableRuntimeMessage
} from "@/components/ComposerComponents/composer-presentation"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type { BackendServerStatus } from "@/lib/store"
import type { ConversationAgent } from "@/lib/store/agents/conversation-agent"
import type { ChatRequestState } from "@/lib/store/chat-view"
import { buildLlmInfo } from "../../support/modelFixtures"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"

/** Backend origin named in the banner copy. */
const BACKEND_ADDRESS = "http://127.0.0.1:12345"

/** LM Studio's model the cases ask about. */
const QWEN_MODEL: LlmModelReference = Object.freeze({
  provider: "lmStudio",
  modelKey: "qwen3-8b"
})

/** Groq's model the cases ask about. */
const GROQ_MODEL: LlmModelReference = Object.freeze({
  provider: "groq",
  modelKey: "llama-3.3-70b"
})

/** The model is loaded and can answer. */
const LOADED: ModelAvailability = {
  status: "loaded",
  model: buildLlmInfo("qwen3-8b", { loaded: true })
}

/** The provider lists the model and Lys can load it. */
const NOT_LOADED: ModelAvailability = {
  status: "not-loaded",
  modelLoading: "lys",
  model: buildLlmInfo("qwen3-8b")
}

/** The provider lists the model and loads models itself. */
const NOT_LOADED_BY_PROVIDER: ModelAvailability = {
  status: "not-loaded",
  modelLoading: "provider",
  model: buildLlmInfo("llama-3.3-70b")
}

/** The provider's inventory does not list the model. */
const NOT_LISTED: ModelAvailability = { status: "not-listed" }

/** The provider's inventory has not been read yet. */
const INVENTORY_UNREAD: ModelAvailability = { status: "inventory-unread" }

/** The provider's latest inventory read failed. */
const INVENTORY_FAILED: ModelAvailability = { status: "inventory-failed" }

/** Lys is loading the model. */
const LOADING: ModelAvailability = { status: "loading" }

/** Lys is unloading the model. */
const UNLOADING: ModelAvailability = { status: "unloading" }

/** The model's provider is turned off. */
const PROVIDER_OFF: ModelAvailability = { status: "provider-off" }

/** The backend is connecting to the model's provider. */
const PROVIDER_CONNECTING: ModelAvailability = { status: "provider-connecting" }

/** The backend cannot reach the model's provider. */
const PROVIDER_UNREACHABLE: ModelAvailability = {
  status: "provider-unreachable"
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
    "is offline while the backend is %s, whatever the model's state",
    (backendStatus) => {
      expect(calculateLocalRuntimeConnection(backendStatus, LOADED)).toBe(
        "offline"
      )
    }
  )

  it.each([PROVIDER_OFF, PROVIDER_CONNECTING, PROVIDER_UNREACHABLE])(
    "waits on the provider while the model's availability is %o",
    (availability) => {
      expect(calculateLocalRuntimeConnection("running", availability)).toBe(
        "provider-unavailable"
      )
    }
  )

  it.each([
    NOT_LOADED,
    NOT_LISTED,
    INVENTORY_UNREAD,
    INVENTORY_FAILED,
    LOADING,
    UNLOADING,
    null
  ])("has no model while the model's availability is %o", (availability) => {
    expect(calculateLocalRuntimeConnection("running", availability)).toBe(
      "no-model"
    )
  })

  it("is ready only while the conversation's model is loaded", () => {
    expect(calculateLocalRuntimeConnection("running", LOADED)).toBe("ready")
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
        model: QWEN_MODEL,
        availability: { status: "backend-not-running" },
        provider: LM_STUDIO_TARGET
      })
    ).toBe(message)
  })

  it.each<[ModelAvailability, string]>([
    [PROVIDER_OFF, "LM Studio is turned off."],
    [PROVIDER_UNREACHABLE, "LM Studio is not reachable on 127.0.0.1:1234."],
    [PROVIDER_CONNECTING, "Connecting to LM Studio on 127.0.0.1:1234…"]
  ])(
    "names the model's provider and its location while the backend runs: %o",
    (availability, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          backendStatus: "running",
          backendAddress: BACKEND_ADDRESS,
          model: QWEN_MODEL,
          availability,
          provider: LM_STUDIO_TARGET
        })
      ).toBe(message)
    }
  )

  it("names a hosted provider at its host", () => {
    expect(
      formatUnavailableRuntimeMessage({
        backendStatus: "running",
        backendAddress: BACKEND_ADDRESS,
        model: GROQ_MODEL,
        availability: PROVIDER_UNREACHABLE,
        provider: GROQ_TARGET
      })
    ).toBe("Groq is not reachable on api.groq.com.")
  })

  it.each<[ModelAvailability, string]>([
    [INVENTORY_FAILED, "The backend is up, but model state is unavailable."],
    [INVENTORY_UNREAD, "The backend is up, but model state is unavailable."],
    [NOT_LISTED, "LM Studio does not list qwen3-8b."],
    [NOT_LOADED, "qwen3-8b is not loaded in LM Studio."],
    [LOADING, "Loading model weights…"],
    [UNLOADING, "Unloading model weights…"]
  ])(
    "names the model's state once its provider is connected: %o",
    (availability, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          backendStatus: "running",
          backendAddress: BACKEND_ADDRESS,
          model: QWEN_MODEL,
          availability,
          provider: LM_STUDIO_TARGET
        })
      ).toBe(message)
    }
  )

  it("says no model is loaded when there is no model at all", () => {
    expect(
      formatUnavailableRuntimeMessage({
        backendStatus: "running",
        backendAddress: BACKEND_ADDRESS,
        model: null,
        availability: null,
        provider: LM_STUDIO_TARGET
      })
    ).toBe("The backend is up, but no model is loaded.")
  })
})

describe("formatReconnectAction", () => {
  it.each<[BackendServerStatus, ModelAvailability | null, string]>([
    ["stopped", { status: "backend-not-running" }, "Start backend"],
    ["unresponsive", { status: "backend-not-running" }, "Check backend"],
    ["running", PROVIDER_OFF, "Open Providers"],
    ["running", PROVIDER_UNREACHABLE, "Check LM Studio"],
    ["running", INVENTORY_FAILED, "Check models"],
    ["running", INVENTORY_UNREAD, "Check models"],
    ["running", NOT_LISTED, "Choose model"],
    ["running", NOT_LOADED, "Load model"],
    ["running", null, "Choose model"]
  ])("offers %s/%o recovery as %s", (backendStatus, availability, label) => {
    expect(
      formatReconnectAction({
        backendStatus,
        model: availability === null ? null : QWEN_MODEL,
        availability,
        provider: LM_STUDIO_TARGET
      })
    ).toEqual({ label, isEnabled: true })
  })

  it("names the provider to check, and chooses a model when the provider loads its own", () => {
    expect(
      formatReconnectAction({
        backendStatus: "running",
        model: GROQ_MODEL,
        availability: PROVIDER_UNREACHABLE,
        provider: GROQ_TARGET
      })
    ).toEqual({ label: "Check Groq", isEnabled: true })
    expect(
      formatReconnectAction({
        backendStatus: "running",
        model: GROQ_MODEL,
        availability: NOT_LOADED_BY_PROVIDER,
        provider: GROQ_TARGET
      })
    ).toEqual({ label: "Choose model", isEnabled: true })
  })

  it.each<[BackendServerStatus, ModelAvailability]>([
    ["starting", { status: "backend-not-running" }],
    ["stopping", LOADED],
    ["running", PROVIDER_CONNECTING],
    ["running", LOADING],
    ["running", UNLOADING]
  ])(
    "offers no action while %s/%o is already changing",
    (backendStatus, availability) => {
      expect(
        formatReconnectAction({
          backendStatus,
          model: QWEN_MODEL,
          availability,
          provider: LM_STUDIO_TARGET
        })
      ).toEqual({ label: "Working", isEnabled: false })
    }
  )
})

describe("findReconnectSettingsPane", () => {
  it.each<[ModelAvailability | null, string]>([
    [PROVIDER_OFF, "providers"],
    [PROVIDER_CONNECTING, "providers"],
    [PROVIDER_UNREACHABLE, "providers"],
    [{ status: "backend-not-running" }, "runtime"],
    [INVENTORY_FAILED, "model"],
    [NOT_LISTED, "model"],
    [NOT_LOADED, "model"],
    [null, "model"]
  ])("opens the pane that fixes %o: %s", (availability, pane) => {
    expect(findReconnectSettingsPane(availability)).toBe(pane)
  })
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
      expect(
        formatComposerPlaceholder(connection, activity, LYSIPTERA, "LM Studio")
      ).toBe(placeholder)
    }
  )

  it("invites the agent by its code while the agent list is unread", () => {
    expect(
      formatComposerPlaceholder("ready", "idle", UNREAD_AGENT, "LM Studio")
    ).toBe("Say something to caliginia")
  })

  it("says a conversation whose agent was deleted is read-only", () => {
    expect(
      formatComposerPlaceholder("ready", "idle", DELETED_AGENT, "LM Studio")
    ).toBe("This conversation is read-only.")
  })

  it.each([
    ["offline", "Waiting on the backend…"],
    ["provider-unavailable", "Waiting on LM Studio…"],
    ["no-model", "Waiting on LM Studio…"]
  ] as const)(
    "names what it waits on while %s, before a deleted agent",
    (connection, placeholder) => {
      expect(
        formatComposerPlaceholder(
          connection,
          "idle",
          DELETED_AGENT,
          "LM Studio"
        )
      ).toBe(placeholder)
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

describe("formatComposerModelName", () => {
  it("names the model with its provider, so one key on two providers reads as two models", () => {
    expect(formatComposerModelName(QWEN_MODEL)).toBe("qwen3-8b · LM Studio")
    expect(
      formatComposerModelName({ provider: "ollama", modelKey: "qwen3-8b" })
    ).toBe("qwen3-8b · Ollama")
  })
})

describe("formatComposerModelLabel", () => {
  it.each<[BackendServerStatus, string]>([
    ["starting", "starting backend…"],
    ["stopping", "stopping…"],
    ["stopped", "backend stopped"],
    ["unresponsive", "backend not responding"]
  ])("names the %s backend instead of the model", (backendStatus, label) => {
    expect(formatComposerModelLabel(backendStatus, QWEN_MODEL, LOADED)).toBe(
      label
    )
  })

  it.each<[ModelAvailability, string]>([
    [LOADING, "qwen3-8b · LM Studio · loading"],
    [UNLOADING, "qwen3-8b · LM Studio · releasing"]
  ])(
    "names the model and its transition in words: %o",
    (availability, label) => {
      expect(
        formatComposerModelLabel("running", QWEN_MODEL, availability)
      ).toBe(label)
    }
  )

  it.each([
    LOADED,
    NOT_LOADED,
    NOT_LISTED,
    INVENTORY_UNREAD,
    PROVIDER_OFF,
    PROVIDER_UNREACHABLE
  ])(
    "keeps naming the conversation's model whatever else its availability is: %o",
    (availability) => {
      expect(
        formatComposerModelLabel("running", QWEN_MODEL, availability)
      ).toBe("qwen3-8b · LM Studio")
    }
  )

  it("says no model is selected when there is none", () => {
    expect(formatComposerModelLabel("running", null, null)).toBe(
      "no model selected"
    )
  })
})
