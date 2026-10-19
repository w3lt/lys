import { VMO_HOST, VMO_PORT } from "@lys/protocol"
import type { ReactElement } from "react"
import StartupSwitchRow from "./StartupSwitchRow"
import { Button } from "@/components/ui/button"
import type {
  VmoProblem,
  VmoServerInfo,
  VmoServerStatus
} from "@/lib/store/vmo-runtime"

/** Address vmo listens on, as the card shows it. */
const VMO_ADDRESS = `${VMO_HOST}:${VMO_PORT}`

/** Heading of the card, by vmo status. */
const VMO_STATUS_HEADINGS = Object.freeze({
  running: "vmo running",
  starting: "vmo starting",
  stopping: "vmo stopping",
  stopped: "vmo stopped",
  unresponsive: "vmo not responding"
} satisfies Readonly<Record<VmoServerStatus, string>>)

/** What the meta line says after vmo's address, by vmo status. */
const VMO_STATUS_DETAILS = Object.freeze({
  running: "reading pages",
  starting:
    "starting · the first start downloads its images and can take a few minutes",
  stopping: "stopping · deleting its VMs",
  stopped: "not running",
  unresponsive: "process is up but not answering"
} satisfies Readonly<Record<VmoServerStatus, string>>)

/** Tone of the status dot, by vmo status. */
const VMO_STATUS_TONES = Object.freeze({
  running: "active",
  starting: "pending",
  stopping: "pending",
  stopped: "idle",
  unresponsive: "danger"
} satisfies Readonly<Record<VmoServerStatus, string>>)

/** What off means for vmo's startup switch. */
const VMO_AUTO_START_DESCRIPTION =
  "vmo is Lys's page reader. Off means read_page stays unavailable until you press start."

/**
 * Formats the problem line of the last start or stop of vmo.
 *
 * @param problem - Problem the store published.
 * @returns One sentence. A kill names no timeout, which the host owns.
 */
function formatVmoProblem(problem: VmoProblem): string {
  switch (problem.kind) {
    case "killed":
      return "vmo didn't stop in time and was killed. It may have left VMs running."
    case "start-failed":
      return `Lys couldn't start vmo: ${problem.message}.`
    case "stop-failed":
      return `Lys couldn't stop vmo: ${problem.message}.`
  }
}

/** Properties accepted by {@link VmoStatusSummary}. */
type VmoStatusSummaryProps = {
  /** vmo lifecycle state and the problem of its last start or stop. */
  readonly vmoServerInfo: VmoServerInfo
}

/**
 * Presents vmo's status: a tone dot, the heading, vmo's address with what it
 * is doing, and the problem of its last start or stop.
 *
 * @remarks Owns no state or effects. The heading, the meta line, and the
 * problem line, rendered only while there is a problem, sit in one polite,
 * atomic status region named "vmo status". The region stays mounted, so a
 * change of status and the problem that came with it are announced together
 * as one message. The dot is hidden from assistive technology; the heading
 * carries the status.
 * @param props - Parent-owned vmo state.
 * @returns The status part of the card's first row.
 */
function VmoStatusSummary({
  vmoServerInfo
}: VmoStatusSummaryProps): ReactElement {
  const { status, problem } = vmoServerInfo

  return (
    <div className="settings-view__identity">
      <span
        aria-hidden="true"
        className="settings-view__status-dot"
        data-tone={VMO_STATUS_TONES[status]}
      />
      <div
        aria-atomic="true"
        aria-label="vmo status"
        aria-live="polite"
        className="settings-view__identity-lines"
        role="status"
      >
        <h2>{VMO_STATUS_HEADINGS[status]}</h2>
        <p className="settings-view__meta">
          {`${VMO_ADDRESS} · ${VMO_STATUS_DETAILS[status]}`}
        </p>
        {problem === null ? null : (
          <p className="settings-view__meta" data-tone="warning">
            {formatVmoProblem(problem)}
          </p>
        )}
      </div>
    </div>
  )
}

/** Properties accepted by {@link VmoStatusCard}. */
type VmoStatusCardProps = {
  /** vmo lifecycle state and the problem of its last start or stop. */
  readonly vmoServerInfo: VmoServerInfo
  /** Whether vmo starts when Lys opens. */
  readonly isAutoStartOn: boolean
  /** Requests one start of vmo. */
  readonly onStartVmo: () => void
  /** Requests one stop of vmo. */
  readonly onStopVmo: () => void
  /**
   * Proposes whether vmo starts when Lys opens, once per change of the switch.
   *
   * @param isAutoStartOn - Proposed state. The switch shows it only once the
   * parent passes it back as `isAutoStartOn`.
   */
  readonly onIsAutoStartOnChange: (isAutoStartOn: boolean) => void
}

/**
 * Presents vmo, Lys's page reader: its status, Start and Stop, and whether
 * it starts when Lys opens.
 *
 * @remarks The parent owns the state and the requests; the card owns no
 * state, effect, or store access. The card is a region named "vmo page
 * reader". Its status, and the problem of the last start or stop, are
 * announced politely as one message from a status region named "vmo status"
 * that stays mounted. Start is offered only while vmo is stopped, and Stop
 * while it runs or is not responding, as on the backend card; each press
 * requests one start or stop. The buttons are named "Start vmo" and "Stop vmo"
 * so they differ from the backend's. The switch "Start vmo when Lys opens"
 * proposes a change and shows the parent's value.
 * @param props - Parent-owned state, startup switch, and requests.
 * @returns The vmo card.
 */
export default function VmoStatusCard({
  vmoServerInfo,
  isAutoStartOn,
  onStartVmo,
  onStopVmo,
  onIsAutoStartOnChange
}: VmoStatusCardProps): ReactElement {
  const { status } = vmoServerInfo
  const isStoppable = status === "running" || status === "unresponsive"

  return (
    <section aria-label="vmo page reader" className="settings-view__card">
      <div className="settings-view__card-row">
        <VmoStatusSummary vmoServerInfo={vmoServerInfo} />
        <div className="settings-view__actions">
          <Button
            aria-label="Start vmo"
            disabled={status !== "stopped"}
            onClick={() => {
              onStartVmo()
            }}
            type="button"
            variant={status === "stopped" ? "default" : "outline"}
          >
            Start
          </Button>
          <Button
            aria-label="Stop vmo"
            disabled={!isStoppable}
            onClick={() => {
              onStopVmo()
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
        description={VMO_AUTO_START_DESCRIPTION}
        isOn={isAutoStartOn}
        label="Start vmo when Lys opens"
        onIsOnChange={onIsAutoStartOnChange}
      />
    </section>
  )
}
