import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import VmoStatusCard from "@/components/SettingsViewComponents/VmoStatusCard"
import type { VmoProblem, VmoServerInfo } from "@/lib/store/vmo-runtime"

/** Callbacks of one rendered card, as spies. */
type VmoStatusCardSpies = {
  readonly onStartVmo: () => void
  readonly onStopVmo: () => void
  readonly onIsAutoStartOnChange: (isAutoStartOn: boolean) => void
}

/** One change of vmo's state while the card stays mounted. */
type VmoTransition = {
  /** State before the change. */
  readonly before: VmoServerInfo
  /** State after the change. */
  readonly after: VmoServerInfo
  /** Text of the status region after the change: heading, meta line, problem. */
  readonly announced: string
}

/** What the card says after vmo's address. */
const VMO_ADDRESS = "127.0.0.1:8080"

/** A start the host refused while vmo was still stopping. */
const REFUSED_START = Object.freeze({
  kind: "start-failed",
  message: "vmo is still stopping; start it again once it has stopped"
} satisfies VmoProblem)

/** A stop whose process the host could not inspect. */
const FAILED_STOP = Object.freeze({
  kind: "stop-failed",
  message: "Failed to stop vmo process 4343: failed to inspect it"
} satisfies VmoProblem)

/** A vmo the host killed after the stop timeout. */
const KILLED = Object.freeze({ kind: "killed" } satisfies VmoProblem)

/** vmo answering its health route. */
const RUNNING: VmoServerInfo = Object.freeze({
  status: "running",
  problem: null
})

/** vmo starting. */
const STARTING: VmoServerInfo = Object.freeze({
  status: "starting",
  problem: null
})

/** vmo stopping. */
const STOPPING: VmoServerInfo = Object.freeze({
  status: "stopping",
  problem: null
})

/** vmo stopped without a problem. */
const STOPPED: VmoServerInfo = Object.freeze({
  status: "stopped",
  problem: null
})

/** vmo running without answering, without a problem. */
const UNRESPONSIVE: VmoServerInfo = Object.freeze({
  status: "unresponsive",
  problem: null
})

/** vmo stopped after a refused start. */
const STOPPED_AFTER_REFUSED_START: VmoServerInfo = Object.freeze({
  status: "stopped",
  problem: REFUSED_START
})

/** vmo stopped after it was killed. */
const STOPPED_AFTER_KILL: VmoServerInfo = Object.freeze({
  status: "stopped",
  problem: KILLED
})

/** vmo still running after a failed stop. */
const UNRESPONSIVE_AFTER_FAILED_STOP: VmoServerInfo = Object.freeze({
  status: "unresponsive",
  problem: FAILED_STOP
})

/** vmo running, or of unknown status, after a failed start. */
const UNRESPONSIVE_AFTER_REFUSED_START: VmoServerInfo = Object.freeze({
  status: "unresponsive",
  problem: REFUSED_START
})

/** What the card says about a refused start. */
const REFUSED_START_LINE =
  "Lys couldn't start vmo: vmo is still stopping; start it again once it has stopped."

/** What the card says about a failed stop. */
const FAILED_STOP_LINE =
  "Lys couldn't stop vmo: Failed to stop vmo process 4343: failed to inspect it."

/** What the card says about a kill. */
const KILLED_LINE =
  "vmo didn't stop in time and was killed. It may have left VMs running."

/**
 * Renders the card with spies for its callbacks.
 *
 * @param vmoServerInfo - State the card shows.
 * @param isAutoStartOn - Whether the startup switch is on; on by default.
 * @returns The spies and the render result's rerender function.
 */
function startVmoStatusCard(
  vmoServerInfo: VmoServerInfo,
  isAutoStartOn = true
) {
  const spies: VmoStatusCardSpies = {
    onStartVmo: vi.fn(),
    onStopVmo: vi.fn(),
    onIsAutoStartOnChange: vi.fn()
  }
  const { rerender } = render(
    <VmoStatusCard
      isAutoStartOn={isAutoStartOn}
      vmoServerInfo={vmoServerInfo}
      {...spies}
    />
  )
  return { spies, rerender }
}

