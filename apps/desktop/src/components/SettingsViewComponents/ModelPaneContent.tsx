import { useState } from "react"
import { Input } from "../ui/input"
import { Button } from "../ui/button"
import { Separator } from "../ui/separator"
import { MODEL_OPTIONS } from "@/app/content"
import { useSettingsContext } from "./SettingsContext"

/**
 * Presents the endpoint field, prototype connection probe, and model choices.
 *
 * @remarks Primary category: composition/view. The required
 * `SettingsContext.Provider` owns the endpoint and selected model and receives
 * synchronous changes/selections from this component. The endpoint input
 * proposes a patch on every primitive change, and each model button requests
 * selection once per activation; neither exposes save or operation completion.
 * The component owns only transient probe text, which resets when its view
 * identity is remounted. The local probe synchronously presents either
 * `probe ok · <endpoint>` or `probe failed · backend stopped`; it performs no
 * network request and has no asynchronous/network failure state. The context
 * consumer throws when the provider is absent. Controls use labels, pressed
 * state, and a polite status region.
 *
 * @returns The model endpoint and model-selection controls.
 */
export default function ModelPane() {
  const [probeResult, setProbeResult] = useState("")
  const { state, onConfigChange, onSelectModel } = useSettingsContext()

  /**
   * Updates the local probe status without contacting the configured endpoint.
   *
   * @returns Nothing; the transient status is committed to component state.
   */
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
