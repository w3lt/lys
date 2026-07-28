import { useState } from "react"

import { MODEL_OPTIONS } from "@/app/content"
import type {
  AppState,
  LysConfig,
  SettingsPane,
} from "@/app/types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"

import "./SettingsView.css"

const SETTINGS_PANES: ReadonlyArray<{
  value: SettingsPane
  label: string
}> = [
  { value: "runtime", label: "Runtime" },
  { value: "model", label: "Model" },
  { value: "generation", label: "Generation" },
  { value: "conversation", label: "Conversation" },
]

const CONTEXT_OPTIONS: ReadonlyArray<{
  value: LysConfig["contextSize"]
  label: string
}> = [
  { value: 4096, label: "4k" },
  { value: 8192, label: "8k" },
  { value: 16384, label: "16k" },
  { value: 32768, label: "32k" },
]

interface SettingsViewProps {
  state: AppState
  onAutostartToggle: () => void
  onConfigChange: (patch: Partial<LysConfig>) => void
  onDone: () => void
  onLoadModel: () => void
  onPaneChange: (pane: SettingsPane) => void
  onSelectModel: (model: string) => void
  onStartBackend: () => void
  onStopBackend: () => void
  onUnloadModel: () => void
}

function PaneHeading({
  eyebrow,
  title,
  note,
}: {
  eyebrow: string
  title: string
  note: string
}) {
  return (
    <header className="settings-view__pane-heading">
      <p>{eyebrow}</p>
      <h1>{title}</h1>
      <span>{note}</span>
    </header>
  )
}

function PaneFooter({ onDone }: { onDone: () => void }) {
  return (
    <footer className="settings-view__footer">
      <p>Changes live in this session only. Nothing is written to disk.</p>
      <Button
        onClick={onDone}
        size="lysCompact"
        type="button"
        variant="lysPrimary"
      >
        Done
      </Button>
    </footer>
  )
}

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

function singleSliderValue(value: number | readonly number[]) {
  return typeof value === "number" ? value : value[0]
}

function RuntimePane({
  state,
  onAutostartToggle,
  onDone,
  onLoadModel,
  onStartBackend,
  onStopBackend,
  onUnloadModel,
}: Pick<
  SettingsViewProps,
  | "state"
  | "onAutostartToggle"
  | "onDone"
  | "onLoadModel"
  | "onStartBackend"
  | "onStopBackend"
  | "onUnloadModel"
>) {
  const { runtime } = state

  return (
    <div className="settings-view__pane">
      <PaneHeading
        eyebrow="local process"
        note="The backend and model below are deterministic local simulations."
        title="Runtime"
      />

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
                <Button
                  onClick={onStartBackend}
                  size="lysCompact"
                  type="button"
                  variant="lysPrimary"
                >
                  Start backend
                </Button>
              ) : runtime.backend === "running" ? (
                <Button
                  onClick={onStopBackend}
                  size="lysCompact"
                  type="button"
                  variant="lysDanger"
                >
                  Stop backend
                </Button>
              ) : (
                <Button
                  disabled
                  size="lysCompact"
                  type="button"
                  variant="lysOutline"
                >
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
            className="settings-view__switch"
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
                  size="lysCompact"
                  type="button"
                  variant="lysOutline"
                >
                  Unload model
                </Button>
              ) : runtime.model === "none" ? (
                <Button
                  disabled={runtime.backend !== "running"}
                  onClick={onLoadModel}
                  size="lysCompact"
                  type="button"
                  variant="lysPrimary"
                >
                  Load model
                </Button>
              ) : (
                <Button
                  disabled
                  size="lysCompact"
                  type="button"
                  variant="lysOutline"
                >
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

      <PaneFooter onDone={onDone} />
    </div>
  )
}

