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
 * `18s` under a minute, `711m 18s` above it. Minutes never roll into hours: a
 * long-lived local process is easier to compare in one unit.
 */
function formatUptime(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** The mono detail line under the title: where the process is, and for how long. */
function backendMetaLabel(status: BackendServerStatus, uptimeMs: number) {
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