describe("VmoStatusCard", () => {
  it.each([
    {
      status: "running",
      heading: "vmo running",
      meta: `${VMO_ADDRESS} · reading pages`
    },
    {
      status: "starting",
      heading: "vmo starting",
      meta: `${VMO_ADDRESS} · starting · the first start downloads its images and can take a few minutes`
    },
    {
      status: "stopping",
      heading: "vmo stopping",
      meta: `${VMO_ADDRESS} · stopping · deleting its VMs`
    },
    {
      status: "stopped",
      heading: "vmo stopped",
      meta: `${VMO_ADDRESS} · not running`
    },
    {
      status: "unresponsive",
      heading: "vmo not responding",
      meta: `${VMO_ADDRESS} · process is up but not answering`
    }
  ] as const)("shows $status as $heading", ({ status, heading, meta }) => {
    startVmoStatusCard({ status, problem: null })

    const region = screen.getByRole("status", { name: "vmo status" })
    expect(screen.getByRole("region", { name: "vmo page reader" })).toBe(
      region.closest("section")
    )
    expect(region).toContainElement(
      screen.getByRole("heading", { name: heading })
    )
    expect(region.textContent).toBe(`${heading}${meta}`)
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
      startVmoStatusCard({ status, problem: null })

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
    const { spies } = startVmoStatusCard(STOPPED)

    await user.click(screen.getByRole("button", { name: "Start vmo" }))

    expect(spies.onStartVmo).toHaveBeenCalledOnce()
    expect(spies.onStopVmo).not.toHaveBeenCalled()
  })

  it("asks to stop a running vmo once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startVmoStatusCard(RUNNING)

    await user.click(screen.getByRole("button", { name: "Stop vmo" }))

    expect(spies.onStopVmo).toHaveBeenCalledOnce()
    expect(spies.onStartVmo).not.toHaveBeenCalled()
  })

  it("asks to stop a vmo that is not responding", async () => {
    const user = userEvent.setup()
    const { spies } = startVmoStatusCard(UNRESPONSIVE)

    await user.click(screen.getByRole("button", { name: "Stop vmo" }))

    expect(spies.onStopVmo).toHaveBeenCalledOnce()
  })

  it("proposes turning the startup switch off and explains what off means", async () => {
    const user = userEvent.setup()
    const { spies } = startVmoStatusCard(STOPPED)

    const toggle = screen.getByRole("switch", {
      name: "Start vmo when Lys opens"
    })
    await user.click(toggle)

    expect(toggle).toBeChecked()
    expect(spies.onIsAutoStartOnChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle).toHaveAccessibleDescription(
      "vmo is Lys's page reader. Off means read_page stays unavailable until you press start."
    )
  })

  it("shows the startup switch off and proposes turning it on", async () => {
    const user = userEvent.setup()
    const { spies } = startVmoStatusCard(STOPPED, false)

    const toggle = screen.getByRole("switch", {
      name: "Start vmo when Lys opens"
    })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("off")).toBeInTheDocument()
    await user.click(toggle)

    expect(spies.onIsAutoStartOnChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(toggle).not.toBeChecked()
  })

  it.each([
    { vmoServerInfo: STOPPED_AFTER_KILL, line: KILLED_LINE },
    { vmoServerInfo: STOPPED_AFTER_REFUSED_START, line: REFUSED_START_LINE },
    { vmoServerInfo: UNRESPONSIVE_AFTER_FAILED_STOP, line: FAILED_STOP_LINE },
    {
      vmoServerInfo: UNRESPONSIVE_AFTER_REFUSED_START,
      line: REFUSED_START_LINE
    }
  ])(
    "shows the $vmoServerInfo.problem.kind problem of a $vmoServerInfo.status vmo in its status",
    ({ vmoServerInfo, line }) => {
      startVmoStatusCard(vmoServerInfo)

      expect(
        screen.getByRole("status", { name: "vmo status" })
      ).toContainElement(screen.getByText(line))
    }
  )

  it.each<VmoTransition>([
    {
      before: STARTING,
      after: STOPPED_AFTER_REFUSED_START,
      announced: `vmo stopped${VMO_ADDRESS} · not running${REFUSED_START_LINE}`
    },
    {
      before: STARTING,
      after: UNRESPONSIVE_AFTER_REFUSED_START,
      announced: `vmo not responding${VMO_ADDRESS} · process is up but not answering${REFUSED_START_LINE}`
    },
    {
      before: STOPPING,
      after: STOPPED_AFTER_KILL,
      announced: `vmo stopped${VMO_ADDRESS} · not running${KILLED_LINE}`
    },
    {
      before: STOPPING,
      after: UNRESPONSIVE_AFTER_FAILED_STOP,
      announced: `vmo not responding${VMO_ADDRESS} · process is up but not answering${FAILED_STOP_LINE}`
    },
    {
      before: RUNNING,
      after: STOPPING,
      announced: `vmo stopping${VMO_ADDRESS} · stopping · deleting its VMs`
    },
    {
      before: STOPPED_AFTER_KILL,
      after: STARTING,
      announced: `vmo starting${VMO_ADDRESS} · starting · the first start downloads its images and can take a few minutes`
    }
  ])(
    "announces $before.status to $after.status as one polite message without moving focus",
    ({ before, after, announced }) => {
      const { spies, rerender } = startVmoStatusCard(before)
      const region = screen.getByRole("status", { name: "vmo status" })
      const toggle = screen.getByRole("switch", {
        name: "Start vmo when Lys opens"
      })
      toggle.focus()

      rerender(<VmoStatusCard isAutoStartOn vmoServerInfo={after} {...spies} />)

      expect(screen.getByRole("status", { name: "vmo status" })).toBe(region)
      expect(region).toHaveAttribute("aria-live", "polite")
      expect(region).toHaveAttribute("aria-atomic", "true")
      expect(region.textContent).toBe(announced)
      expect(toggle).toHaveFocus()
    }
  )
})
