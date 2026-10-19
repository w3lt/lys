import type { ReactElement } from "react"
import StartupSwitchRow from "./StartupSwitchRow"
import { Button } from "@/components/ui/button"
import {
  calculateBackendStatusTone,
  formatBackendStatusLabel,
  formatUptime
} from "@/lib/hooks/backendRuntime"
import type { BackendServerStatus } from "@/lib/store"

/** What off means for the backend's startup switch. */
const BACKEND_AUTO_START_DESCRIPTION =
  "Off means the first thing you do here is press start."

/**
 * Formats the address and lifecycle detail shown under the backend status.
 *
 * @param status - Store-owned backend lifecycle state.
 * @param backendAddress - Origin the backend listens on.
 * @param uptimeMs - Current process uptime in milliseconds.
 * @returns The visible address and lifecycle detail line.
 */
function formatBackendMeta(
  status: BackendServerStatus,
  backendAddress: string,
  uptimeMs: number
): string {
  switch (status) {
    case "running":
      return `${backendAddress} · up ${formatUptime(uptimeMs)}`
    case "starting":
      return `${backendAddress} · starting`
    case "stopping":
      return `${backendAddress} · stopping`
    case "stopped":
      return `${backendAddress} · not running`
    case "unresponsive":
      return `${backendAddress} · process is up but not answering`
  }
}

/** Properties accepted by {@link BackendStatusSummary}. */
type BackendStatusSummaryProps = {
  /** Backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** Origin the backend listens on. */
  readonly backendAddress: string
  /** Uptime of the running backend, in milliseconds. */
  readonly uptimeMs: number
}

/**
 * Presents the backend's status: a tone dot, the heading, and the address
 * with the uptime or what the backend is doing.
 *
 * @remarks Owns no state or effects. Only the heading sits in the polite,
 * atomic status region named "Backend status", which stays mounted, so a
 * change of status is announced while the uptime, which changes every
 * second, is not. The dot is hidden from assistive technology; the heading
 * carries the status.
 * @param props - Parent-owned status, address, and uptime.
 * @returns The status part of the card's first row.
 */
function BackendStatusSummary({
  backendStatus,
  backendAddress,
  uptimeMs
}: BackendStatusSummaryProps): ReactElement {
  return (
    <div className="settings-view__identity">
      <span
        aria-hidden="true"
        className="settings-view__status-dot"
        data-tone={calculateBackendStatusTone(backendStatus)}
      />
      <div className="settings-view__identity-lines">
        <div
          aria-atomic="true"
          aria-label="Backend status"
          aria-live="polite"
          role="status"
        >
          <h2>{formatBackendStatusLabel(backendStatus)}</h2>
        </div>
        <p className="settings-view__meta">
          {formatBackendMeta(backendStatus, backendAddress, uptimeMs)}
        </p>
      </div>
    </div>
  )
}

/** Properties accepted by {@link BackendStatusCard}. */
type BackendStatusCardProps = {
  /** Backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** Origin the backend listens on. */
  readonly backendAddress: string
  /** Uptime of the running backend, in milliseconds. */
  readonly uptimeMs: number
  /** Whether the backend starts when Lys opens. */
  readonly isAutoStartOn: boolean
  /** Requests one start of the backend. */
  readonly onStartBackend: () => void
  /** Requests one stop of the backend. */
  readonly onStopBackend: () => void
  /**
   * Proposes whether the backend starts when Lys opens, once per change of
   * the switch.
   *
   * @param isAutoStartOn - Proposed state. The switch shows it only once the
   * parent passes it back as `isAutoStartOn`.
   */
  readonly onIsAutoStartOnChange: (isAutoStartOn: boolean) => void
}

/**
 * Presents Lys's backend: its status, Start and Stop, and whether it starts
 * when Lys opens.
 *
 * @remarks The parent owns the state and the requests; the card owns no
 * state, effect, or store access. The card is a region named "Lys backend".
 * Its status is announced politely from a status region named "Backend
 * status" that stays mounted; the address and uptime line is not announced.
 * Start is offered only while the backend is stopped, and Stop while it runs
 * or is not responding; each press requests one start or stop. The buttons
 * show "Start" and "Stop" and are named "Start backend" and "Stop backend",
 * so they differ from the vmo card's. The switch "Start it when Lys opens"
 * proposes a change and shows the parent's value.
 * @param props - Parent-owned status, address, uptime, startup switch, and
 * requests.
 * @returns The backend card.
 */
export default function BackendStatusCard({
  backendStatus,
  backendAddress,
  uptimeMs,
  isAutoStartOn,
  onStartBackend,
  onStopBackend,
  onIsAutoStartOnChange
}: BackendStatusCardProps): ReactElement {
  const isStoppable =
    backendStatus === "running" || backendStatus === "unresponsive"

  return (
    <section aria-label="Lys backend" className="settings-view__card">
      <div className="settings-view__card-row">
        <BackendStatusSummary
          backendAddress={backendAddress}
          backendStatus={backendStatus}
          uptimeMs={uptimeMs}
        />
        <div className="settings-view__actions">
          <Button
            aria-label="Start backend"
            disabled={backendStatus !== "stopped"}
            onClick={() => {
              onStartBackend()
            }}
            type="button"
            variant={backendStatus === "stopped" ? "default" : "outline"}
          >
            Start
          </Button>
          <Button
            aria-label="Stop backend"
            disabled={!isStoppable}
            onClick={() => {
              onStopBackend()
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
        description={BACKEND_AUTO_START_DESCRIPTION}
        isOn={isAutoStartOn}
        label="Start it when Lys opens"
        onIsOnChange={onIsAutoStartOnChange}
      />
    </section>
  )
}
