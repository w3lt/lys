import { VMO_HOST, VMO_PORT } from "@lys/protocol"
import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
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

/**
 * Formats the problem line of the last start or stop of vmo.
 *
 * @param problem - Problem the store published, or null.
 * @returns One sentence, or nothing without a problem.
 */
function formatVmoProblem(problem: VmoProblem | null): string {
  if (problem === null) return ""
  switch (problem.kind) {
    case "killed":
      return "vmo didn't stop within 60 seconds and was killed. It may have left VMs running."
    case "start-failed":
      return `Lys couldn't start vmo: ${problem.message}.`
    case "stop-failed":
      return `Lys couldn't stop vmo: ${problem.message}.`
  }
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
  /** Proposes the startup switch's new value. */
  readonly onAutoStartVmoChange: (checked: boolean) => void
}

/**
 * Presents vmo, Lys's page reader: its status, Start and Stop, and whether
 * it starts when Lys opens.
 *
 * @remarks The parent owns the state and the requests; the card owns no
 * state, effect, or store access. The heading and meta line are announced
 * politely when they change, and a polite status region named "vmo problem"
 * stays mounted for the problem line, empty without a problem. Start is
 * offered only while vmo is stopped, and Stop while it runs or is not
 * responding, as on the backend card; the buttons are named "Start vmo" and
 * "Stop vmo" so they differ from the backend's.
 * @param props - Parent-owned state, startup switch, and requests.
 * @returns The vmo card.
 */
export default function VmoStatusCard({
  vmoServerInfo,
  isAutoStartOn,
  onStartVmo,
  onStopVmo,
  onAutoStartVmoChange
}: VmoStatusCardProps): ReactElement {
  const { status, problem } = vmoServerInfo
  const isStoppable = status === "running" || status === "unresponsive"

  return (
    <section aria-label="vmo page reader" className="settings-view__card">
      <div className="settings-view__card-row">
        <div className="settings-view__identity">
          <span
            aria-hidden="true"
            className="settings-view__status-dot"
            data-tone={VMO_STATUS_TONES[status]}
          />
          <div className="settings-view__identity-lines">
            <div aria-live="polite" className="settings-view__identity-lines">
              <h2>{VMO_STATUS_HEADINGS[status]}</h2>
              <p className="settings-view__meta">
                {`${VMO_ADDRESS} · ${VMO_STATUS_DETAILS[status]}`}
              </p>
            </div>
            <p
              aria-label="vmo problem"
              aria-live="polite"
              className="settings-view__meta"
              data-tone="warning"
              role="status"
            >
              {formatVmoProblem(problem)}
            </p>
          </div>
        </div>
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

      <div className="settings-view__card-row">
        <div className="settings-view__identity-lines">
          <h2>Start vmo when Lys opens</h2>
          <p>
            vmo is Lys's page reader. Off means read_page stays unavailable
            until you press start.
          </p>
        </div>
        <div className="settings-view__toggle-state">
          {/* The switch already announces its state; this is for the eye. */}
          <span aria-hidden="true">{isAutoStartOn ? "on" : "off"}</span>
          <Switch
            aria-label="Start vmo when Lys opens"
            checked={isAutoStartOn}
            onCheckedChange={(checked) => {
              onAutoStartVmoChange(checked)
            }}
            size="lg"
          />
        </div>
      </div>
    </section>
  )
}
