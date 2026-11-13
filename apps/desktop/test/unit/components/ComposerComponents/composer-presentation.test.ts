import {
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type LlmModelReference
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateComposerActivity,
  calculateLocalRuntimeConnection,
  findComposerBannerAction,
  formatComposerActivity,
  formatComposerModelLabel,
  formatComposerPlaceholder,
  formatUnavailableRuntimeMessage,
  listComposerModelGroups,
  type ComposerModelState
} from "@/components/ComposerComponents/composer-presentation"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type { BackendServerStatus } from "@/lib/store"
import type { ConversationAgent } from "@/lib/store/agents/conversation-agent"
import type { ChatRequestState } from "@/lib/store/chat-view"
import { buildLlmInfo } from "../../support/modelFixtures"
import { buildModelAvailabilitySource } from "../../support/providerModelFixtures"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"
import { STORED_PROVIDERS_SETTINGS } from "../../support/settingsFixtures"

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

/**
 * Builds the banner's facts for LM Studio's qwen3-8b while the backend runs
 * and a provider is on.
 *
 * @param overrides - Facts the case changes.
 * @returns The model state.
 */
function buildModelState(
  overrides: Partial<ComposerModelState> = {}
): ComposerModelState {
  return {
    backendStatus: "running",
    model: QWEN_MODEL,
    availability: LOADED,
    provider: LM_STUDIO_TARGET,
    hasProviderOn: true,
    ...overrides
  }
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
        ...buildModelState({
          backendStatus,
          availability: { status: "backend-not-running" }
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe(message)
  })

  it.each<[ModelAvailability, string]>([
    [PROVIDER_OFF, "LM Studio is turned off."],
    [PROVIDER_UNREACHABLE, "LM Studio can't be reached on 127.0.0.1:1234."],
    [PROVIDER_CONNECTING, "Connecting to LM Studio…"]
  ])(
    "names the model's provider while the backend runs: %o",
    (availability, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          ...buildModelState({ availability }),
          backendAddress: BACKEND_ADDRESS
        })
      ).toBe(message)
    }
  )

  it("names a hosted provider at its host", () => {
    expect(
      formatUnavailableRuntimeMessage({
        ...buildModelState({
          model: GROQ_MODEL,
          availability: PROVIDER_UNREACHABLE,
          provider: GROQ_TARGET
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("Groq can't be reached on api.groq.com.")
  })

  it.each<[ModelAvailability, string]>([
    [INVENTORY_FAILED, "The backend is up, but model state is unavailable."],
    [INVENTORY_UNREAD, "The backend is up, but model state is unavailable."],
    [NOT_LISTED, "qwen3-8b isn't on LM Studio."],
    [NOT_LOADED, "qwen3-8b isn't loaded in LM Studio."],
    [LOADING, "Loading model weights…"],
    [UNLOADING, "Unloading model weights…"]
  ])(
    "names the model's state once its provider is connected: %o",
    (availability, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          ...buildModelState({ availability }),
          backendAddress: BACKEND_ADDRESS
        })
      ).toBe(message)
    }
  )

  it("says a provider that loads its own models isn't running the model", () => {
    expect(
      formatUnavailableRuntimeMessage({
        ...buildModelState({
          model: GROQ_MODEL,
          availability: NOT_LOADED_BY_PROVIDER,
          provider: GROQ_TARGET
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("Groq isn't running llama-3.3-70b.")
  })

  it("says no model is loaded when there is no model at all", () => {
    expect(
      formatUnavailableRuntimeMessage({
        ...buildModelState({ model: null, availability: null }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("The backend is up, but no model is loaded.")
  })

  it("says no provider is on when none is and there is no model", () => {
    expect(
      formatUnavailableRuntimeMessage({
        ...buildModelState({
          model: null,
          availability: null,
          hasProviderOn: false
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("No provider is on.")
  })
})

describe("findComposerBannerAction", () => {
  it("starts a stopped backend, and opens Runtime for one that does not respond", () => {
    expect(
      findComposerBannerAction(buildModelState({ backendStatus: "stopped" }))
    ).toEqual({ kind: "start-backend", label: "Start backend" })
    expect(
      findComposerBannerAction(
        buildModelState({ backendStatus: "unresponsive" })
      )
    ).toEqual({
      kind: "open-settings",
      label: "Check backend",
      pane: "runtime"
    })
  })

  it.each([PROVIDER_OFF, PROVIDER_UNREACHABLE])(
    "opens Providers while the model's provider is %o",
    (availability) => {
      expect(
        findComposerBannerAction(buildModelState({ availability }))
      ).toEqual({
        kind: "open-settings",
        label: "Open Providers",
        pane: "providers"
      })
    }
  )

  it("opens Providers while no provider is on", () => {
    expect(
      findComposerBannerAction(
        buildModelState({
          model: null,
          availability: null,
          hasProviderOn: false
        })
      )
    ).toEqual({
      kind: "open-settings",
      label: "Open Providers",
      pane: "providers"
    })
  })

  it.each([INVENTORY_UNREAD, INVENTORY_FAILED])(
    "opens Model to check the models while the inventory is %o",
    (availability) => {
      expect(
        findComposerBannerAction(buildModelState({ availability }))
      ).toEqual({ kind: "open-settings", label: "Check models", pane: "model" })
    }
  )

  it.each([
    {
      name: "a model its provider does not list",
      state: { availability: NOT_LISTED }
    },
    {
      name: "a model its provider loads itself and does not run",
      state: {
        model: GROQ_MODEL,
        availability: NOT_LOADED_BY_PROVIDER,
        provider: GROQ_TARGET
      }
    },
    { name: "no model", state: { model: null, availability: null } }
  ])("opens the model menu for $name", ({ state }) => {
    expect(findComposerBannerAction(buildModelState(state))).toEqual({
      kind: "open-model-menu",
      label: "Choose model"
    })
  })

  it("shows a model Lys loads and has not loaded in the Model pane", () => {
    expect(
      findComposerBannerAction(buildModelState({ availability: NOT_LOADED }))
    ).toEqual({ kind: "show-model", label: "Load qwen3-8b", model: QWEN_MODEL })
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
        findComposerBannerAction(
          buildModelState({ backendStatus, availability })
        )
      ).toEqual({ kind: "none", label: "Working" })
    }
  )
})

describe("listComposerModelGroups", () => {
  /** LM Studio's models: one loaded, one on disk. */
  const LM_STUDIO_MODELS = [
    buildLlmInfo("qwen3-8b", { loaded: true }),
    buildLlmInfo("gemma-3")
  ]

  it("groups the models of every turned-on provider in provider order, the same key once per provider", () => {
    const source = buildModelAvailabilitySource({
      enabledProviders: ["ollama", "lmStudio"],
      providers: {
        lmStudio: {
          status: "connected",
          inventory: {
            status: "ready",
            modelLoading: "lys",
            models: LM_STUDIO_MODELS
          }
        },
        ollama: {
          status: "connected",
          inventory: {
            status: "ready",
            modelLoading: "provider",
            models: [buildLlmInfo("qwen3-8b")]
          }
        }
      }
    })

    const groups = listComposerModelGroups(source, STORED_PROVIDERS_SETTINGS)

    expect(
      groups.map((group) => [
        group.provider,
        group.kind === "models"
          ? group.choices.map((choice) => choice.value)
          : group.status
      ])
    ).toEqual([
      ["lmStudio", ["lmStudio/qwen3-8b", "lmStudio/gemma-3"]],
      ["ollama", ["ollama/qwen3-8b"]]
    ])
  })

  it.each<{
    name: string
    status: "unknown" | "connecting" | "unreachable" | "off"
    line: string
  }>([
    { name: "connecting", status: "connecting", line: "Connecting to Ollama…" },
    {
      name: "of unknown status",
      status: "unknown",
      line: "Connecting to Ollama…"
    },
    {
      name: "not reachable",
      status: "unreachable",
      line: "Ollama can't be reached on 192.168.1.20:11434."
    },
    { name: "off at the backend", status: "off", line: "Ollama is turned off." }
  ])(
    "says why a turned-on provider that is $name lists no model",
    ({ status, line }) => {
      const source = buildModelAvailabilitySource({
        enabledProviders: ["ollama"],
        providers: { ollama: { status } }
      })

      expect(
        listComposerModelGroups(source, STORED_PROVIDERS_SETTINGS)
      ).toEqual([{ kind: "status", provider: "ollama", status: line }])
    }
  )

  it.each<{
    name: string
    inventory:
      | { status: "unavailable" }
      | { status: "failed" }
      | { status: "ready"; modelLoading: "lys"; models: [] }
    line: string
  }>([
    {
      name: "is still being read",
      inventory: { status: "unavailable" },
      line: "Reading Groq's models…"
    },
    {
      name: "could not be read",
      inventory: { status: "failed" },
      line: "Lys couldn't read Groq's models."
    },
    {
      name: "lists nothing",
      inventory: { status: "ready", modelLoading: "lys", models: [] },
      line: "Groq lists no model."
    }
  ])(
    "says so while a connected provider's inventory $name",
    ({ inventory, line }) => {
      const source = buildModelAvailabilitySource({
        enabledProviders: ["groq"],
        providers: { groq: { status: "connected", inventory } }
      })

      expect(
        listComposerModelGroups(source, STORED_PROVIDERS_SETTINGS)
      ).toEqual([{ kind: "status", provider: "groq", status: line }])
    }
  )

  it("says the backend isn't running in every group while it is not", () => {
    const source = buildModelAvailabilitySource({
      backendStatus: "stopped",
      enabledProviders: ["lmStudio", "groq"]
    })

    expect(
      listComposerModelGroups(source, STORED_PROVIDERS_SETTINGS).map(
        (group) => group.kind === "status" && group.status
      )
    ).toEqual(["The backend isn't running.", "The backend isn't running."])
  })

  it("lists no group while no provider is on", () => {
    expect(
      listComposerModelGroups(
        buildModelAvailabilitySource({ enabledProviders: [] }),
        STORED_PROVIDERS_SETTINGS
      )
    ).toEqual([])
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
