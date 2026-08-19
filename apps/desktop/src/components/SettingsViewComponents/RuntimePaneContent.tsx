import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  backendStatusLabel,
  useRuntimeSettingsContext
} from "@/lib/hooks/runtimeSettingsContext"
import { type BackendServerStatus } from "@/lib/store"

/**
 * Formats non-negative backend uptime as seconds or minutes and seconds.
 *
 * @param elapsedMs - Elapsed process time in milliseconds; negative values are
 * treated as zero.
 * @returns A compact duration label; minutes intentionally do not roll into
 * hours.
 */
function formatUptime(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * Formats the backend address and lifecycle detail shown under its status.
 *
 * @param status - Store-owned backend lifecycle state.
 * @param uptimeMs - Current process uptime in milliseconds.
 * @returns The visible address and lifecycle detail label.
 */
function backendMetaLabel(status: BackendServerStatus, uptimeMs: number) {
  /** Fixed local simulation address displayed by this prototype pane. */
  const BACKEND_ADDRESS = "127.0.0.1:12345"
  switch (status) {
    case "running":
      return `${BACKEND_ADDRESS} · up ${formatUptime(uptimeMs)}`
    case "starting":
      return `${BACKEND_ADDRESS} · starting`
    case "stopping":
      return `${BACKEND_ADDRESS} · stopping`
    case "stopped":
      return `${BACKEND_ADDRESS} · not running`
  }
}

/**
 * Selects the visual status tone for a backend lifecycle state.
 *
 * @param status - Store-owned backend lifecycle state.
 * @returns The CSS tone name used for the status indicator.
 */
function backendTone(status: BackendServerStatus): string {
  switch (status) {
    case "running":
      return "active"
    case "starting":
    case "stopping":
      return "pending"
    case "stopped":
      return "idle"
  }
}

/**
 * Presents backend lifecycle controls and the session autostart toggle.
 *
 * @remarks Primary category: composition/view. The runtime settings hook
 * selects store-owned backend status and actions, while its component-owned
 * settings buffer supplies the displayed autostart value; no commit or
 * persistence callback is exposed for that buffer. Start and Stop handlers
 * intentionally discard the store-action promises with `void`: command
 * failures are not awaited, observed, rendered, or recovered here, so a
 * rejection may surface as an unhandled rejection; backend status is not a
 * completion owner when the action rejects. The autostart switch updates the
 * local buffer synchronously on each checked change. Uptime is rendered in
 * milliseconds-derived seconds/minutes. If the settings buffer is unavailable,
 * the defensive path renders no pane body; truthy malformed buffers are not
 * validated by this component. The card uses native buttons and a labelled
 * switch; status dots and the visual On/Off text are supplementary to the
 * primitive semantics.
 *
 * @returns The runtime status card and backend controls, or no body while the
 * local settings buffer is unavailable.
 */
export default function RuntimePaneContent() {
  const {
    settingsBuffer,
    setSettingsBuffer,
    startBackend,
    stopBackend,
    backendServerInfo,
    uptimeMs
  } = useRuntimeSettingsContext()

  const backendStatus = backendServerInfo.status

  if (!settingsBuffer) return null

  const autoStart = settingsBuffer.autoStartBackend
  const canStart = backendStatus === "stopped"

  return (
    <div className="settings-view__stack">
      <Card className="settings-view__card">
        <CardHeader className="settings-view__card-header">
          <div className="settings-view__identity">
            <span
              aria-hidden="true"
              className={`settings-view__status-dot settings-view__status-dot--${backendTone(backendStatus)}`}
            />
            <div className="settings-view__identity-lines">
              <CardTitle>{backendStatusLabel(backendStatus)}</CardTitle>
              <CardDescription className="settings-view__card-meta">
                {backendMetaLabel(backendStatus, uptimeMs)}
              </CardDescription>
            </div>
          </div>
          <div className="settings-view__actions">
            <Button
              disabled={!canStart}
              onClick={() => {
                void startBackend()
              }}
              type="button"
              variant={canStart ? "default" : "outline"}
            >
              Start
            </Button>
            <Button
              disabled={backendStatus !== "running"}
              onClick={() => {
                void stopBackend()
              }}
              type="button"
              variant="destructive"
            >
              Stop
            </Button>
          </div>
        </CardHeader>

        <Separator className="settings-view__card-divider" />

        <CardContent className="settings-view__card-toggle">
          <div>
            <h2>Start it when Lys opens</h2>
            <p>Off means the first thing you do here is press start.</p>
          </div>
          <div className="settings-view__toggle-state">
            {/* The switch already announces its state; this is for the eye. */}
            <span aria-hidden="true">{autoStart ? "On" : "Off"}</span>
            <Switch
              aria-label="Start it when Lys opens"
              checked={autoStart}
              onCheckedChange={() => {
                setSettingsBuffer((prev) => ({
                  ...prev,
                  autoStartBackend: !prev?.autoStartBackend
                }))
              }}
              size="lg"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
