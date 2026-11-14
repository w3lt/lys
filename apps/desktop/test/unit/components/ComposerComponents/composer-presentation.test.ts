import {
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type LlmModelReference
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildComposerModelState,
  calculateComposerActivity,
  calculateLocalRuntimeConnection,
  findComposerBannerAction,
  formatComposerActivity,
  formatComposerModelLabel,
  formatComposerPlaceholder,
  formatUnavailableRuntimeMessage,
  listComposerModelGroups,
  type ComposerActivity,
  type ComposerModelState,
  type ComposerProviderState
} from "@/components/ComposerComponents/composer-presentation"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type { ProviderReadiness } from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { ConversationAgent } from "@/lib/store/agents/conversation-agent"
import type { ChatRequestState } from "@/lib/store/chat-view"
import type { LlmProviderStatus } from "@/lib/store/model-runtime"
import type { SecretsSettings } from "@/lib/store/settings"
import { buildLlmInfo } from "../../support/modelFixtures"
import { buildComposerRuntime } from "../../support/providerModelFixtures"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"
import { STORED_SETTINGS } from "../../support/settingsFixtures"

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

/** Saved keys without the Groq key the stored ones hold. */
const NO_GROQ_KEY: SecretsSettings = Object.freeze({
  ...STORED_SETTINGS.secrets,
  groqApiKey: null
})

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
 * Names a provider with how ready it is.
 *
 * @param readiness - Whether it can answer.
 * @param target - The provider; LM Studio at its default address when
 * omitted.
 * @returns The provider as the composer names it.
 */
function buildProvider(
  readiness: ProviderReadiness,
  target = LM_STUDIO_TARGET
): ComposerProviderState {
  return { target, readiness }
}

/**
 * Builds the banner's facts for LM Studio's qwen3-8b while the backend runs,
 * LM Studio can answer, and a provider is on.
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
    provider: buildProvider("available"),
    hasProviderOn: true,
    ...overrides
  }
}

/**
 * Builds the facts of a conversation with no model while the backend runs
 * and LM Studio alone is on with a status.
 *
 * @param status - LM Studio's status.
 * @returns The model state the composer builds.
 */
function buildNoModelLmStudioState(
  status: LlmProviderStatus
): ComposerModelState {
  return buildComposerModelState(
    buildComposerRuntime({
      enabledProviders: ["lmStudio"],
      providers: { lmStudio: { status } }
    }),
    { model: null, availability: null }
  )
}

/**
 * Lists what the composer shows for a model state while generation is
 * unavailable.
 *
 * @param state - The model state.
 * @returns The banner sentence, its action's label, and the placeholder.
 */
function describeBanner(state: ComposerModelState) {
  return {
    message: formatUnavailableRuntimeMessage({
      ...state,
      backendAddress: BACKEND_ADDRESS
    }),
    action: findComposerBannerAction(state).label,
    placeholder: formatComposerPlaceholder(state, "idle", LYSIPTERA)
  }
}

describe("buildComposerModelState", () => {
  it("names the model's provider with where it is reached and that it can answer", () => {
    const state = buildComposerModelState(
      buildComposerRuntime({
        enabledProviders: ["lmStudio"],
        providers: { lmStudio: { status: "connected" } }
      }),
      { model: QWEN_MODEL, availability: LOADED }
    )

    expect(state).toEqual({
      backendStatus: "running",
      model: QWEN_MODEL,
      availability: LOADED,
      provider: buildProvider("available"),
      hasProviderOn: true
    })
  })

  it.each<LlmProviderStatus>(["connected", "connecting", "unreachable"])(
    "says a turned-on Groq without a key needs one while its status is %s",
    (status) => {
      const state = buildComposerModelState(
        buildComposerRuntime(
          { enabledProviders: ["groq"], providers: { groq: { status } } },
          NO_GROQ_KEY
        ),
        { model: GROQ_MODEL, availability: PROVIDER_UNREACHABLE }
      )

      expect(state.provider).toEqual(
        buildProvider("provider-needs-key", GROQ_TARGET)
      )
    }
  )

  it("says a Groq the settings leave off is off, though it has no key", () => {
    const state = buildComposerModelState(
      buildComposerRuntime(
        {
          enabledProviders: ["lmStudio"],
          providers: { lmStudio: { status: "connected" } }
        },
        NO_GROQ_KEY
      ),
      { model: GROQ_MODEL, availability: PROVIDER_OFF }
    )

    expect(state.provider).toEqual(buildProvider("provider-off", GROQ_TARGET))
  })

  it("without a model, names the first turned-on provider in provider order while none can answer", () => {
    const state = buildComposerModelState(
      buildComposerRuntime({
        enabledProviders: ["groq", "lmStudio"],
        providers: {
          lmStudio: { status: "unreachable" },
          groq: { status: "connecting" }
        }
      }),
      { model: null, availability: null }
    )

    expect(state.provider).toEqual(buildProvider("provider-unreachable"))
  })

  it("without a model, names no provider while a turned-on one can answer", () => {
    const state = buildComposerModelState(
      buildComposerRuntime({
        enabledProviders: ["lmStudio", "groq"],
        providers: {
          lmStudio: { status: "unreachable" },
          groq: { status: "connected" }
        }
      }),
      { model: null, availability: null }
    )

    expect(state.provider).toBeNull()
    expect(state.hasProviderOn).toBe(true)
  })

  it("without a model or a turned-on provider, names none", () => {
    const state = buildComposerModelState(
      buildComposerRuntime({ enabledProviders: [] }),
      { model: null, availability: null }
    )

    expect(state.provider).toBeNull()
    expect(state.hasProviderOn).toBe(false)
  })
})

