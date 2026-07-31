import type { AppState } from "@/app/types"
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
import { lazy } from "react"
const PaneSkeleton = lazy(() => import("./PaneSkeleton"))

function modelStatusLabel(status: AppState["runtime"]["model"]) {
  switch (status) {
    case "loaded":
      return "Model loaded"
    case "loading":
      return "Model loading"
    case "unloading":
      return "Model unloading"
    case "none":
      return "No model loaded"
  }
}

export default function RuntimePaneContent() {
  const {
    settingsBuffer,
    setSettingsBuffer,
    startBackend,
    stopBackend,
    loadingSettings,
    backendStatus
  } = useRuntimeSettingsContext()

  if (loadingSettings) return <PaneSkeleton pane="runtime" />
  if (!settingsBuffer) return null

  return (
    <div className="settings-view__stack">
      <Card className="settings-view__card">
        <CardHeader className="settings-view__card-header">
          <div>
            <CardDescription>Inference server</CardDescription>
            <CardTitle>{backendStatusLabel(backendStatus)}</CardTitle>
          </div>
          <span
            aria-hidden="true"
            className={`settings-view__status-dot settings-view__status-dot--${backendStatus}`}
          />
        </CardHeader>
        <CardContent className="settings-view__card-content">
          <p>
            Lys talks only to the process listening on the configured local
            address.
          </p>
          <div className="settings-view__actions">
            {backendStatus === "stopped" ? (
              <Button
                onClick={() => {
                  void startBackend()
                }}
                type="button"
              >
                Start backend
              </Button>
            ) : backendStatus === "running" ? (
              <Button
                onClick={() => {
                  void stopBackend()
                }}
                type="button"
                variant="destructive"
              >
                Stop backend
              </Button>
            ) : (
              <Button disabled type="button" variant="outline">
                {backendStatus === "starting"
                  ? "Starting backend"
                  : "Stopping backend"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="settings-view__setting-row">
        <div>
          <h2>Automatic start</h2>
          <p>Start it when Lys opens</p>
        </div>
        <Switch
          aria-label="Start it when Lys opens"
          checked={settingsBuffer.autoStartBackend}
          onCheckedChange={() => {
            setSettingsBuffer((prev) => ({
              ...prev,
              autoStartBackend: !prev?.autoStartBackend
            }))
          }}
        />
      </div>

      <Separator className="settings-view__separator" />

      <Card className="settings-view__card">
        <CardHeader className="settings-view__card-header">
          <div>
            <CardDescription>Selected weights</CardDescription>
            <CardTitle>{modelStatusLabel("none")}</CardTitle>
          </div>
          <span className="settings-view__model-size">
            {settingsBuffer.selectedModel ?? "No model"}
          </span>
        </CardHeader>
        {/* <CardContent className="settings-view__card-content">
          <p className="settings-view__model-name">{state.config.model}</p>
          {runtime.model === "loading" ? (
            <div className="settings-view__progress">
              <div>
                <span>Loading weights</span>
                <span>{runtime.modelProgress}%</span>
              </div>
              <Progress
                aria-label="Model loading progress"
                value={runtime.modelProgress}
              />
            </div>
          ) : null}
          <div className="settings-view__actions">
            {runtime.model === "loaded" ? (
              <Button
                disabled={backendStatus !== "running"}
                onClick={onUnloadModel}
                type="button"
                variant="outline"
              >
                Unload model
              </Button>
            ) : runtime.model === "none" ? (
              <Button
                disabled={backendStatus !== "running"}
                onClick={onLoadModel}
                type="button"
              >
                Load model
              </Button>
            ) : (
              <Button disabled type="button" variant="outline">
                {runtime.model === "loading"
                  ? "Loading model"
                  : "Unloading model"}
              </Button>
            )}
          </div>
        </CardContent> */}
      </Card>

      {/* <section aria-label="Runtime log" className="settings-view__log">
        <div className="settings-view__section-heading">
          <h2>Runtime log</h2>
          <span>last seven events</span>
        </div>
        {runtime.log.length === 0 ? (
          <p className="settings-view__empty-log">
            No runtime events this session.
          </p>
        ) : (
          <ol aria-live="polite">
            {runtime.log.map((entry) => (
              <li key={entry.id}>
                <time>{entry.time}</time>
                <span
                  className={`settings-view__log-tone settings-view__log-tone--${entry.tone}`}
                >
                  {entry.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section> */}
    </div>
  )
}
