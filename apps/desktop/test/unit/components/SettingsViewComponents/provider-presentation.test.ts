import { llmProviderSettingsSchema, providerAddressSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildProvidersWithAddress,
  buildProvidersWithOnlyProvider,
  calculateProviderBadge,
  calculateProviderKeyFieldValue,
  findProviderAccessKind,
  findProviderCardProvider,
  formatProviderAddressPlaceholder,
  formatProviderKeyPlaceholder,
  formatProviderMessage,
  formatProviderModeTag,
  isProviderCardOn,
  parseProviderAddressDraft,
  parseProviderKeyDraft,
  UNEDITED_PROVIDER_DRAFT,
  type ProviderFieldDraft,
  type ProviderStatusInput
} from "@/components/SettingsViewComponents/provider-presentation"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"
import {
  STORED_GROQ_API_KEY,
  STORED_PROVIDERS_SETTINGS,
  STORED_SETTINGS
} from "../../support/settingsFixtures"

/** Saved keys: a Groq key, and no Ollama key. */
const SECRETS: SecretsSettings = STORED_SETTINGS.secrets

/** Saved address of the stored local Ollama. */
const OLLAMA_ADDRESS = providerAddressSchema.parse("192.168.1.20:11434")

/** Providers with only Ollama Cloud on, the local address still saved. */
const OLLAMA_CLOUD: ProvidersSettings = llmProviderSettingsSchema.parse({
  ...STORED_PROVIDERS_SETTINGS,
  enabled: ["ollamaCloud"],
  ollama: { address: OLLAMA_ADDRESS }
})

/** Providers with only Groq on. */
const GROQ_ACTIVE: ProvidersSettings = llmProviderSettingsSchema.parse({
  ...STORED_PROVIDERS_SETTINGS,
  enabled: ["groq"]
})

/** Providers with both Ollama servers and Groq on. */
const BOTH_OLLAMAS_AND_GROQ: ProvidersSettings =
  llmProviderSettingsSchema.parse({
    ...STORED_PROVIDERS_SETTINGS,
    enabled: ["ollamaCloud", "ollama", "groq"]
  })

/**
 * Builds an edit of a field.
 *
 * @param text - Text in the field.
 * @returns The edited draft.
 */
function buildEditedDraft(text: string): ProviderFieldDraft {
  return { status: "edited", text }
}

/**
 * Builds the facts of the stored local Ollama card, connected and idle.
 *
 * @param overrides - Facts the case changes.
 * @returns The status input.
 */
function buildStatusInput(
  overrides: Partial<ProviderStatusInput> = {}
): ProviderStatusInput {
  return {
    access: { kind: "address", provider: "ollama" },
    providers: STORED_PROVIDERS_SETTINGS,
    secrets: SECRETS,
    status: "connected",
    backendStatus: "running",
    saveState: { status: "idle" },
    draft: UNEDITED_PROVIDER_DRAFT,
    ...overrides
  }
}

