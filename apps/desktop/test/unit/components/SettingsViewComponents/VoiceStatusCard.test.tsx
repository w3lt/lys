import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { VOICE_HOST, VOICE_PORT } from "@lys/protocol"
import VoiceStatusCard from "@/components/SettingsViewComponents/VoiceStatusCard"
import type { VoiceProblem, VoiceServerInfo } from "@/lib/store/voice-runtime"

/** Callbacks of one rendered card, as spies. */
type VoiceStatusCardSpies = {
  readonly onStartVoice: () => void
  readonly onStopVoice: () => void
  readonly onIsAutoStartOnChange: (isAutoStartOn: boolean) => void
}

/** One change of voice's state while the card stays mounted. */
type VoiceTransition = {
  /** State before the change. */
  readonly before: VoiceServerInfo
  /** State after the change. */
  readonly after: VoiceServerInfo
  /** Text of the status region after the change: heading, meta line, problem. */
  readonly announced: string
}

/** Voice's address, as the card shows it. */
const VOICE_ADDRESS = `${VOICE_HOST}:${VOICE_PORT}`

/** A start the host refused while voice was still stopping. */
const REFUSED_START = Object.freeze({
  kind: "start-failed",
  message: "voice is still stopping; start it again once it has stopped"
} satisfies VoiceProblem)

/** A stop whose process the host could not inspect. */
const FAILED_STOP = Object.freeze({
  kind: "stop-failed",
  message: "Failed to stop voice process 4343: failed to inspect it"
} satisfies VoiceProblem)

/** A voice the host killed after the stop timeout. */
const KILLED = Object.freeze({ kind: "killed" } satisfies VoiceProblem)

/** voice answering its health route. */
const RUNNING: VoiceServerInfo = Object.freeze({
  status: "running",
  problem: null
})

/** voice starting. */
const STARTING: VoiceServerInfo = Object.freeze({
  status: "starting",
  problem: null
})

/** voice stopping. */
const STOPPING: VoiceServerInfo = Object.freeze({
  status: "stopping",
  problem: null
})

/** voice stopped without a problem. */
const STOPPED: VoiceServerInfo = Object.freeze({
  status: "stopped",
  problem: null
})

/** voice running without answering, without a problem. */
const UNRESPONSIVE: VoiceServerInfo = Object.freeze({
  status: "unresponsive",
  problem: null
})

/** voice stopped after a refused start. */
const STOPPED_AFTER_REFUSED_START: VoiceServerInfo = Object.freeze({
  status: "stopped",
  problem: REFUSED_START
})

/** voice stopped after it was killed. */
const STOPPED_AFTER_KILL: VoiceServerInfo = Object.freeze({
  status: "stopped",
  problem: KILLED
})

/** voice still running after a failed stop. */
const UNRESPONSIVE_AFTER_FAILED_STOP: VoiceServerInfo = Object.freeze({
  status: "unresponsive",
  problem: FAILED_STOP
})

/** voice running, or of unknown status, after a failed start. */
const UNRESPONSIVE_AFTER_REFUSED_START: VoiceServerInfo = Object.freeze({
  status: "unresponsive",
  problem: REFUSED_START
})

/** What the card says about a refused start. */
const REFUSED_START_LINE =
  "Lys couldn't start voice: voice is still stopping; start it again once it has stopped."

/** What the card says about a failed stop. */
const FAILED_STOP_LINE =
  "Lys couldn't stop voice: Failed to stop voice process 4343: failed to inspect it."

/** What the card says about a kill. */
const KILLED_LINE = "voice didn't stop in time and was killed."

/**
 * Renders the card with spies for its callbacks.
 *
 * @param voiceServerInfo - State the card shows.
 * @param isAutoStartOn - Whether the startup switch is on; on by default.
 * @returns The spies and the render result's rerender function.
 */
function startVoiceStatusCard(
  voiceServerInfo: VoiceServerInfo,
  isAutoStartOn = true
) {
  const spies: VoiceStatusCardSpies = {
    onStartVoice: vi.fn(),
    onStopVoice: vi.fn(),
    onIsAutoStartOnChange: vi.fn()
  }
  const { rerender } = render(
    <VoiceStatusCard
      isAutoStartOn={isAutoStartOn}
      voiceServerInfo={voiceServerInfo}
      {...spies}
    />
  )
  return { spies, rerender }
}

