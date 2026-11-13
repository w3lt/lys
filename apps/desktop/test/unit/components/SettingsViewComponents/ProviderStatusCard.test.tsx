import { llmProviderSettingsSchema, type LlmProvider } from "@lys/share"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ProviderStatusCard from "@/components/SettingsViewComponents/ProviderStatusCard"
import type { BackendServerStatus } from "@/lib/store"
import type {
  LlmProviderStatus,
  ProviderModelStates
} from "@/lib/store/model-runtime"
import type { ProvidersSettings } from "@/lib/store/settings"
import { buildProviderModelStates } from "../../support/providerModelFixtures"

/** What one rendered card shows. */
type ProviderStatusArrangement = {
  /** Providers the saved settings turn on, in the order they are saved. */
  readonly enabled: readonly LlmProvider[]
  /** Status of each provider the case sets; the rest are `unknown`. */
  readonly statuses: Readonly<Partial<Record<LlmProvider, LlmProviderStatus>>>
  /** Backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
}

/**
 * Builds the saved providers with every address at its default.
 *
 * @param enabled - Providers turned on.
 * @returns The saved providers.
 */
function buildProviders(enabled: readonly LlmProvider[]): ProvidersSettings {
  return llmProviderSettingsSchema.parse({
    enabled,
    lmStudio: { address: null },
    ollama: { address: null }
  })
}

/**
 * Builds every provider's state with the given statuses.
 *
 * @param statuses - Status of each provider the case sets.
 * @returns The states.
 */
function buildStatuses(
  statuses: ProviderStatusArrangement["statuses"]
): ProviderModelStates {
  return buildProviderModelStates(
    Object.fromEntries(
      Object.entries(statuses).map(([provider, status]) => [
        provider,
        { status }
      ])
    )
  )
}

/**
 * Renders the card with spies for its requests.
 *
 * @param arrangement - What the card shows.
 * @returns The spies and the render result's rerender function.
 */
function startProviderStatusCard(arrangement: ProviderStatusArrangement) {
  const spies = {
    onRefreshProviders: vi.fn<(providers: readonly LlmProvider[]) => void>(),
    onOpenProviders: vi.fn<() => void>()
  }
  const { rerender } = render(
    <ProviderStatusCard
      backendStatus={arrangement.backendStatus}
      providerModels={buildStatuses(arrangement.statuses)}
      providers={buildProviders(arrangement.enabled)}
      {...spies}
    />
  )
  return { spies, rerender }
}

/**
 * Gets the card the cases render.
 *
 * @returns The card's region.
 */
function getCard(): HTMLElement {
  return screen.getByRole("region", { name: "Provider connections" })
}

/**
 * Lists the rows' headings, in the order the card shows them.
 *
 * @returns Each row's heading text.
 */
function listRowHeadings(): (string | null)[] {
  return within(getCard())
    .queryAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent)
}

describe("ProviderStatusCard", () => {
  it("lists each turned-on provider in provider order with its state and where it is", () => {
    startProviderStatusCard({
      enabled: ["groq", "lmStudio"],
      statuses: { lmStudio: "unreachable", groq: "connected" },
      backendStatus: "running"
    })

    expect(listRowHeadings()).toEqual([
      "LM Studio not reachable",
      "Groq connected"
    ])
    const rows = within(getCard()).getAllByRole("listitem")
    expect(rows[0]).toHaveTextContent(
      "127.0.0.1:1234 · start LM Studio, then refresh"
    )
    expect(rows[1]).toHaveTextContent("api.groq.com")
    expect(getCard()).toHaveTextContent("2 providers on")
  })

  it("lists no provider the saved settings leave off", () => {
    startProviderStatusCard({
      enabled: ["ollama"],
      statuses: { ollama: "connected", lmStudio: "off", groq: "off" },
      backendStatus: "running"
    })

    expect(listRowHeadings()).toEqual(["Ollama connected"])
    expect(getCard()).toHaveTextContent("1 provider on")
  })

  it("says a turned-on provider the backend has off is off and where to turn it on", () => {
    startProviderStatusCard({
      enabled: ["lmStudio"],
      statuses: { lmStudio: "off" },
      backendStatus: "running"
    })

    expect(listRowHeadings()).toEqual(["LM Studio is off"])
    expect(getCard()).toHaveTextContent(
      "127.0.0.1:1234 · turn it on in Providers"
    )
  })

  it("announces status changes politely", () => {
    const { spies, rerender } = startProviderStatusCard({
      enabled: ["lmStudio"],
      statuses: { lmStudio: "connecting" },
      backendStatus: "running"
    })
    const heading = screen.getByRole("heading", {
      name: "Connecting to LM Studio"
    })

    rerender(
      <ProviderStatusCard
        backendStatus="running"
        providerModels={buildStatuses({ lmStudio: "connected" })}
        providers={buildProviders(["lmStudio"])}
        {...spies}
      />
    )

    expect(heading).toHaveTextContent("LM Studio connected")
    expect(heading.closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite"
    )
  })

  it("refreshes every turned-on provider that is not connecting, once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startProviderStatusCard({
      enabled: ["lmStudio", "ollama", "groq"],
      statuses: {
        lmStudio: "connecting",
        ollama: "unreachable",
        groq: "off"
      },
      backendStatus: "running"
    })

    await user.click(screen.getByRole("button", { name: "Refresh" }))

    expect(spies.onRefreshProviders).toHaveBeenCalledExactlyOnceWith([
      "ollama",
      "groq"
    ])
  })

  it.each<{
    backendStatus: BackendServerStatus
    status: LlmProviderStatus
  }>([
    { backendStatus: "running", status: "connecting" },
    { backendStatus: "stopped", status: "unknown" },
    { backendStatus: "starting", status: "unknown" },
    { backendStatus: "unresponsive", status: "unreachable" }
  ])(
    "cannot refresh while the backend is $backendStatus and the only provider is $status",
    async ({ backendStatus, status }) => {
      const user = userEvent.setup()
      const { spies } = startProviderStatusCard({
        enabled: ["lmStudio"],
        statuses: { lmStudio: status },
        backendStatus
      })

      await user.click(screen.getByRole("button", { name: "Refresh" }))

      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
      expect(spies.onRefreshProviders).not.toHaveBeenCalled()
    }
  )

  it("says no provider is on and opens Providers instead of refreshing", async () => {
    const user = userEvent.setup()
    const { spies } = startProviderStatusCard({
      enabled: [],
      statuses: {},
      backendStatus: "running"
    })

    expect(getCard()).toHaveTextContent(
      "No provider is on · turn one on in Providers"
    )
    expect(listRowHeadings()).toEqual([])
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Open Providers" }))

    expect(spies.onOpenProviders).toHaveBeenCalledOnce()
  })
})
