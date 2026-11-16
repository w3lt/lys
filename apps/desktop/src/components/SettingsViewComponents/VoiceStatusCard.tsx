import { VOICE_HOST, VOICE_PORT } from "@lys/protocol"
import type { ReactElement } from "react"
import StartupSwitchRow from "./StartupSwitchRow"
import { Button } from "@/components/ui/button"
import type {
  VoiceProblem,
  VoiceServerInfo,
  VoiceServerStatus
} from "@/lib/store/voice-runtime"

/** Address voice listens on, as the card shows it. */
const VOICE_ADDRESS = `${VOICE_HOST}:${VOICE_PORT}`

/** Heading of the card, by voice status. */
const VOICE_STATUS_HEADINGS = Object.freeze({
  running: "voice running",
  starting: "voice starting",
  stopping: "voice stopping",
  stopped: "voice stopped",
  unresponsive: "voice not responding"
} satisfies Readonly<Record<VoiceServerStatus, string>>)

/** What the meta line says after voice's address, by voice status. */
const VOICE_STATUS_DETAILS = Object.freeze({
  running: "speaking",
  starting:
    "starting · the first start downloads its models and can take a few minutes",
  stopping: "stopping",
  stopped: "not running",
  unresponsive: "process is up but not answering"
} satisfies Readonly<Record<VoiceServerStatus, string>>)

/** Tone of the status dot, by voice status. */
const VOICE_STATUS_TONES = Object.freeze({
  running: "active",
  starting: "pending",
  stopping: "pending",
  stopped: "idle",
  unresponsive: "danger"
} satisfies Readonly<Record<VoiceServerStatus, string>>)

/** What off means for voice's startup switch. */
const VOICE_AUTO_START_DESCRIPTION =
  "voice reads Lys's replies aloud. Off means Lys stays silent until you press start. The first start downloads about 780 MB of models."

/**
 * Formats the problem line of the last start or stop of voice.
 *
 * @param problem - Problem the store published.
 * @returns One sentence. A kill names no timeout, which the host owns.
 */
function formatVoiceProblem(problem: VoiceProblem): string {
  switch (problem.kind) {
    case "killed":
      return "voice didn't stop in time and was killed."
    case "start-failed":
      return `Lys couldn't start voice: ${problem.message}.`
    case "stop-failed":
      return `Lys couldn't stop voice: ${problem.message}.`
  }
}

/** Properties accepted by {@link VoiceStatusSummary}. */
type VoiceStatusSummaryProps = {
  /** voice lifecycle state and the problem of its last start or stop. */
  readonly voiceServerInfo: VoiceServerInfo
}

/**
 * Presents voice's status: a tone dot, the heading, voice's address with
 * what it is doing, and the problem of its last start or stop.
 *
 * @remarks Owns no state or effects. The heading, the meta line, and the
 * problem line, rendered only while there is a problem, sit in one polite,
 * atomic status region named "voice status". The region stays mounted, so a
 * change of status and the problem that came with it are announced together
 * as one message. The dot is hidden from assistive technology; the heading
 * carries the status.
 * @param props - Parent-owned voice state.
 * @returns The status part of the card's first row.
 */
function VoiceStatusSummary({
  voiceServerInfo
}: VoiceStatusSummaryProps): ReactElement {
  const { status, problem } = voiceServerInfo

  return (
    <div className="settings-view__identity">
      <span
        aria-hidden="true"
        className="settings-view__status-dot"
        data-tone={VOICE_STATUS_TONES[status]}
      />
      <div
        aria-atomic="true"
        aria-label="voice status"
        aria-live="polite"
        className="settings-view__identity-lines"
        role="status"
      >
        <h2>{VOICE_STATUS_HEADINGS[status]}</h2>
        <p className="settings-view__meta">
          {`${VOICE_ADDRESS} · ${VOICE_STATUS_DETAILS[status]}`}
        </p>
        {problem === null ? null : (
          <p className="settings-view__meta" data-tone="warning">
            {formatVoiceProblem(problem)}
          </p>
        )}
      </div>
    </div>
  )
}

/** Properties accepted by {@link VoiceStatusCard}. */
type VoiceStatusCardProps = {
  /** voice lifecycle state and the problem of its last start or stop. */
  readonly voiceServerInfo: VoiceServerInfo
  /** Whether voice starts when Lys opens. */
  readonly isAutoStartOn: boolean
  /** Requests one start of voice. */
  readonly onStartVoice: () => void
  /** Requests one stop of voice. */
  readonly onStopVoice: () => void
  /**
   * Proposes whether voice starts when Lys opens, once per change of the switch.
   *
   * @param isAutoStartOn - Proposed state. The switch shows it only once the
   * parent passes it back as `isAutoStartOn`.
   */
  readonly onIsAutoStartOnChange: (isAutoStartOn: boolean) => void
}

/**
 * Presents voice, Lys's speech server: its status, Start and Stop, and whether
 * it starts when Lys opens.
 *
 * @remarks The parent owns the state and the requests; the card owns no
 * state, effect, or store access. The card is a region named "voice speech
 * server". Its status, and the problem of the last start or stop, are
 * announced politely as one message from a status region named "voice
 * status" that stays mounted. Start is offered only while voice is stopped,
 * and Stop while it runs or is not responding, as on the vmo card; each press
 * requests one start or stop. The buttons are named "Start voice" and "Stop
 * voice" so they differ from the backend's and vmo's. The switch "Start voice
 * when Lys opens" proposes a change and shows the parent's value.
 * @param props - Parent-owned state, startup switch, and requests.
 * @returns The voice card.
 */
export default function VoiceStatusCard({
  voiceServerInfo,
  isAutoStartOn,
  onStartVoice,
  onStopVoice,
  onIsAutoStartOnChange
}: VoiceStatusCardProps): ReactElement {
  const { status } = voiceServerInfo
  const isStoppable = status === "running" || status === "unresponsive"

  return (
    <section aria-label="voice speech server" className="settings-view__card">
      <div className="settings-view__card-row">
        <VoiceStatusSummary voiceServerInfo={voiceServerInfo} />
        <div className="settings-view__actions">
          <Button
            aria-label="Start voice"
            disabled={status !== "stopped"}
            onClick={() => {
              onStartVoice()
            }}
            type="button"
            variant={status === "stopped" ? "default" : "outline"}
          >
            Start
          </Button>
          <Button
            aria-label="Stop voice"
            disabled={!isStoppable}
            onClick={() => {
              onStopVoice()
            }}
            type="button"
            variant="outline"
          >
            Stop
          </Button>
        </div>
      </div>

      <div className="settings-view__card-divider" />

      <StartupSwitchRow
        description={VOICE_AUTO_START_DESCRIPTION}
        isOn={isAutoStartOn}
        label="Start voice when Lys opens"
        onIsOnChange={onIsAutoStartOnChange}
      />
    </section>
  )
}
