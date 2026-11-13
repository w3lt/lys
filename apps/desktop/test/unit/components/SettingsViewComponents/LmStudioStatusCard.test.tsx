import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import LmStudioStatusCard from "@/components/SettingsViewComponents/LmStudioStatusCard"
import type { BackendServerStatus } from "@/lib/store"
import type { LlmProviderStatus } from "@/lib/store/model-runtime"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"

describe("LmStudioStatusCard", () => {
  it("names the connection state and what to do about it", () => {
    render(
      <LmStudioStatusCard
        provider={LM_STUDIO_TARGET}
        backendStatus="running"
        status="unreachable"
        onRefreshStatus={vi.fn()}
      />
    )

    const card = screen.getByRole("region", { name: "LM Studio connection" })
    expect(
      screen.getByRole("heading", { name: "LM Studio not reachable" })
    ).toBeInTheDocument()
    expect(card).toHaveTextContent(
      "127.0.0.1:1234 · start LM Studio, then refresh"
    )
  })

  it("says a provider the backend has off is off and where to turn it on", () => {
    render(
      <LmStudioStatusCard
        provider={LM_STUDIO_TARGET}
        backendStatus="running"
        status="off"
        onRefreshStatus={vi.fn()}
      />
    )

    const card = screen.getByRole("region", { name: "LM Studio connection" })
    expect(
      screen.getByRole("heading", { name: "LM Studio is off" })
    ).toBeInTheDocument()
    expect(card).toHaveTextContent("127.0.0.1:1234 · turn it on in Providers")
  })

  it("names and locates the provider it shows", () => {
    render(
      <LmStudioStatusCard
        provider={GROQ_TARGET}
        backendStatus="running"
        status="connected"
        onRefreshStatus={vi.fn()}
      />
    )

    const card = screen.getByRole("region", { name: "Groq connection" })
    expect(
      screen.getByRole("heading", { name: "Groq connected" })
    ).toBeInTheDocument()
    expect(card).toHaveTextContent("api.groq.com")
  })

  it("announces status changes politely", () => {
    const { rerender } = render(
      <LmStudioStatusCard
        provider={LM_STUDIO_TARGET}
        backendStatus="running"
        status="connecting"
        onRefreshStatus={vi.fn()}
      />
    )
    const heading = screen.getByRole("heading", {
      name: "Connecting to LM Studio"
    })

    rerender(
      <LmStudioStatusCard
        provider={LM_STUDIO_TARGET}
        backendStatus="running"
        status="connected"
        onRefreshStatus={vi.fn()}
      />
    )

    expect(heading).toHaveTextContent("LM Studio connected")
    expect(heading.closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite"
    )
  })

  it("refreshes once per press while the backend runs", async () => {
    const onRefreshStatus = vi.fn()
    const user = userEvent.setup()
    render(
      <LmStudioStatusCard
        provider={LM_STUDIO_TARGET}
        backendStatus="running"
        status="unreachable"
        onRefreshStatus={onRefreshStatus}
      />
    )

    await user.click(screen.getByRole("button", { name: "Refresh" }))

    expect(onRefreshStatus).toHaveBeenCalledOnce()
  })

  it.each<[BackendServerStatus, LlmProviderStatus]>([
    ["running", "connecting"],
    ["running", "off"],
    ["stopped", "unknown"],
    ["starting", "unknown"],
    ["unresponsive", "unreachable"]
  ])(
    "cannot refresh while the backend is %s and LM Studio is %s",
    async (backendStatus, status) => {
      const onRefreshStatus = vi.fn()
      const user = userEvent.setup()
      render(
        <LmStudioStatusCard
          provider={LM_STUDIO_TARGET}
          backendStatus={backendStatus}
          status={status}
          onRefreshStatus={onRefreshStatus}
        />
      )

      await user.click(screen.getByRole("button", { name: "Refresh" }))

      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
      expect(onRefreshStatus).not.toHaveBeenCalled()
    }
  )
})
