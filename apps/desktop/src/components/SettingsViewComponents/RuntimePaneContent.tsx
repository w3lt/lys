import { AppState } from "@/app/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"

function backendStatusLabel(status: AppState["runtime"]["backend"]) {
  switch (status) {
    case "running":
      return "Backend running"
    case "starting":
      return "Backend starting"
    case "stopping":
      return "Backend stopping"
    case "stopped":
      return "Backend stopped"
  }
}

export default function RuntimePaneContent() {
  return (
    <div className="settings-view__stack">
      <Card className="settings-view__card">
        <CardHeader className="settings-view__card-header">
          <div>
            <CardDescription>Inference server</CardDescription>
            <CardTitle>{backendStatusLabel(runtime.backend)}</CardTitle>
          </div>
          <span
            aria-hidden="true"
            className={`settings-view__status-dot settings-view__status-dot--${runtime.backend}`}
          />
        </CardHeader>
        <CardContent className="settings-view__card-content">
          <p>
            Lys talks only to the process listening on the configured local
            address.
          </p>
          <div className="settings-view__actions">
            {runtime.backend === "stopped" ? (
              <Button onClick={onStartBackend} type="button">
                Start backend
              </Button>
            ) : runtime.backend === "running" ? (
              <Button
                onClick={onStopBackend}
                type="button"
                variant="destructive"
              >
                Stop backend
              </Button>
            ) : (
              <Button disabled type="button" variant="outline">
                {runtime.backend === "starting"
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
          checked={runtime.autostart}
          onCheckedChange={onAutostartToggle}
        />
      </div>

      <Separator className="settings-view__separator" />

      <Card className="settings-view__card">
        <CardHeader className="settings-view__card-header">
          <div>
            <CardDescription>Selected weights</CardDescription>
            <CardTitle>{modelStatusLabel(runtime.model)}</CardTitle>
          </div>
          <span className="settings-view__model-size">
            {MODEL_OPTIONS.find(({ name }) => name === state.config.model)
              ?.size ?? "—"}
          </span>
        </CardHeader>
        <CardContent className="settings-view__card-content">
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
                disabled={runtime.backend !== "running"}
                onClick={onUnloadModel}
                type="button"
                variant="outline"
              >
                Unload model
              </Button>
            ) : runtime.model === "none" ? (
              <Button
                disabled={runtime.backend !== "running"}
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
        </CardContent>
      </Card>

      <section aria-label="Runtime log" className="settings-view__log">
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
      </section>
    </div>
  )
}
