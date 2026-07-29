import { useState } from "react"
import { Input } from "../ui/input"
import { Button } from "../ui/button"
import { Separator } from "../ui/separator"
import { AppState } from "@/app/types"
import { MODEL_OPTIONS } from "@/app/content"

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

export default function ModelPane() {
  const [probeResult, setProbeResult] = useState("")

  function testConnection() {
    setProbeResult(
      state.runtime.backend === "running"
        ? `probe ok · ${state.config.endpoint}`
        : "probe failed · backend stopped"
    )
  }

  return (
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
          <Button onClick={testConnection} type="button" variant="outline">
            Test connection
          </Button>
        </div>
        <p aria-live="polite" className="settings-view__probe" role="status">
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
                variant="outline"
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
  )
}
