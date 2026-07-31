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
  backendMetaLabel,
  backendStatusLabel,
  useRuntimeSettingsContext,
  type BackendStatus
} from "@/lib/hooks/runtimeSettingsContext"
import { lazy } from "react"

const PaneSkeleton = lazy(() => import("./PaneSkeleton"))

function backendTone(status: BackendStatus): string {
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
    loadingSettings,
    backendStatus,
    uptimeMs
  } = useRuntimeSettingsContext()

  if (loadingSettings) return <PaneSkeleton pane="runtime" />
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
