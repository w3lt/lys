import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"

import { useSettingsContext } from "./SettingsContext"

/**
 * Highest selectable temperature.
 *
 * @remarks The persisted contract validates temperature over the half-open
 * interval `[0, 1)` and rejects `1.0`, so the slider stops one step short.
 */
const MAXIMUM_TEMPERATURE = 0.95

/** Temperature increment used by the slider. */
const TEMPERATURE_STEP = 0.05

/** Reply-ceiling increment used by the slider, in tokens. */
const REPLY_CEILING_STEP = 64

/**
 * Ceiling restored when the reply ceiling is switched back on, in tokens.
 *
 * @remarks Matches the persisted default, so re-enabling the ceiling returns to
 * the value a first run would have had.
 */
const DEFAULT_REPLY_CEILING = 2048

/**
 * Reads the first value emitted by a single-thumb slider.
 *
 * @param value - Scalar or single-thumb values emitted by the slider.
 * @returns The scalar value, or `undefined` for an empty array.
 */
function readSliderValue(
  value: number | readonly number[]
): number | undefined {
  return typeof value === "number" ? value : value[0]
}

/**
 * Presents the sampling temperature and the reply-length ceiling.
 *
 * @remarks Primary category: composition/view. The settings context owns the
 * generation settings and receives one patch per control change; this component
 * owns no state, effects, persistence, or resources, and throws when rendered
 * outside the provider. Both sliders ignore an empty emission rather than
 * proposing an undefined value.
 *
 * A reply ceiling of zero represents "no ceiling", because the persisted
 * contract carries a single numeric field and no separate switch; turning the
 * ceiling off writes zero, and turning it on restores
 * {@link DEFAULT_REPLY_CEILING}. The ceiling cannot exceed the configured
 * context window, since the reply has to fit inside it.
 *
 * @returns The generation settings controls.
 */
export default function GenerationPaneContent() {
  const { settings, onGenerationChange } = useSettingsContext()
  const { temperature, replyCeiling } = settings.generation
  const isCeilingEnabled = replyCeiling > 0
  const maximumReplyCeiling = settings.model.contextSize

  return (
    <div className="settings-view__stack">
      <section className="settings-view__section">
        <div className="settings-view__row">
          <div className="settings-view__identity-lines">
            <h2 id="settings-temperature">Temperature</h2>
            <p>Low is literal. High wanders.</p>
          </div>
          <div className="settings-view__slider-group">
            <Slider
              aria-labelledby="settings-temperature"
              max={MAXIMUM_TEMPERATURE}
              min={0}
              onValueChange={(value) => {
                const next = readSliderValue(value)
                if (next !== undefined)
                  onGenerationChange({ temperature: next })
              }}
              step={TEMPERATURE_STEP}
              thumbAlignment="center"
              value={[temperature]}
            />
            <output className="settings-view__slider-value">
              {temperature.toFixed(2)}
            </output>
          </div>
        </div>

        <div className="settings-view__row">
          <div className="settings-view__identity-lines">
            <h2>Reply ceiling</h2>
            <p>
              {isCeilingEnabled
                ? "A hard stop, in tokens. Off lets her run until she is done."
                : "Off. She writes until she stops on her own."}
            </p>
          </div>
          <div className="settings-view__toggle-state">
            {/* The switch already announces its state; this is for the eye. */}
            <span aria-hidden="true">{isCeilingEnabled ? "on" : "off"}</span>
            <Switch
              aria-label="Reply ceiling"
              checked={isCeilingEnabled}
              onCheckedChange={(checked) =>
                onGenerationChange({
                  replyCeiling: checked ? DEFAULT_REPLY_CEILING : 0
                })
              }
              size="lg"
            />
          </div>
        </div>

        {isCeilingEnabled ? (
          <div className="settings-view__row">
            <div className="settings-view__identity-lines">
              <h2 id="settings-ceiling">Ceiling</h2>
              <p>
                At most {maximumReplyCeiling.toLocaleString()} tokens, the size
                of the window it has to fit in.
              </p>
            </div>
            <div className="settings-view__slider-group">
              <Slider
                aria-labelledby="settings-ceiling"
                max={maximumReplyCeiling}
                min={REPLY_CEILING_STEP}
                onValueChange={(value) => {
                  const next = readSliderValue(value)
                  if (next !== undefined) {
                    onGenerationChange({ replyCeiling: next })
                  }
                }}
                step={REPLY_CEILING_STEP}
                thumbAlignment="center"
                value={[Math.min(replyCeiling, maximumReplyCeiling)]}
              />
              <output className="settings-view__slider-value">
                {replyCeiling}
              </output>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
