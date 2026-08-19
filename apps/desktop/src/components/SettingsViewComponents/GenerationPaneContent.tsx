import type { LysConfig } from "@/app/types"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useSettingsContext } from "./SettingsContext"

/** Supported context-window choices shown by the settings control. */
const CONTEXT_OPTIONS: ReadonlyArray<{
  /** Context-window capacity in tokens. */
  value: LysConfig["contextSize"]
  /** Compact display label for the capacity. */
  label: string
}> = [
  { value: 4096, label: "4k" },
  { value: 8192, label: "8k" },
  { value: 16384, label: "16k" },
  { value: 32768, label: "32k" }
]

/**
 * Normalizes a slider event to its first numeric value.
 *
 * @remarks Array inputs are expected to contain the slider's single value. An
 * empty array returns `undefined`; the current temperature and reply-ceiling
 * handlers forward that value without validation, so a later render can lose
 * numeric state and fail at the temperature output's `toFixed` call.
 *
 * @param value - Scalar or single-thumb values emitted by the slider.
 * @returns The scalar value, the first array value, or `undefined` for an empty
 * array.
 */
function singleSliderValue(value: number | readonly number[]) {
  return typeof value === "number" ? value : value[0]
}

/**
 * Presents context-window, sampling, reply-ceiling, and streaming controls.
 *
 * @remarks Primary category: composition/view. The required
 * `SettingsContext.Provider` owns the generation configuration and receives
 * synchronous patches from each control; this component owns no state,
 * effects, persistence, or resources. The context consumer throws when the
 * provider is absent. The context-window toggle forwards one patch for a
 * recognized option and ignores empty or unknown arrays. Temperature and
 * reply-ceiling sliders propose on every primitive change, including the
 * unvalidated empty-array result above; the stream switch proposes on every
 * checked change. No control exposes save or operation completion. Current
 * values are rendered in token or numeric units and slider labels are
 * associated with their outputs.
 *
 * @returns The generation settings controls.
 */
export default function GenerationPane() {
  const { state, onConfigChange } = useSettingsContext()

  /**
   * Proposes the selected context-window capacity to the settings owner.
   *
   * @param values - Selection values emitted by the toggle-group primitive.
   * @returns Nothing; a recognized option is forwarded once synchronously,
   * while empty or unknown selections are ignored.
   */
  function changeContext(values: string[]) {
    const selected = CONTEXT_OPTIONS.find(
      ({ value }) => String(value) === values[0]
    )
    if (selected) onConfigChange({ contextSize: selected.value })
  }

  return (
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
          max={1.5}
          min={0}
          onValueChange={(temperature) =>
            onConfigChange({
              temperature: singleSliderValue(temperature)
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
          onCheckedChange={(stream) => onConfigChange({ stream })}
        />
      </div>
    </div>
  )
}
