import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { LOCAL_MODEL_INVENTORY } from "@/lib/models/inventory"
import {
  formatModelRowTag,
  readLoadedModelKey,
  readModelRowTone
} from "@/lib/models/model-residency"
import { useLysStore } from "@/lib/store"
import { isModelTransitionInFlight } from "@/lib/store/model-runtime"

import { useSettingsContext } from "./SettingsContext"

/** Context-window sizes offered by the pane, in tokens. */
const CONTEXT_SIZE_OPTIONS: readonly number[] = [4096, 8192, 16_384, 32_768]

/**
 * Formats a context-window size as its compact selector label.
 *
 * @param contextSize - Window size in tokens.
 * @returns The label shown on the selector, such as `16k`.
 */
function formatContextSizeLabel(contextSize: number): string {
  return `${contextSize / 1024}k`
}

/**
 * Presents the model inventory, the default choice, and the load window.
 *
 * @remarks Primary category: composition/view. The settings context owns the
 * settings value, model residency, and every change request; this component
 * owns no state, effects, persistence, or resources, and throws when rendered
 * outside the provider. Choosing a row proposes a new default model; the
 * context-size selector proposes one patch for a recognized option and ignores
 * an empty or unknown selection.
 *
 * A row's Load and Unload drive the simulated residency the provider owns, and
 * every row withholds them while any transition is in flight, because only one
 * set of weights is resident at a time. Test stays disabled: no probe endpoint
 * exists. The design's "reload to apply" prompt is intentionally absent,
 * because nothing currently reports the window the resident weights were loaded
 * with, so the pane cannot honestly claim the two disagree.
 *
 * @returns The model inventory and load-configuration controls.
 */
export default function ModelPaneContent() {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const {
    settings,
    modelRuntime,
    onRuntimeChange,
    onModelChange,
    onLoadModel,
    onUnloadModel,
    onTestModel
  } = useSettingsContext()

  const defaultModel = settings.runtime.defaultModel
  const loadedModelKey = readLoadedModelKey(modelRuntime)
  const isTransitioning = isModelTransitionInFlight(modelRuntime)

  /**
   * Proposes the selected context-window size to the settings owner.
   *
   * @param values - Selection values emitted by the toggle-group primitive.
   */
  function handleContextSizeChange(values: string[]): void {
    const selected = CONTEXT_SIZE_OPTIONS.find(
      (option) => String(option) === values[0]
    )
    if (selected !== undefined) onModelChange({ contextSize: selected })
  }

  return (
    <div className="settings-view__stack">
      <section className="settings-view__section">
        <div className="settings-view__section-heading">
          <h2>model</h2>
          <span>one at a time</span>
        </div>

        <ul className="settings-view__model-list">
          {LOCAL_MODEL_INVENTORY.map((model) => {
            const isDefault = model.modelKey === defaultModel
            const isResident = model.modelKey === loadedModelKey

            return (
              <li
                className="settings-view__model-row"
                data-selected={isDefault ? "" : undefined}
                key={model.modelKey}
              >
                <button
                  aria-pressed={isDefault}
                  className="settings-view__model-choice"
                  onClick={() =>
                    onRuntimeChange({ defaultModel: model.modelKey })
                  }
                  title="Make this the default"
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="settings-view__status-dot settings-view__status-dot--small"
                    data-tone={readModelRowTone(modelRuntime, model.modelKey)}
                  />
                  <span className="settings-view__model-lines">
                    <span className="settings-view__model-name">
                      {model.modelKey}
                      {isDefault ? (
                        <span className="settings-view__model-default">
                          default
                        </span>
                      ) : null}
                    </span>
                    <span className="settings-view__model-detail">
                      {model.detail}
                    </span>
                  </span>
                  <span className="settings-view__model-tag">
                    {formatModelRowTag(modelRuntime, model)}
                  </span>
                </button>

                <div className="settings-view__model-actions">
                  <Button
                    disabled
                    onClick={() => onTestModel(model.modelKey)}
                    size="sm"
                    title="Only the loaded model can answer a test"
                    type="button"
                    variant="outline"
                  >
                    Test
                  </Button>
                  <Button
                    className="settings-view__model-act"
                    disabled={backendStatus !== "running" || isTransitioning}
                    onClick={() =>
                      isResident
                        ? onUnloadModel(model.modelKey)
                        : onLoadModel(model.modelKey)
                    }
                    size="sm"
                    type="button"
                    variant={isResident ? "outline" : "default"}
                  >
                    {isResident ? "Unload" : "Load"}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>

        <p className="settings-view__note">
          Choosing a row sets the default. Loading and unloading are simulated
          until the backend reports them; Test needs a probe endpoint that does
          not exist yet, so it stays disabled.
        </p>
      </section>

      <section className="settings-view__section">
        <div className="settings-view__section-heading">
          <h2>load configuration</h2>
          <span>read at load time</span>
        </div>

        <div className="settings-view__row">
          <div className="settings-view__identity-lines">
            <h3>Context size</h3>
            <p>How much room the weights are given, fixed when they load.</p>
          </div>
          <ToggleGroup
            aria-label="Context size"
            className="settings-view__segments"
            onValueChange={handleContextSizeChange}
            value={[String(settings.model.contextSize)]}
          >
            {CONTEXT_SIZE_OPTIONS.map((option) => (
              <ToggleGroupItem
                className="settings-view__segment"
                key={option}
                value={String(option)}
                variant="outline"
              >
                {formatContextSizeLabel(option)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </section>
    </div>
  )
}
