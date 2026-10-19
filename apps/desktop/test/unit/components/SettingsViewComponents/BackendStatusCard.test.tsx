import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import BackendStatusCard from "@/components/SettingsViewComponents/BackendStatusCard"
import type { BackendServerStatus } from "@/lib/store"

/** Callbacks of one rendered card, as spies. */
type BackendStatusCardSpies = {
  readonly onStartBackend: () => void
  readonly onStopBackend: () => void
  readonly onIsAutoStartOnChange: (isAutoStartOn: boolean) => void
}

/** One change of the backend's status while the card stays mounted. */
type BackendTransition = {
  /** Status before the change. */
  readonly before: BackendServerStatus
  /** Status after the change. */
  readonly after: BackendServerStatus
  /** Text of the status region after the change. */
  readonly announced: string
}

/** Origin the cases' backend listens on. */
const BACKEND_ADDRESS = "http://127.0.0.1:12345"

/** Uptime the cases' running backend reports: 1 minute and 5 seconds. */
const UPTIME_MS = 65_500

/**
 * Renders the card with spies for its callbacks.
 *
 * @param backendStatus - Status the card shows.
 * @param isAutoStartOn - Whether the startup switch is on; on by default.
 * @returns The spies and the render result's rerender function.
 */
function startBackendStatusCard(
  backendStatus: BackendServerStatus,
  isAutoStartOn = true
) {
  const spies: BackendStatusCardSpies = {
    onStartBackend: vi.fn(),
    onStopBackend: vi.fn(),
    onIsAutoStartOnChange: vi.fn()
  }
  const { rerender } = render(
    <BackendStatusCard
      backendAddress={BACKEND_ADDRESS}
      backendStatus={backendStatus}
      isAutoStartOn={isAutoStartOn}
      uptimeMs={UPTIME_MS}
      {...spies}
    />
  )
  return { spies, rerender }
}

describe("BackendStatusCard", () => {
  it.each([
    {
      backendStatus: "running",
      heading: "Backend running",
      meta: `${BACKEND_ADDRESS} · up 1m 5s`
    },
    {
      backendStatus: "starting",
      heading: "Backend starting",
      meta: `${BACKEND_ADDRESS} · starting`
    },
    {
      backendStatus: "stopping",
      heading: "Backend stopping",
      meta: `${BACKEND_ADDRESS} · stopping`
    },
    {
      backendStatus: "stopped",
      heading: "Backend stopped",
      meta: `${BACKEND_ADDRESS} · not running`
    },
    {
      backendStatus: "unresponsive",
      heading: "Backend not responding",
      meta: `${BACKEND_ADDRESS} · process is up but not answering`
    }
  ] as const)(
    "shows $backendStatus as $heading with the address line outside the status",
    ({ backendStatus, heading, meta }) => {
      startBackendStatusCard(backendStatus)

      const card = screen.getByRole("region", { name: "Lys backend" })
      const region = screen.getByRole("status", { name: "Backend status" })
      const metaLine = screen.getByText(meta)
      expect(card).toContainElement(region)
      expect(region.textContent).toBe(heading)
      expect(card).toContainElement(metaLine)
      expect(region).not.toContainElement(metaLine)
    }
  )

  it.each([
    { backendStatus: "stopped", canStart: true, canStop: false },
    { backendStatus: "starting", canStart: false, canStop: false },
    { backendStatus: "running", canStart: false, canStop: true },
    { backendStatus: "stopping", canStart: false, canStop: false },
    { backendStatus: "unresponsive", canStart: false, canStop: true }
  ] as const)(
    "offers Start only while stopped and Stop only while running or not responding ($backendStatus)",
    ({ backendStatus, canStart, canStop }) => {
      startBackendStatusCard(backendStatus)

      const start = screen.getByRole("button", { name: "Start backend" })
      const stop = screen.getByRole("button", { name: "Stop backend" })
      expect(start).toHaveTextContent("Start")
      expect(start).toHaveProperty("disabled", !canStart)
      expect(stop).toHaveTextContent("Stop")
      expect(stop).toHaveProperty("disabled", !canStop)
    }
  )

  it("asks to start a stopped backend once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startBackendStatusCard("stopped")

    await user.click(screen.getByRole("button", { name: "Start backend" }))

    expect(spies.onStartBackend).toHaveBeenCalledOnce()
    expect(spies.onStopBackend).not.toHaveBeenCalled()
  })

  it.each(["running", "unresponsive"] as const)(
    "asks to stop the backend once per press while it is %s",
    async (backendStatus) => {
      const user = userEvent.setup()
      const { spies } = startBackendStatusCard(backendStatus)

      await user.click(screen.getByRole("button", { name: "Stop backend" }))

      expect(spies.onStopBackend).toHaveBeenCalledOnce()
      expect(spies.onStartBackend).not.toHaveBeenCalled()
    }
  )

  it("proposes turning the startup switch off and explains what off means", async () => {
    const user = userEvent.setup()
    const { spies } = startBackendStatusCard("running")

    const toggle = screen.getByRole("switch", {
      name: "Start it when Lys opens"
    })
    await user.click(toggle)

    expect(toggle).toBeChecked()
    expect(spies.onIsAutoStartOnChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle).toHaveAccessibleDescription(
      "Off means the first thing you do here is press start."
    )
  })

  it("shows the startup switch off and proposes turning it on", async () => {
    const user = userEvent.setup()
    const { spies } = startBackendStatusCard("stopped", false)

    const toggle = screen.getByRole("switch", {
      name: "Start it when Lys opens"
    })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("off")).toBeInTheDocument()
    await user.click(toggle)

    expect(spies.onIsAutoStartOnChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(toggle).not.toBeChecked()
  })

  it.each<BackendTransition>([
    { before: "stopped", after: "starting", announced: "Backend starting" },
    { before: "starting", after: "running", announced: "Backend running" },
    {
      before: "starting",
      after: "unresponsive",
      announced: "Backend not responding"
    },
    { before: "running", after: "stopping", announced: "Backend stopping" },
    { before: "stopping", after: "stopped", announced: "Backend stopped" }
  ])(
    "announces $before to $after politely without moving focus",
    ({ before, after, announced }) => {
      const { spies, rerender } = startBackendStatusCard(before)
      const region = screen.getByRole("status", { name: "Backend status" })
      const toggle = screen.getByRole("switch", {
        name: "Start it when Lys opens"
      })
      toggle.focus()

      rerender(
        <BackendStatusCard
          backendAddress={BACKEND_ADDRESS}
          backendStatus={after}
          isAutoStartOn
          uptimeMs={UPTIME_MS}
          {...spies}
        />
      )

      expect(screen.getByRole("status", { name: "Backend status" })).toBe(
        region
      )
      expect(region).toHaveAttribute("aria-live", "polite")
      expect(region).toHaveAttribute("aria-atomic", "true")
      expect(region.textContent).toBe(announced)
      expect(toggle).toHaveFocus()
    }
  )

  it("updates the uptime without changing the status region", () => {
    const { spies, rerender } = startBackendStatusCard("running")
    const region = screen.getByRole("status", { name: "Backend status" })

    rerender(
      <BackendStatusCard
        backendAddress={BACKEND_ADDRESS}
        backendStatus="running"
        isAutoStartOn
        uptimeMs={UPTIME_MS + 1000}
        {...spies}
      />
    )

    expect(region.textContent).toBe("Backend running")
    expect(region).not.toContainElement(
      screen.getByText(`${BACKEND_ADDRESS} · up 1m 6s`)
    )
  })
})
