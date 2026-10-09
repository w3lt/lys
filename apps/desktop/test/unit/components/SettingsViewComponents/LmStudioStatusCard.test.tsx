import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import LmStudioStatusCard from "@/components/SettingsViewComponents/LmStudioStatusCard"
import { LM_STUDIO_ADDRESS } from "@/lib/models/lm-studio-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"

describe("LmStudioStatusCard", () => {
  it("names the connection state and what to do about it", () => {
    render(
      <LmStudioStatusCard
        backendStatus="running"
        lmStudioStatus="unreachable"
        onRefreshLmStudioStatus={vi.fn()}
      />
    )

    const card = screen.getByRole("region", { name: "LM Studio connection" })
    expect(
      screen.getByRole("heading", { name: "LM Studio not reachable" })
    ).toBeInTheDocument()
    expect(card).toHaveTextContent(
      `${LM_STUDIO_ADDRESS} · start LM Studio, then refresh`
    )
  })

  it("announces status changes politely", () => {
    const { rerender } = render(
      <LmStudioStatusCard
        backendStatus="running"
        lmStudioStatus="connecting"
        onRefreshLmStudioStatus={vi.fn()}
      />
    )
    const heading = screen.getByRole("heading", {
      name: "Connecting to LM Studio"
    })

    rerender(
      <LmStudioStatusCard
        backendStatus="running"
        lmStudioStatus="connected"
        onRefreshLmStudioStatus={vi.fn()}
      />
    )

    expect(heading).toHaveTextContent("LM Studio connected")
    expect(heading.closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite"
    )
  })

  it("refreshes once per press while the backend runs", async () => {
    const onRefreshLmStudioStatus = vi.fn()
    const user = userEvent.setup()
    render(
      <LmStudioStatusCard
        backendStatus="running"
        lmStudioStatus="unreachable"
        onRefreshLmStudioStatus={onRefreshLmStudioStatus}
      />
    )

    await user.click(screen.getByRole("button", { name: "Refresh" }))

    expect(onRefreshLmStudioStatus).toHaveBeenCalledOnce()
  })

  it.each<[BackendServerStatus, LmStudioStatus]>([
    ["running", "connecting"],
    ["stopped", "unknown"],
    ["starting", "unknown"],
    ["unresponsive", "unreachable"]
  ])(
    "cannot refresh while the backend is %s and LM Studio is %s",
    async (backendStatus, lmStudioStatus) => {
      const onRefreshLmStudioStatus = vi.fn()
      const user = userEvent.setup()
      render(
        <LmStudioStatusCard
          backendStatus={backendStatus}
          lmStudioStatus={lmStudioStatus}
          onRefreshLmStudioStatus={onRefreshLmStudioStatus}
        />
      )

      await user.click(screen.getByRole("button", { name: "Refresh" }))

      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
      expect(onRefreshLmStudioStatus).not.toHaveBeenCalled()
    }
  )
})