function ModelPane({
  state,
  onConfigChange,
  onDone,
  onSelectModel,
}: Pick<
  SettingsViewProps,
  "state" | "onConfigChange" | "onDone" | "onSelectModel"
>) {
  const [probeResult, setProbeResult] = useState("")

  function testConnection() {
    setProbeResult(
      state.runtime.backend === "running"
        ? `probe ok · ${state.config.endpoint}`
        : "probe failed · backend stopped"
    )
  }

  return (
    <div className="settings-view__pane">
      <PaneHeading
        eyebrow="local endpoint"
        note="Choose the server and weights Lys will use for the next request."
        title="Model"
      />

      <div className="settings-view__stack">
        <section className="settings-view__field">
          <label htmlFor="lys-server-address">Server address</label>
          <div className="settings-view__input-action">
            <Input
              aria-label="Server address"
              className="settings-view__input"
              id="lys-server-address"
              onChange={(event) =>
                onConfigChange({ endpoint: event.currentTarget.value })
              }
              spellCheck={false}
              value={state.config.endpoint}
            />
            <Button
              onClick={testConnection}
              size="lysCompact"
              type="button"
              variant="lysOutline"
            >
              Test connection
            </Button>
          </div>
          <p
            aria-live="polite"
            className="settings-view__probe"
            role="status"
          >
            {probeResult || "No network request is made by this prototype."}
          </p>
        </section>

        <Separator className="settings-view__separator" />

        <section className="settings-view__models">
          <div className="settings-view__section-heading">
            <h2>Available models</h2>
            <span>local weights</span>
          </div>
          <div className="settings-view__model-list">
            {MODEL_OPTIONS.map((model) => {
              const selected = state.config.model === model.name

              return (
                <Button
                  aria-pressed={selected}
                  className="settings-view__model-option"
                  key={model.name}
                  onClick={() => onSelectModel(model.name)}
                  type="button"
                  variant="lysOutline"
                >
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.meta}</small>
                  </span>
                  <span>{selected ? "selected" : model.size}</span>
                </Button>
              )
            })}
          </div>
          <p className="settings-view__note">
            Selecting different weights releases the model currently in memory.
          </p>
        </section>
      </div>

      <PaneFooter onDone={onDone} />
    </div>
  )
}

