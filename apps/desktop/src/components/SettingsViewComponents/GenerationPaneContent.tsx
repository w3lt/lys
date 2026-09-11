import { useId, type ReactElement } from "react"
import { MAXIMUM_GENERATION_TEMPERATURE } from "@lys/protocol"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useLysStore } from "@/lib/store"
import { initialSettingsState } from "@/lib/store/settings"

import { useSettingsContext } from "./SettingsContext"

/** Temperature increment used by the slider. */
const TEMPERATURE_STEP = 0.05

/** Reply-ceiling increment used by the slider, in tokens. */
const REPLY_CEILING_STEP = 64

/**
 * Presents the API's inclusive sampling-temperature range.
 * @returns A keyboard-operable slider and its current numeric value.
 * @remarks Primary category: composition/view. SettingsContext owns the accepted
 * value; empty slider emissions are ignored. Changes apply to the next request.
 */
function GenerationTemperatureField(): ReactElement {
  const { settings, onGenerationChange } = useSettingsContext()
  const temperature = settings.generation.temperature
  const labelId = useId()
  return (
    <div className="settings-view__row">
      <div className="settings-view__identity-lines">
        <h2 id={labelId}>Temperature</h2>
        <p>Low is literal. High wanders.</p>
      </div>
      <div className="settings-view__slider-group">
        <Slider
          aria-labelledby={labelId}
          largeStep={TEMPERATURE_STEP * 2}
          max={MAXIMUM_GENERATION_TEMPERATURE}
          min={0}
          onValueChange={(emission) => {
            const next = typeof emission === "number" ? emission : emission[0]
            if (next !== undefined) onGenerationChange({ temperature: next })
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
  )
}

/**
 * Presents the reply ceiling's on/off control and optional token slider.
 * @returns A named switch and a ceiling slider only while the limit is enabled.
 * @remarks Primary category: composition/view. SettingsContext owns accepted
 * values. Switching off proposes zero, which omits the request limit; switching
 * on restores the application's default ceiling. Changes apply to future requests
 * and are saved by the application owner. Missing context fails explicitly.
 */
function GenerationReplyCeilingField(): ReactElement {
  const { settings, onGenerationChange } = useSettingsContext()
  const isCeilingEnabled = settings.generation.replyCeiling > 0
  const descriptionId = useId()
  return (
    <>
      <div className="settings-view__row">
        <div className="settings-view__identity-lines">
          <h2>Reply ceiling</h2>
          <p id={descriptionId}>
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
            aria-describedby={descriptionId}
            checked={isCeilingEnabled}
            onCheckedChange={(checked) =>
              onGenerationChange({
                replyCeiling: checked
                  ? initialSettingsState.generation.replyCeiling
                  : 0
              })
            }
            size="lg"
          />
        </div>
      </div>
      {isCeilingEnabled ? <GenerationReplyLimitField /> : null}
    </>
  )
}

/**
 * Edits an enabled reply ceiling in tokens through a keyboard-operable slider.
 * @returns The labeled ceiling slider and its accepted numeric value.
 * @remarks Primary category: composition/view. Requires SettingsContext and a
 * positive ceiling. The local context estimate sets the usual slider range;
 * existing ceilings outside that range remain visible without clamping. Actual
 * model capacity remains runtime-owned. Empty slider emissions are ignored.
 */
function GenerationReplyLimitField(): ReactElement {
  const { settings, onGenerationChange } = useSettingsContext()
  const replyCeiling = settings.generation.replyCeiling
  const minimumReplyCeiling = Math.min(REPLY_CEILING_STEP, replyCeiling)
  const maximumReplyCeiling = Math.max(
    REPLY_CEILING_STEP * 2,
    settings.model.contextSize,
    replyCeiling
  )
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div className="settings-view__row">
      <div className="settings-view__identity-lines">
        <h2 id={labelId}>Ceiling</h2>
        <p id={descriptionId}>
          A hard stop, in tokens. The model can stop earlier or reach its
          context limit.
        </p>
      </div>
      <div className="settings-view__slider-group">
        <Slider
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-valuetext={`${replyCeiling} tokens`}
          max={maximumReplyCeiling}
          min={minimumReplyCeiling}
          largeStep={REPLY_CEILING_STEP * 10}
          onValueChange={(emission) => {
            const next = typeof emission === "number" ? emission : emission[0]
            if (next !== undefined) onGenerationChange({ replyCeiling: next })
          }}
          step={REPLY_CEILING_STEP}
          thumbAlignment="center"
          value={[replyCeiling]}
        />
        <output className="settings-view__slider-value">{replyCeiling}</output>
      </div>
    </div>
  )
}

/**
 * Announces automatic persistence and offers recovery when a write fails.
 * @returns A persistent status region and a retry button only after failure.
 * @remarks Primary category: composition/view. The application store owns saves
 * across pane unmounts; failure leaves edits available and allows an explicit retry.
 */
function GenerationSaveFeedback(): ReactElement {
  const save = useLysStore((state) => state.generationSave)
  const saveGenerationSettings = useLysStore(
    (state) => state.saveGenerationSettings
  )
  const status =
    save.status === "saving"
      ? "Saving generation settings…"
      : save.status === "failed"
        ? "Could not save generation settings. Your edits still apply to upcoming messages in this session."
        : ""
  return (
    <div>
      <p
        aria-label="Generation settings save"
        className="settings-view__note"
        role="status"
      >
        {status}
      </p>
      {save.status === "failed" ? (
        <Button
          onClick={() => void saveGenerationSettings()}
          type="button"
          variant="outline"
        >
          Retry saving
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Composes generation controls with automatic persistence feedback.
 * @returns Temperature and optional reply-ceiling controls for future messages.
 * @remarks Primary category: composition/view. Requires SettingsContext and the
 * application store. Edits apply immediately and save only the generation group;
 * the store owns completion, errors, and coalescing of overlapping edits. Already
 * submitted messages retain their settings. No backend process is required.
 */
export default function GenerationPane(): ReactElement {
  return (
    <div className="settings-view__stack">
      <section className="settings-view__section">
        <GenerationTemperatureField />
        <GenerationReplyCeilingField />
      </section>
      <GenerationSaveFeedback />
    </div>
  )
}