describe("VoiceStatusCard", () => {
  it.each([
    {
      status: "running",
      heading: "voice running",
      meta: `${VOICE_ADDRESS} · speaking`
    },
    {
      status: "starting",
      heading: "voice starting",
      meta: `${VOICE_ADDRESS} · starting · the first start downloads its models and can take a few minutes`
    },
    {
      status: "stopping",
      heading: "voice stopping",
      meta: `${VOICE_ADDRESS} · stopping`
    },
    {
      status: "stopped",
      heading: "voice stopped",
      meta: `${VOICE_ADDRESS} · not running`
    },
    {
      status: "unresponsive",
      heading: "voice not responding",
      meta: `${VOICE_ADDRESS} · process is up but not answering`
    }
  ] as const)("shows $status as $heading", ({ status, heading, meta }) => {
    startVoiceStatusCard({ status, problem: null })

    const region = screen.getByRole("status", { name: "voice status" })
    expect(screen.getByRole("region", { name: "voice speech server" })).toBe(
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
      startVoiceStatusCard({ status, problem: null })

      expect(
        screen.getByRole("button", { name: "Start voice" })
      ).toHaveProperty("disabled", !canStart)
      expect(screen.getByRole("button", { name: "Stop voice" })).toHaveProperty(
        "disabled",
        !canStop
      )
    }
  )

  it("asks to start a stopped voice once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startVoiceStatusCard(STOPPED)

    await user.click(screen.getByRole("button", { name: "Start voice" }))

    expect(spies.onStartVoice).toHaveBeenCalledOnce()
    expect(spies.onStopVoice).not.toHaveBeenCalled()
  })

  it("asks to stop a running voice once per press", async () => {
    const user = userEvent.setup()
    const { spies } = startVoiceStatusCard(RUNNING)

    await user.click(screen.getByRole("button", { name: "Stop voice" }))

    expect(spies.onStopVoice).toHaveBeenCalledOnce()
    expect(spies.onStartVoice).not.toHaveBeenCalled()
  })

  it("asks to stop a voice that is not responding", async () => {
    const user = userEvent.setup()
    const { spies } = startVoiceStatusCard(UNRESPONSIVE)

    await user.click(screen.getByRole("button", { name: "Stop voice" }))

    expect(spies.onStopVoice).toHaveBeenCalledOnce()
  })

  it("proposes turning the startup switch off and explains what off means", async () => {
    const user = userEvent.setup()
    const { spies } = startVoiceStatusCard(STOPPED)

    const toggle = screen.getByRole("switch", {
      name: "Start voice when Lys opens"
    })
    await user.click(toggle)

    expect(toggle).toBeChecked()
    expect(spies.onIsAutoStartOnChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle).toHaveAccessibleDescription(
      "voice reads Lys's replies aloud. Off means Lys stays silent until you press start. The first start downloads about 780 MB of models."
    )
  })

  it("shows the startup switch off and proposes turning it on", async () => {
    const user = userEvent.setup()
    const { spies } = startVoiceStatusCard(STOPPED, false)

    const toggle = screen.getByRole("switch", {
      name: "Start voice when Lys opens"
    })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("off")).toBeInTheDocument()
    await user.click(toggle)

    expect(spies.onIsAutoStartOnChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(toggle).not.toBeChecked()
  })

  it.each([
    { voiceServerInfo: STOPPED_AFTER_KILL, line: KILLED_LINE },
    { voiceServerInfo: STOPPED_AFTER_REFUSED_START, line: REFUSED_START_LINE },
    { voiceServerInfo: UNRESPONSIVE_AFTER_FAILED_STOP, line: FAILED_STOP_LINE },
    {
      voiceServerInfo: UNRESPONSIVE_AFTER_REFUSED_START,
      line: REFUSED_START_LINE
    }
  ])(
    "shows the $voiceServerInfo.problem.kind problem of a $voiceServerInfo.status voice in its status",
    ({ voiceServerInfo, line }) => {
      startVoiceStatusCard(voiceServerInfo)

      expect(
        screen.getByRole("status", { name: "voice status" })
      ).toContainElement(screen.getByText(line))
    }
  )

  it.each<VoiceTransition>([
    {
      before: STARTING,
      after: STOPPED_AFTER_REFUSED_START,
      announced: `voice stopped${VOICE_ADDRESS} · not running${REFUSED_START_LINE}`
    },
    {
      before: STARTING,
      after: UNRESPONSIVE_AFTER_REFUSED_START,
      announced: `voice not responding${VOICE_ADDRESS} · process is up but not answering${REFUSED_START_LINE}`
    },
    {
      before: STOPPING,
      after: STOPPED_AFTER_KILL,
      announced: `voice stopped${VOICE_ADDRESS} · not running${KILLED_LINE}`
    },
    {
      before: STOPPING,
      after: UNRESPONSIVE_AFTER_FAILED_STOP,
      announced: `voice not responding${VOICE_ADDRESS} · process is up but not answering${FAILED_STOP_LINE}`
    },
    {
      before: RUNNING,
      after: STOPPING,
      announced: `voice stopping${VOICE_ADDRESS} · stopping`
    },
    {
      before: STOPPED_AFTER_KILL,
      after: STARTING,
      announced: `voice starting${VOICE_ADDRESS} · starting · the first start downloads its models and can take a few minutes`
    }
  ])(
    "announces $before.status to $after.status as one polite message without moving focus",
    ({ before, after, announced }) => {
      const { spies, rerender } = startVoiceStatusCard(before)
      const region = screen.getByRole("status", { name: "voice status" })
      const toggle = screen.getByRole("switch", {
        name: "Start voice when Lys opens"
      })
      toggle.focus()

      rerender(
        <VoiceStatusCard isAutoStartOn voiceServerInfo={after} {...spies} />
      )

      expect(screen.getByRole("status", { name: "voice status" })).toBe(region)
      expect(region).toHaveAttribute("aria-live", "polite")
      expect(region).toHaveAttribute("aria-atomic", "true")
      expect(region.textContent).toBe(announced)
      expect(toggle).toHaveFocus()
    }
  )
})