describe("provider-presentation", () => {
  it("tags each provider with where it runs", () => {
    expect(formatProviderModeTag("lmStudio", STORED_PROVIDERS_SETTINGS)).toBe(
      "local"
    )
    expect(formatProviderModeTag("ollama", STORED_PROVIDERS_SETTINGS)).toBe(
      "local"
    )
    expect(formatProviderModeTag("ollama", OLLAMA_CLOUD)).toBe("cloud")
    expect(formatProviderModeTag("groq", STORED_PROVIDERS_SETTINGS)).toBe(
      "cloud"
    )
  })

  describe("provider cards", () => {
    it("presents Ollama Cloud on Ollama's card only while it is on and the local server is not", () => {
      expect(findProviderCardProvider("ollama", OLLAMA_CLOUD)).toBe(
        "ollamaCloud"
      )
      expect(
        findProviderCardProvider("ollama", STORED_PROVIDERS_SETTINGS)
      ).toBe("ollama")
      expect(findProviderCardProvider("ollama", BOTH_OLLAMAS_AND_GROQ)).toBe(
        "ollama"
      )
      expect(findProviderCardProvider("ollama", GROQ_ACTIVE)).toBe("ollama")
      expect(findProviderCardProvider("groq", OLLAMA_CLOUD)).toBe("groq")
      expect(findProviderCardProvider("lmStudio", OLLAMA_CLOUD)).toBe(
        "lmStudio"
      )
    })

    it("marks a card on while the provider it presents is on", () => {
      expect(isProviderCardOn("ollama", OLLAMA_CLOUD)).toBe(true)
      expect(isProviderCardOn("ollama", STORED_PROVIDERS_SETTINGS)).toBe(true)
      expect(isProviderCardOn("groq", BOTH_OLLAMAS_AND_GROQ)).toBe(true)
      expect(isProviderCardOn("lmStudio", BOTH_OLLAMAS_AND_GROQ)).toBe(false)
      expect(isProviderCardOn("ollama", GROQ_ACTIVE)).toBe(false)
    })

    it("turns exactly one provider on, keeping the addresses", () => {
      expect(
        buildProvidersWithOnlyProvider(BOTH_OLLAMAS_AND_GROQ, "lmStudio")
      ).toEqual({ ...BOTH_OLLAMAS_AND_GROQ, enabled: ["lmStudio"] })
    })
  })

  it("reaches LM Studio and local Ollama at an address, Ollama Cloud and Groq with a key", () => {
    expect(findProviderAccessKind("lmStudio")).toEqual({
      kind: "address",
      provider: "lmStudio"
    })
    expect(findProviderAccessKind("ollama")).toEqual({
      kind: "address",
      provider: "ollama"
    })
    expect(findProviderAccessKind("ollamaCloud")).toEqual({
      kind: "key",
      provider: "ollamaCloud"
    })
    expect(findProviderAccessKind("groq")).toEqual({
      kind: "key",
      provider: "groq"
    })
  })

  it("replaces one provider's address and keeps the rest of the choice", () => {
    expect(
      buildProvidersWithAddress(STORED_PROVIDERS_SETTINGS, "ollama", null)
    ).toEqual({
      ...STORED_PROVIDERS_SETTINGS,
      ollama: { address: null }
    })
    expect(
      buildProvidersWithAddress(
        STORED_PROVIDERS_SETTINGS,
        "lmStudio",
        OLLAMA_ADDRESS
      )
    ).toEqual({
      ...STORED_PROVIDERS_SETTINGS,
      lmStudio: { address: OLLAMA_ADDRESS }
    })
  })

  it("shows the saved address, or the default while none is saved, as the placeholder", () => {
    expect(
      formatProviderAddressPlaceholder("ollama", STORED_PROVIDERS_SETTINGS)
    ).toBe("192.168.1.20:11434")
    expect(
      formatProviderAddressPlaceholder("lmStudio", STORED_PROVIDERS_SETTINGS)
    ).toBe("127.0.0.1:1234")
  })

  describe("parseProviderAddressDraft", () => {
    it("has nothing to save for an unedited field, the saved address, or empty text without a saved one", () => {
      expect(
        parseProviderAddressDraft(UNEDITED_PROVIDER_DRAFT, OLLAMA_ADDRESS)
      ).toEqual({ status: "unchanged" })
      expect(
        parseProviderAddressDraft(
          buildEditedDraft(" 192.168.1.20:11434 "),
          OLLAMA_ADDRESS
        )
      ).toEqual({ status: "unchanged" })
      expect(parseProviderAddressDraft(buildEditedDraft("  "), null)).toEqual({
        status: "unchanged"
      })
    })

    it("saves a new address, and returns to the default for empty text", () => {
      expect(
        parseProviderAddressDraft(
          buildEditedDraft("localhost:11500"),
          OLLAMA_ADDRESS
        )
      ).toEqual({ status: "changed", address: "localhost:11500" })
      expect(
        parseProviderAddressDraft(buildEditedDraft(""), OLLAMA_ADDRESS)
      ).toEqual({ status: "changed", address: null })
    })

    it("refuses text that is not host:port", () => {
      expect(
        parseProviderAddressDraft(buildEditedDraft("localhost"), null)
      ).toEqual({ status: "invalid" })
    })
  })

  describe("provider keys", () => {
    it("masks the saved key as the placeholder, or shows an example while none is saved", () => {
      expect(formatProviderKeyPlaceholder("groq", SECRETS)).toBe(
        "gsk_f••••••••0000"
      )
      expect(formatProviderKeyPlaceholder("ollamaCloud", SECRETS)).toBe(
        "paste your Ollama key"
      )
    })

    it("puts the saved key in the field only while it is shown and unedited", () => {
      expect(
        calculateProviderKeyFieldValue(
          UNEDITED_PROVIDER_DRAFT,
          true,
          STORED_GROQ_API_KEY
        )
      ).toBe(STORED_GROQ_API_KEY)
      expect(
        calculateProviderKeyFieldValue(
          UNEDITED_PROVIDER_DRAFT,
          false,
          STORED_GROQ_API_KEY
        )
      ).toBe("")
      expect(
        calculateProviderKeyFieldValue(
          buildEditedDraft("gsk_new"),
          true,
          STORED_GROQ_API_KEY
        )
      ).toBe("gsk_new")
    })

    it("saves a new valid key, and has nothing to save for the saved one", () => {
      expect(
        parseProviderKeyDraft(
          "groq",
          buildEditedDraft(" gsk_fixture_2222222222222222 "),
          SECRETS
        )
      ).toEqual({
        status: "changed",
        change: { provider: "groq", apiKey: "gsk_fixture_2222222222222222" }
      })
      expect(
        parseProviderKeyDraft(
          "groq",
          buildEditedDraft(STORED_GROQ_API_KEY),
          SECRETS
        )
      ).toEqual({ status: "unchanged" })
      expect(
        parseProviderKeyDraft("ollamaCloud", UNEDITED_PROVIDER_DRAFT, SECRETS)
      ).toEqual({ status: "unchanged" })
    })

    it("refuses a key with spaces inside it", () => {
      expect(
        parseProviderKeyDraft(
          "ollamaCloud",
          buildEditedDraft("abc def"),
          SECRETS
        )
      ).toEqual({ status: "invalid" })
    })
  })

  describe("calculateProviderBadge", () => {
    it("marks a provider that is turned off as off", () => {
      expect(
        calculateProviderBadge(
          "groq",
          STORED_PROVIDERS_SETTINGS,
          SECRETS,
          "connected"
        )
      ).toEqual({ label: "off", tone: "muted" })
    })

    it("marks a provider the backend reports off as off", () => {
      expect(
        calculateProviderBadge("groq", GROQ_ACTIVE, SECRETS, "off")
      ).toEqual({ label: "off", tone: "muted" })
    })

    it("asks for a key a turned-on provider needs and lacks", () => {
      expect(
        calculateProviderBadge("ollama", OLLAMA_CLOUD, SECRETS, "unreachable")
      ).toEqual({ label: "needs key", tone: "attention" })
    })

    it("follows the connection of a turned-on provider", () => {
      expect(
        calculateProviderBadge("groq", GROQ_ACTIVE, SECRETS, "connected")
      ).toEqual({ label: "connected", tone: "success" })
      expect(
        calculateProviderBadge(
          "ollama",
          STORED_PROVIDERS_SETTINGS,
          SECRETS,
          "unreachable"
        )
      ).toEqual({ label: "unreachable", tone: "danger" })
      expect(
        calculateProviderBadge(
          "ollama",
          STORED_PROVIDERS_SETTINGS,
          SECRETS,
          "connecting"
        )
      ).toEqual({ label: "connecting", tone: "attention" })
      expect(
        calculateProviderBadge(
          "ollama",
          STORED_PROVIDERS_SETTINGS,
          SECRETS,
          "unknown"
        )
      ).toEqual({ label: "unknown", tone: "muted" })
    })
  })

  describe("formatProviderMessage", () => {
    it("explains an edit before anything else", () => {
      expect(
        formatProviderMessage(
          buildStatusInput({
            draft: buildEditedDraft("localhost"),
            saveState: { status: "saving" }
          })
        )
      ).toEqual({
        text: "not an address: use host:port, such as 127.0.0.1:1234",
        tone: "danger"
      })
      expect(
        formatProviderMessage(
          buildStatusInput({ draft: buildEditedDraft("localhost:1") })
        )
      ).toEqual({
        text: "unsaved · enter to save, esc to discard",
        tone: "attention"
      })
      expect(
        formatProviderMessage(
          buildStatusInput({
            access: { kind: "key", provider: "groq" },
            providers: GROQ_ACTIVE,
            draft: buildEditedDraft("gsk bad")
          })
        ).tone
      ).toBe("danger")
    })

    it("reports a running or failed save", () => {
      expect(
        formatProviderMessage(
          buildStatusInput({ saveState: { status: "saving" } })
        )
      ).toEqual({ text: "saving…", tone: "pending" })
      expect(
        formatProviderMessage(
          buildStatusInput({
            saveState: { status: "failed", error: "Lys couldn't write." }
          })
        )
      ).toEqual({ text: "Lys couldn't write.", tone: "danger" })
    })

    it("asks for a missing key before the connection", () => {
      expect(
        formatProviderMessage(
          buildStatusInput({
            access: { kind: "key", provider: "ollamaCloud" },
            providers: OLLAMA_CLOUD,
            status: "unreachable"
          })
        )
      ).toEqual({
        text: "No key yet. Lys can't reach Ollama Cloud until there is one.",
        tone: "attention"
      })
    })

    it("describes the connection at the address or with the key", () => {
      expect(formatProviderMessage(buildStatusInput())).toEqual({
        text: "connected · 192.168.1.20:11434",
        tone: "success"
      })
      expect(
        formatProviderMessage(buildStatusInput({ status: "unreachable" }))
      ).toEqual({
        text: "Ollama is not reachable at 192.168.1.20:11434 · start it, or check the address",
        tone: "danger"
      })
      expect(
        formatProviderMessage(
          buildStatusInput({
            access: { kind: "key", provider: "groq" },
            providers: GROQ_ACTIVE,
            status: "unreachable"
          })
        )
      ).toEqual({
        text: "Groq didn't answer with this key · check the key and your network",
        tone: "danger"
      })
      expect(
        formatProviderMessage(buildStatusInput({ status: "connecting" }))
      ).toEqual({ text: "connecting to Ollama…", tone: "pending" })
    })

    it("says the backend still has a turned-on provider off until it is checked again", () => {
      expect(
        formatProviderMessage(buildStatusInput({ status: "off" }))
      ).toEqual({
        text: "the backend has Ollama off · press Test to check again",
        tone: "muted"
      })
    })

    it("words an unknown connection by what the backend is doing", () => {
      const lines = (
        ["running", "stopped", "starting", "stopping", "unresponsive"] as const
      ).map(
        (backendStatus) =>
          formatProviderMessage(
            buildStatusInput({ status: "unknown", backendStatus })
          ).text
      )

      expect(lines).toEqual([
        "Lys couldn't read the connection to Ollama · press Test to check again",
        "the backend isn't running, so Lys can't reach Ollama yet",
        "waiting for the backend to start before reaching Ollama",
        "the backend is stopping",
        "the backend is not responding, so Lys can't reach Ollama"
      ])
    })
  })
})