describe("calculateLocalRuntimeConnection", () => {
  it.each(NOT_RUNNING)(
    "is offline while the backend is %s, whatever the model's state",
    (backendStatus) => {
      expect(
        calculateLocalRuntimeConnection(buildModelState({ backendStatus }))
      ).toBe("offline")
    }
  )

  it.each<ProviderReadiness>([
    "provider-off",
    "provider-needs-key",
    "provider-connecting",
    "provider-unreachable"
  ])("waits on the provider while it is %s", (readiness) => {
    expect(
      calculateLocalRuntimeConnection(
        buildModelState({ provider: buildProvider(readiness) })
      )
    ).toBe("provider-unavailable")
  })

  it("waits on a provider that needs a key even while its model is loaded", () => {
    expect(
      calculateLocalRuntimeConnection(
        buildModelState({
          model: GROQ_MODEL,
          provider: buildProvider("provider-needs-key", GROQ_TARGET)
        })
      )
    ).toBe("provider-unavailable")
  })

  it.each([
    NOT_LOADED,
    NOT_LISTED,
    INVENTORY_UNREAD,
    INVENTORY_FAILED,
    LOADING,
    UNLOADING
  ])(
    "has no model while the provider can answer and the model is %o",
    (availability) => {
      expect(
        calculateLocalRuntimeConnection(buildModelState({ availability }))
      ).toBe("no-model")
    }
  )

  it("has no model when there is none and no provider is named", () => {
    expect(
      calculateLocalRuntimeConnection(
        buildModelState({ model: null, availability: null, provider: null })
      )
    ).toBe("no-model")
  })

  it("is ready only while the model is loaded and its provider can answer", () => {
    expect(calculateLocalRuntimeConnection(buildModelState())).toBe("ready")
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

  it.each<[ModelAvailability, ProviderReadiness, string]>([
    [PROVIDER_OFF, "provider-off", "LM Studio is turned off."],
    [
      PROVIDER_UNREACHABLE,
      "provider-unreachable",
      "LM Studio can't be reached on 127.0.0.1:1234."
    ],
    [PROVIDER_CONNECTING, "provider-connecting", "Connecting to LM Studio…"]
  ])(
    "names the model's provider while the backend runs: %o",
    (availability, readiness, message) => {
      expect(
        formatUnavailableRuntimeMessage({
          ...buildModelState({
            availability,
            provider: buildProvider(readiness)
          }),
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
          provider: buildProvider("provider-unreachable", GROQ_TARGET)
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("Groq can't be reached on api.groq.com.")
  })

  it("says the model's provider needs a key instead of that it can't be reached", () => {
    expect(
      formatUnavailableRuntimeMessage({
        ...buildModelState({
          model: GROQ_MODEL,
          availability: PROVIDER_UNREACHABLE,
          provider: buildProvider("provider-needs-key", GROQ_TARGET)
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("Groq needs a key.")
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
          provider: buildProvider("available", GROQ_TARGET)
        }),
        backendAddress: BACKEND_ADDRESS
      })
    ).toBe("Groq isn't running llama-3.3-70b.")
  })

  it("says no model is loaded when there is no model and a provider can answer", () => {
    expect(
      formatUnavailableRuntimeMessage({
        ...buildModelState({ model: null, availability: null, provider: null }),
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
          provider: null,
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

  it.each<ProviderReadiness>([
    "provider-off",
    "provider-needs-key",
    "provider-unreachable"
  ])("opens Providers while the model's provider is %s", (readiness) => {
    expect(
      findComposerBannerAction(
        buildModelState({ provider: buildProvider(readiness) })
      )
    ).toEqual({
      kind: "open-settings",
      label: "Open Providers",
      pane: "providers"
    })
  })

  it("opens Providers while no provider is on", () => {
    expect(
      findComposerBannerAction(
        buildModelState({
          model: null,
          availability: null,
          provider: null,
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
    "opens Models to check the models while the inventory is %o",
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
        provider: buildProvider("available", GROQ_TARGET)
      }
    },
    {
      name: "no model while a provider can answer",
      state: { model: null, availability: null, provider: null }
    }
  ])("opens the model menu for $name", ({ state }) => {
    expect(findComposerBannerAction(buildModelState(state))).toEqual({
      kind: "open-model-menu",
      label: "Choose model"
    })
  })

  it("shows a model Lys loads and has not loaded in the Models pane", () => {
    expect(
      findComposerBannerAction(buildModelState({ availability: NOT_LOADED }))
    ).toEqual({ kind: "show-model", label: "Load qwen3-8b", model: QWEN_MODEL })
  })

  it.each<[BackendServerStatus, Partial<ComposerModelState>]>([
    ["starting", { availability: { status: "backend-not-running" } }],
    ["stopping", {}],
    [
      "running",
      {
        availability: PROVIDER_CONNECTING,
        provider: buildProvider("provider-connecting")
      }
    ],
    ["running", { availability: LOADING }],
    ["running", { availability: UNLOADING }]
  ])(
    "offers no action while %s/%o is already changing",
    (backendStatus, overrides) => {
      expect(
        findComposerBannerAction(
          buildModelState({ backendStatus, ...overrides })
        )
      ).toEqual({ kind: "none", label: "Working" })
    }
  )
})

describe("the banner without a model", () => {
  it.each<{
    name: string
    status: LlmProviderStatus
    message: string
    action: string
  }>([
    {
      name: "can't be reached",
      status: "unreachable",
      message: "LM Studio can't be reached on 127.0.0.1:1234.",
      action: "Open Providers"
    },
    {
      name: "is being connected to",
      status: "connecting",
      message: "Connecting to LM Studio…",
      action: "Working"
    },
    {
      name: "has a status not read yet",
      status: "unknown",
      message: "Connecting to LM Studio…",
      action: "Working"
    },
    {
      name: "is off at the backend",
      status: "off",
      message: "LM Studio is turned off.",
      action: "Open Providers"
    }
  ])(
    "explains LM Studio, the only provider on, when it $name, instead of saying no model is loaded",
    ({ status, message, action }) => {
      expect(describeBanner(buildNoModelLmStudioState(status))).toEqual({
        message,
        action,
        placeholder: "Waiting on LM Studio…"
      })
    }
  )

  it("says the only provider on needs a key when it has none", () => {
    const state = buildComposerModelState(
      buildComposerRuntime(
        {
          enabledProviders: ["groq"],
          providers: { groq: { status: "unreachable" } }
        },
        NO_GROQ_KEY
      ),
      { model: null, availability: null }
    )

    expect(describeBanner(state)).toEqual({
      message: "Groq needs a key.",
      action: "Open Providers",
      placeholder: "Waiting on Groq…"
    })
  })

  it("says no model is loaded and offers to choose one while a turned-on provider is connected", () => {
    expect(describeBanner(buildNoModelLmStudioState("connected"))).toEqual({
      message: "The backend is up, but no model is loaded.",
      action: "Choose model",
      placeholder: "Waiting on a model…"
    })
  })
})

describe("the banner for a model whose provider needs a key", () => {
  it("says Groq needs a key, not that it can't be reached, and opens Providers", () => {
    const state = buildComposerModelState(
      buildComposerRuntime(
        {
          enabledProviders: ["groq"],
          providers: { groq: { status: "unreachable" } }
        },
        NO_GROQ_KEY
      ),
      { model: GROQ_MODEL, availability: PROVIDER_UNREACHABLE }
    )

    expect(describeBanner(state)).toEqual({
      message: "Groq needs a key.",
      action: "Open Providers",
      placeholder: "Waiting on Groq…"
    })
  })
})

describe("listComposerModelGroups", () => {
  /** LM Studio's models: one loaded, one on disk. */
  const LM_STUDIO_MODELS = [
    buildLlmInfo("qwen3-8b", { loaded: true }),
    buildLlmInfo("gemma-3")
  ]

  it("groups the models of every turned-on provider in provider order, the same key once per provider", () => {
    const runtime = buildComposerRuntime({
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

    const groups = listComposerModelGroups(runtime)

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
      const runtime = buildComposerRuntime({
        enabledProviders: ["ollama"],
        providers: { ollama: { status } }
      })

      expect(listComposerModelGroups(runtime)).toEqual([
        { kind: "status", provider: "ollama", status: line }
      ])
    }
  )

  it.each<LlmProviderStatus>(["connected", "unreachable"])(
    "says a turned-on provider without its key needs one while its status is %s",
    (status) => {
      const runtime = buildComposerRuntime(
        { enabledProviders: ["groq"], providers: { groq: { status } } },
        NO_GROQ_KEY
      )

      expect(listComposerModelGroups(runtime)).toEqual([
        { kind: "status", provider: "groq", status: "Groq needs a key." }
      ])
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
      const runtime = buildComposerRuntime({
        enabledProviders: ["groq"],
        providers: { groq: { status: "connected", inventory } }
      })

      expect(listComposerModelGroups(runtime)).toEqual([
        { kind: "status", provider: "groq", status: line }
      ])
    }
  )

  it("says the backend isn't running in every group while it is not", () => {
    const runtime = buildComposerRuntime({
      backendStatus: "stopped",
      enabledProviders: ["lmStudio", "groq"]
    })

    expect(
      listComposerModelGroups(runtime).map(
        (group) => group.kind === "status" && group.status
      )
    ).toEqual(["The backend isn't running.", "The backend isn't running."])
  })

  it("lists no group while no provider is on", () => {
    expect(
      listComposerModelGroups(buildComposerRuntime({ enabledProviders: [] }))
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
  it.each<[string, ComposerModelState, ComposerActivity, string]>([
    [
      "offline",
      buildModelState({ backendStatus: "stopped" }),
      "idle",
      "Waiting on the backend…"
    ],
    [
      "provider-unavailable",
      buildModelState({ provider: buildProvider("provider-unreachable") }),
      "idle",
      "Waiting on LM Studio…"
    ],
    [
      "no-model",
      buildModelState({ availability: NOT_LOADED }),
      "idle",
      "Waiting on LM Studio…"
    ],
    ["ready", buildModelState(), "idle", "Say something to Lysiptera"],
    [
      "ready",
      buildModelState(),
      "awaiting-reply",
      "Keep typing — Send unlocks when the reply ends."
    ],
    [
      "ready",
      buildModelState(),
      "opening-conversation",
      "Opening a past conversation…"
    ]
  ])(
    "reads %s/%s with a listed agent as %j",
    (_connection, state, activity, placeholder) => {
      expect(formatComposerPlaceholder(state, activity, LYSIPTERA)).toBe(
        placeholder
      )
    }
  )

  it("waits on a model when there is none and no provider is named", () => {
    expect(
      formatComposerPlaceholder(
        buildModelState({ model: null, availability: null, provider: null }),
        "idle",
        LYSIPTERA
      )
    ).toBe("Waiting on a model…")
  })

  it("invites the agent by its code while the agent list is unread", () => {
    expect(
      formatComposerPlaceholder(buildModelState(), "idle", UNREAD_AGENT)
    ).toBe("Say something to caliginia")
  })

  it("says a conversation whose agent was deleted is read-only", () => {
    expect(
      formatComposerPlaceholder(buildModelState(), "idle", DELETED_AGENT)
    ).toBe("This conversation is read-only.")
  })

  it.each<[string, ComposerModelState, string]>([
    [
      "offline",
      buildModelState({ backendStatus: "stopped" }),
      "Waiting on the backend…"
    ],
    [
      "provider-unavailable",
      buildModelState({ provider: buildProvider("provider-off") }),
      "Waiting on LM Studio…"
    ],
    [
      "no-model",
      buildModelState({ availability: NOT_LISTED }),
      "Waiting on LM Studio…"
    ]
  ])(
    "names what it waits on while %s, before a deleted agent",
    (_connection, state, placeholder) => {
      expect(formatComposerPlaceholder(state, "idle", DELETED_AGENT)).toBe(
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
    INVENTORY_FAILED,
    PROVIDER_OFF,
    PROVIDER_CONNECTING,
    PROVIDER_UNREACHABLE,
    { status: "backend-not-running" } as const
  ])(
    "keeps naming the conversation's model whatever else its availability is: %o",
    (availability) => {
      expect(
        formatComposerModelLabel("running", QWEN_MODEL, availability)
      ).toBe("qwen3-8b · LM Studio")
    }
  )

  it("names the model alone while its availability is not known", () => {
    expect(formatComposerModelLabel("running", QWEN_MODEL, null)).toBe(
      "qwen3-8b · LM Studio"
    )
  })

  it("says no model is selected when there is none", () => {
    expect(formatComposerModelLabel("running", null, null)).toBe(
      "no model selected"
    )
  })
})