function GenerationPane({
  state,
  onConfigChange,
  onDone,
}: Pick<SettingsViewProps, "state" | "onConfigChange" | "onDone">) {
  function changeContext(values: string[]) {
    const selected = CONTEXT_OPTIONS.find(
      ({ value }) => String(value) === values[0]
    )
    if (selected) onConfigChange({ contextSize: selected.value })
  }

  return (
    <div className="settings-view__pane">
      <PaneHeading
        eyebrow="token policy"
        note="These values are applied to the next simulated request."
        title="Generation"
      />

      <div className="settings-view__stack">
        <section className="settings-view__field">
          <div className="settings-view__section-heading">
            <div>
              <h2>Context window</h2>
              <p>How much of this conversation the model can receive.</p>
            </div>
            <span>{state.config.contextSize.toLocaleString()} tokens</span>
          </div>
          <ToggleGroup
            aria-label="Context window"
            className="settings-view__toggle-group"
            onValueChange={changeContext}
            value={[String(state.config.contextSize)]}
          >
            {CONTEXT_OPTIONS.map((option) => (
              <ToggleGroupItem
                aria-label={option.label}
                className="settings-view__toggle"
                key={option.value}
                value={String(option.value)}
                variant="outline"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </section>

        <Separator className="settings-view__separator" />

        <section className="settings-view__range">
          <div className="settings-view__section-heading">
            <div>
              <h2 id="temperature-label">Temperature</h2>
              <p>Lower values answer more narrowly and consistently.</p>
            </div>
            <output>{state.config.temperature.toFixed(2)}</output>
          </div>
          <Slider
            aria-labelledby="temperature-label"
            className="settings-view__slider"
            max={1.5}
            min={0}
            onValueChange={(temperature) =>
              onConfigChange({
                temperature: singleSliderValue(temperature),
              })
            }
            step={0.05}
            thumbAlignment="center"
            value={[state.config.temperature]}
          />
        </section>

        <Separator className="settings-view__separator" />

        <section className="settings-view__range">
          <div className="settings-view__section-heading">
            <div>
              <h2 id="reply-ceiling-label">Reply ceiling</h2>
              <p>The most tokens Lys may spend on one reply.</p>
            </div>
            <output>{state.config.maxTokens}</output>
          </div>
          <Slider
            aria-labelledby="reply-ceiling-label"
            className="settings-view__slider"
            max={4096}
            min={256}
            onValueChange={(maxTokens) =>
              onConfigChange({ maxTokens: singleSliderValue(maxTokens) })
            }
            step={256}
            thumbAlignment="center"
            value={[state.config.maxTokens]}
          />
        </section>

        <Separator className="settings-view__separator" />

        <div className="settings-view__setting-row">
          <div>
            <h2>Streaming</h2>
            <p>Stream tokens</p>
          </div>
          <Switch
            aria-label="Stream tokens"
            checked={state.config.stream}
            className="settings-view__switch"
            onCheckedChange={(stream) => onConfigChange({ stream })}
          />
        </div>
      </div>

      <PaneFooter onDone={onDone} />
    </div>
  )
}

function ConversationPane({
  state,
  onConfigChange,
  onDone,
}: Pick<SettingsViewProps, "state" | "onConfigChange" | "onDone">) {
  function changeTrim(values: string[]) {
    const value = values[0]
    if (value === "drop" || value === "stop") {
      onConfigChange({ trim: value })
    }
  }

  return (
    <div className="settings-view__pane">
      <PaneHeading
        eyebrow="conversation policy"
        note="Decide what survives when the context window fills."
        title="Conversation"
      />

      <div className="settings-view__stack">
        <section className="settings-view__field">
          <div className="settings-view__section-heading">
            <div>
              <h2>When the context fills</h2>
              <p>Lys never hides which policy is active.</p>
            </div>
          </div>
          <ToggleGroup
            aria-label="Context trimming behavior"
            className="settings-view__choice-group"
            onValueChange={changeTrim}
            orientation="vertical"
            value={[state.config.trim]}
          >
            <ToggleGroupItem
              aria-label="Drop oldest turns"
              className="settings-view__choice"
              value="drop"
              variant="outline"
            >
              <span>
                <strong>Drop oldest turns</strong>
                <small>Keep the transcript, send only the recent window.</small>
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem
              aria-label="Stop and say so"
              className="settings-view__choice"
              value="stop"
              variant="outline"
            >
              <span>
                <strong>Stop and say so</strong>
                <small>Refuse the next request until context is cleared.</small>
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
        </section>

        <Separator className="settings-view__separator" />

        <section className="settings-view__field">
          <label htmlFor="lys-system-prompt">System prompt</label>
          <Textarea
            aria-label="System prompt"
            className="settings-view__textarea"
            id="lys-system-prompt"
            onChange={(event) =>
              onConfigChange({ systemPrompt: event.currentTarget.value })
            }
            rows={7}
            value={state.config.systemPrompt}
          />
          <p className="settings-view__note">
            This instruction is included before every conversation turn.
          </p>
        </section>
      </div>

      <PaneFooter onDone={onDone} />
    </div>
  )
}

export function SettingsView({
  state,
  onAutostartToggle,
  onConfigChange,
  onDone,
  onLoadModel,
  onPaneChange,
  onSelectModel,
  onStartBackend,
  onStopBackend,
  onUnloadModel,
}: SettingsViewProps) {
  return (
    <main aria-label="Settings" className="settings-view">
      <Tabs
        className="settings-view__tabs"
        onValueChange={(value) => onPaneChange(value as SettingsPane)}
        orientation="vertical"
        value={state.pane}
      >
        <TabsList
          aria-label="Settings sections"
          className="settings-view__rail"
          variant="line"
        >
          <div className="settings-view__rail-heading">
            <span>Settings</span>
            <small>local session</small>
          </div>
          {SETTINGS_PANES.map((pane) => (
            <TabsTrigger
              className="settings-view__rail-tab"
              key={pane.value}
              value={pane.value}
            >
              {pane.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="settings-view__content">
          <TabsContent value="runtime">
            <RuntimePane
              onAutostartToggle={onAutostartToggle}
              onDone={onDone}
              onLoadModel={onLoadModel}
              onStartBackend={onStartBackend}
              onStopBackend={onStopBackend}
              onUnloadModel={onUnloadModel}
              state={state}
            />
          </TabsContent>
          <TabsContent value="model">
            <ModelPane
              onConfigChange={onConfigChange}
              onDone={onDone}
              onSelectModel={onSelectModel}
              state={state}
            />
          </TabsContent>
          <TabsContent value="generation">
            <GenerationPane
              onConfigChange={onConfigChange}
              onDone={onDone}
              state={state}
            />
          </TabsContent>
          <TabsContent value="conversation">
            <ConversationPane
              onConfigChange={onConfigChange}
              onDone={onDone}
              state={state}
            />
          </TabsContent>
        </div>
      </Tabs>
    </main>
  )
}
