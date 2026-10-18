import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import VmoStatusCard from "@/components/SettingsViewComponents/VmoStatusCard"
import type { VmoServerInfo } from "@/lib/store/vmo-runtime"

/** Callbacks of one rendered card, as spies. */
type VmoStatusCardSpies = {
  readonly onStartVmo: () => void
  readonly onStopVmo: () => void
  readonly onAutoStartVmoChange: (checked: boolean) => void
}

/**
 * Renders the card with spies for its callbacks.
 *
 * @param vmoServerInfo - State the card shows.
 * @param isAutoStartOn - Whether the startup switch is on; on by default.
 * @returns The spies.
 */
function renderVmoStatusCard(
  vmoServerInfo: VmoServerInfo,
  isAutoStartOn = true
): VmoStatusCardSpies {
  const spies = {
    onStartVmo: vi.fn(),
    onStopVmo: vi.fn(),
    onAutoStartVmoChange: vi.fn()
  }
  render(
    <VmoStatusCard
      isAutoStartOn={isAutoStartOn}
      vmoServerInfo={vmoServerInfo}
      {...spies}
    />
  )
  return spies
}

describe("VmoStatusCard", () => {
  it.each([
    {
      status: "running",
      heading: "vmo running",
      meta: "127.0.0.1:8080 · reading pages"
    },
    {
      status: "starting",
      heading: "vmo starting",
      meta: "127.0.0.1:8080 · starting · the first start downloads its images and can take a few minutes"
    },
    {
      status: "stopping",
      heading: "vmo stopping",
      meta: "127.0.0.1:8080 · stopping · deleting its VMs"
    },
    {
      status: "stopped",
      heading: "vmo stopped",
      meta: "127.0.0.1:8080 · not running"
    },
    {
      status: "unresponsive",
      heading: "vmo not responding",
      meta: "127.0.0.1:8080 · process is up but not answering"
    }
  ] as const)("shows $status as “$heading”", ({ status, heading, meta }) => {
    renderVmoStatusCard({ status, problem: null })

    const card = screen.getByRole("region", { name: "vmo page reader" })
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument()
    expect(card).toHaveTextContent(meta)
  })

  it.each([
    { status: "stopped", canStart: true, canStop: false },
    { status: "starting", canStart: false, canStop: false },
    { status: "running", canStart: false, canStop: true },
    { status: "stopping", canStart: false, canStop: false },
    { status: "unresponsive", canStart: false, canStop: true }
  ] as const)(
    "offers Start only while stopped and Stop only while running or not responding ($status)",
    ({ status, canStart, canStop }) => {
      renderVmoStatusCard({ status, problem: null })

      expect(screen.getByRole("button", { name: "Start vmo" })).toHaveProperty(
        "disabled",
        !canStart
      )
      expect(screen.getByRole("button", { name: "Stop vmo" })).toHaveProperty(
        "disabled",
        !canStop
      )
    }
  )

  it("asks to start a stopped vmo once per press", async () => {
    const user = userEvent.setup()
    const stopped = renderVmoStatusCard({ status: "stopped", problem: null })

    await user.click(screen.getByRole("button", { name: "Start vmo" }))

    expect(stopped.onStartVmo).toHaveBeenCalledOnce()
    expect(stopped.onStopVmo).not.toHaveBeenCalled()
  })

  it("asks to stop a vmo that is not responding", async () => {
    const user = userEvent.setup()
    const spies = renderVmoStatusCard({ status: "unresponsive", problem: null })

    await user.click(screen.getByRole("button", { name: "Stop vmo" }))

    expect(spies.onStopVmo).toHaveBeenCalledOnce()
  })

  it("proposes the startup switch's new value and explains what off means", async () => {
    const user = userEvent.setup()
    const spies = renderVmoStatusCard({ status: "stopped", problem: null })

    const toggle = screen.getByRole("switch", {
      name: "Start vmo when Lys opens"
    })
    await user.click(toggle)

    expect(toggle).toBeChecked()
    expect(spies.onAutoStartVmoChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(
      screen.getByRole("region", { name: "vmo page reader" })
    ).toHaveTextContent(
      "vmo is Lys's page reader. Off means read_page stays unavailable until you press start."
    )
  })

  it.each([
    {
      vmoServerInfo: { status: "stopped", problem: { kind: "killed" } },
      line: "vmo didn't stop within 60 seconds and was killed. It may have left VMs running."
    },
    {
      vmoServerInfo: {
        status: "stopped",
        problem: {
          kind: "start-failed",
          message: "vmo is still stopping; start it again once it has stopped"
        }
      },
      line: "Lys couldn't start vmo: vmo is still stopping; start it again once it has stopped."
    },
    {
      vmoServerInfo: {
        status: "unresponsive",
        problem: {
          kind: "stop-failed",
          message: "Failed to stop vmo process 4343: failed to inspect it"
        }
      },
      line: "Lys couldn't stop vmo: Failed to stop vmo process 4343: failed to inspect it."
    }
  ] as const)(
    "announces the $vmoServerInfo.problem.kind problem politely",
    ({ vmoServerInfo, line }) => {
      renderVmoStatusCard(vmoServerInfo)

      const status = screen.getByRole("status", { name: "vmo problem" })
      expect(status).toHaveTextContent(line)
      expect(status).toHaveAttribute("aria-live", "polite")
    }
  )

  it("keeps the problem region empty while there is no problem", () => {
    renderVmoStatusCard({ status: "running", problem: null })

    expect(
      screen.getByRole("status", { name: "vmo problem" })
    ).toBeEmptyDOMElement()
  })
})
