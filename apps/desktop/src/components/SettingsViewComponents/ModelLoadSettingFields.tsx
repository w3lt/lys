import {
  useId,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from "react"
import {
  MAXIMUM_MODEL_LOAD_SETTING_VALUE,
  type ModelLoadConfiguration
} from "@lys/share"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  calculateContextLength,
  calculateContextLengthStopIndex,
  EVAL_BATCH_SIZE_CHOICES,
  formatTokenCount,
  isUsableContextLimit,
  listContextLengthStops
} from "@/lib/models/model-load-configuration"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"

import {
  findLoadedSettingValue,
  formatContextLengthNote,
  type ModelReloadPrompt
} from "./model-load-presentation"

/**
 * Most digits a typed context length keeps: the digit count of the largest
 * value a load setting accepts.
 */
const MAXIMUM_TYPED_CONTEXT_LENGTH_DIGITS = String(
  MAXIMUM_MODEL_LOAD_SETTING_VALUE
).length

/** Properties accepted by {@link LoadSettingRow}. */
type LoadSettingRowProps = {
  /** Identifier given to the title, so the control can be labelled by it. */
  readonly titleId: string
  /** Name of the load setting. */
  readonly title: string
  /** Identifier given to the note, so the control can be described by it. */
  readonly noteId: string
  /** What the setting does. */
  readonly note: string
  /**
   * Value the model was loaded with, when it is known and differs from the
   * stored one; null otherwise.
   */
  readonly loadedValue: string | null
  /** The setting's control, rendered after the title and note. */
  readonly children: ReactNode
}

/**
 * Presents one load setting: its title, note, and control.
 *
 * @remarks Owns no state. The title is a level-three heading under the
 * section heading. A loaded value is shown beside the title as text, so the
 * difference does not depend on colour alone.
 * @param props - Title, note, loaded value, and the control to place.
 * @returns The setting's row.
 */
function LoadSettingRow({
  titleId,
  title,
  noteId,
  note,
  loadedValue,
  children
}: LoadSettingRowProps): ReactElement {
  return (
    <div className="settings-view__row">
      <div className="settings-view__identity-lines">
        <div className="settings-view__load-title">
          <h3 id={titleId}>{title}</h3>
          {loadedValue === null ? null : (
            <span className="settings-view__load-changed">
              loaded · {loadedValue}
            </span>
          )}
        </div>
        <p id={noteId}>{note}</p>
      </div>
      {children}
    </div>
  )
}

/** Properties accepted by {@link ContextLengthSlider}. */
type ContextLengthSliderProps = {
  /** Current context length, in tokens. */
  readonly contextLength: number
  /** Ascending context lengths the slider stops at; at least two. */
  readonly stops: readonly number[]
  /** Identifier of the element that names the slider. */
  readonly titleId: string
  /** Identifier of the element that describes the slider. */
  readonly noteId: string
  /**
   * Proposes a context length. Called once for each stop the thumb reaches.
   *
   * @param contextLength - Proposed context length, in tokens.
   */
  readonly onContextLengthChange: (contextLength: number) => void
}

/**
 * Presents the context length as a position among the model's stops.
 *
 * @remarks The parent owns the context length. A length between two stops is
 * shown at the lower one. The value text announces the length in tokens
 * rather than the position.
 * @param props - Current length, stops, labelling identifiers, and proposal.
 * @returns A keyboard-operable slider.
 */
function ContextLengthSlider({
  contextLength,
  stops,
  titleId,
  noteId,
  onContextLengthChange
}: ContextLengthSliderProps): ReactElement {
  /**
   * Proposes the stop the slider moved to.
   *
   * @param emission - Position or positions the slider reports.
   */
  function handleStopChange(emission: number | readonly number[]): void {
    const stopIndex = typeof emission === "number" ? emission : emission[0]
    const stop = stopIndex === undefined ? undefined : stops.at(stopIndex)
    if (stop !== undefined) onContextLengthChange(stop)
  }

  return (
    <Slider
      aria-describedby={noteId}
      aria-labelledby={titleId}
      aria-valuetext={`${contextLength.toLocaleString()} tokens`}
      max={stops.length - 1}
      min={0}
      onValueChange={handleStopChange}
      step={1}
      thumbAlignment="center"
      value={[calculateContextLengthStopIndex(stops, contextLength)]}
    />
  )
}

/** Properties accepted by {@link ContextLengthBox}. */
type ContextLengthBoxProps = {
  /** Current context length, in tokens. */
  readonly contextLength: number
  /** Maximum context length the runtime reports for the model. */
  readonly maxContextLength: number
  /** Identifier of the element that describes the box. */
  readonly noteId: string
  /**
   * Proposes a context length. Called once when a typed value that differs
   * from the current one is committed.
   *
   * @param contextLength - Proposed context length, in tokens, within the
   * accepted range.
   */
  readonly onContextLengthChange: (contextLength: number) => void
}

/**
 * Edits the context length as an exact number of tokens.
 *
 * @remarks Owns the text being typed; the parent owns the context length.
 * Only digits are kept. Enter or leaving the box commits the typed value,
 * kept within the accepted range; Escape drops it. An empty or zero value is
 * dropped. While nothing is being typed the box shows the parent's value.
 * @param props - Current length, the model's maximum, and the proposal.
 * @returns A labelled text box.
 */
function ContextLengthBox({
  contextLength,
  maxContextLength,
  noteId,
  onContextLengthChange
}: ContextLengthBoxProps): ReactElement {
  const [typedText, setTypedText] = useState<string | null>(null)

  /**
   * Keeps the digits of the typed text.
   *
   * @param event - Native change event of the box.
   */
  function handleContextLengthInput(
    event: ChangeEvent<HTMLInputElement>
  ): void {
    const digits = event.target.value.replace(/\D/g, "")
    setTypedText(digits.slice(0, MAXIMUM_TYPED_CONTEXT_LENGTH_DIGITS))
  }

  /** Ends the edit and proposes the typed value when it is a new length. */
  function handleContextLengthCommit(): void {
    if (typedText === null) return
    setTypedText(null)
    const typedTokens = Number.parseInt(typedText, 10)
    if (Number.isNaN(typedTokens) || typedTokens < 1) return
    const committed = calculateContextLength(typedTokens, maxContextLength)
    if (committed !== contextLength) onContextLengthChange(committed)
  }

  /**
   * Commits on Enter and drops the typed text on Escape.
   *
   * @param event - Native key event of the box.
   */
  function handleContextLengthKeyDown(
    event: KeyboardEvent<HTMLInputElement>
  ): void {
    if (event.key === "Enter") handleContextLengthCommit()
    if (event.key === "Escape") setTypedText(null)
  }

  return (
    <Input
      aria-describedby={noteId}
      aria-label="Context length in tokens"
      className="settings-view__load-box"
      inputMode="numeric"
      onBlur={handleContextLengthCommit}
      onChange={handleContextLengthInput}
      onKeyDown={handleContextLengthKeyDown}
      spellCheck={false}
      value={typedText ?? String(contextLength)}
    />
  )
}

/** Properties accepted by {@link ContextLengthField}. */
type ContextLengthFieldProps = {
  /** Key of the model being edited, named in the note. */
  readonly modelKey: string
  /** Current context length, in tokens. */
  readonly contextLength: number
  /** Maximum context length the runtime reports for the model. */
  readonly maxContextLength: number
  /** Loaded context length when it is known and differs; null otherwise. */
  readonly loadedValue: string | null
  /**
   * Proposes a context length.
   *
   * @param contextLength - Proposed context length, in tokens.
   */
  readonly onContextLengthChange: (contextLength: number) => void
}

/**
 * Presents the context length row: a slider over the model's stops, a box
 * for an exact value, and the model's maximum.
 *
 * @remarks The parent owns the context length. The slider is left out when
 * the model's maximum gives fewer than two stops, and the maximum is left out
 * when the runtime reports none that is usable.
 * @param props - Model key, current and maximum length, loaded value, and
 * proposal.
 * @returns The context length row.
 */
function ContextLengthField({
  modelKey,
  contextLength,
  maxContextLength,
  loadedValue,
  onContextLengthChange
}: ContextLengthFieldProps): ReactElement {
  const titleId = useId()
  const noteId = useId()
  const stops = listContextLengthStops(maxContextLength)
  const maximumText = isUsableContextLimit(maxContextLength)
    ? formatTokenCount(maxContextLength)
    : null
  return (
    <LoadSettingRow
      loadedValue={loadedValue}
      note={formatContextLengthNote(modelKey, maximumText)}
      noteId={noteId}
      title="Context length"
      titleId={titleId}
    >
      <div className="settings-view__load-control">
        {stops.length < 2 ? null : (
          <ContextLengthSlider
            contextLength={contextLength}
            noteId={noteId}
            onContextLengthChange={onContextLengthChange}
            stops={stops}
            titleId={titleId}
          />
        )}
        <ContextLengthBox
          contextLength={contextLength}
          maxContextLength={maxContextLength}
          noteId={noteId}
          onContextLengthChange={onContextLengthChange}
        />
        {maximumText === null ? null : (
          <span className="settings-view__load-max">max {maximumText}</span>
        )}
      </div>
    </LoadSettingRow>
  )
}

/** Properties accepted by {@link EvalBatchSizeField}. */
type EvalBatchSizeFieldProps = {
  /** Current eval batch size, in tokens. */
  readonly evalBatchSize: number
  /** Loaded batch size when it is known and differs; null otherwise. */
  readonly loadedValue: string | null
  /**
   * Proposes an eval batch size. Called once when a choice is pressed.
   *
   * @param evalBatchSize - One of the offered batch sizes, in tokens.
   */
  readonly onEvalBatchSizeChange: (evalBatchSize: number) => void
}

/**
 * Presents the eval batch size row as a choice among the offered sizes.
 *
 * @remarks The parent owns the batch size. A size outside the offered
 * choices presses none of them and is shown as custom text beside them.
 * @param props - Current batch size, loaded value, and proposal.
 * @returns The eval batch size row.
 */
function EvalBatchSizeField({
  evalBatchSize,
  loadedValue,
  onEvalBatchSizeChange
}: EvalBatchSizeFieldProps): ReactElement {
  const titleId = useId()
  const noteId = useId()

  /**
   * Proposes the batch size the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleBatchSizeValueChange(groupValue: string[]): void {
    const [choice] = groupValue
    if (choice !== undefined) onEvalBatchSizeChange(Number(choice))
  }

  return (
    <LoadSettingRow
      loadedValue={loadedValue}
      note="Prompt tokens read per pass. Bigger reads long prompts faster, and holds more memory doing it."
      noteId={noteId}
      title="Eval batch size"
      titleId={titleId}
    >
      <div className="settings-view__load-control">
        {EVAL_BATCH_SIZE_CHOICES.includes(evalBatchSize) ? null : (
          <span className="settings-view__meta">custom · {evalBatchSize}</span>
        )}
        <ToggleGroup
          aria-describedby={noteId}
          aria-labelledby={titleId}
          onValueChange={handleBatchSizeValueChange}
          size="sm"
          value={[String(evalBatchSize)]}
          variant="outline"
        >
          {EVAL_BATCH_SIZE_CHOICES.map((choice) => (
            <ToggleGroupItem
              className="settings-view__load-segment"
              key={choice}
              value={String(choice)}
            >
              {choice}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </LoadSettingRow>
  )
}

/** Properties accepted by {@link LoadSwitchField}. */
type LoadSwitchFieldProps = {
  /** Name of the load setting. */
  readonly title: string
  /** What the setting does in its current state. */
  readonly note: string
  /** Whether the setting is on. */
  readonly isEnabled: boolean
  /** Loaded state when it is known and differs; null otherwise. */
  readonly loadedValue: string | null
  /**
   * Proposes the other state. Called once when the switch is operated.
   *
   * @param isEnabled - Proposed state.
   */
  readonly onIsEnabledChange: (isEnabled: boolean) => void
}

/**
 * Presents an on/off load setting row.
 *
 * @remarks The parent owns the state. The switch announces its own state;
 * the visible on/off text is for the eye and hidden from assistive
 * technology.
 * @param props - Title, note, current state, loaded value, and proposal.
 * @returns The setting's row.
 */
function LoadSwitchField({
  title,
  note,
  isEnabled,
  loadedValue,
  onIsEnabledChange
}: LoadSwitchFieldProps): ReactElement {
  const titleId = useId()
  const noteId = useId()
  return (
    <LoadSettingRow
      loadedValue={loadedValue}
      note={note}
      noteId={noteId}
      title={title}
      titleId={titleId}
    >
      <div className="settings-view__toggle-state">
        <span aria-hidden="true">{isEnabled ? "on" : "off"}</span>
        <Switch
          aria-describedby={noteId}
          aria-labelledby={titleId}
          checked={isEnabled}
          onCheckedChange={onIsEnabledChange}
          size="lg"
        />
      </div>
    </LoadSettingRow>
  )
}

/** Properties accepted by {@link ExpertCountField}. */
type ExpertCountFieldProps = {
  /** Experts active per token, or null while the count is left to the model. */
  readonly expertCount: number | null
  /**
   * Whether stepping below one expert leaves the count to the model. False
   * when the default sets a count, in the settings file or in the committed
   * default, because removing the model's own count would then apply that
   * count instead.
   */
  readonly isAutomaticCountAvailable: boolean
  /** Loaded expert count when it is known and differs; null otherwise. */
  readonly loadedValue: string | null
  /**
   * Proposes an expert count. Called once for each step.
   *
   * @param expertCount - Proposed count of at least one.
   */
  readonly onExpertCountChange: (expertCount: number) => void
  /** Requests that the model's own expert count be removed. */
  readonly onRemoveExpertCount: () => void
}

/**
 * Presents the active experts row as a stepper.
 *
 * @remarks The parent owns the count. An unset count reads `auto`; stepping
 * up from it proposes one expert, and stepping down from one expert asks for
 * the count to be removed when that leaves it to the model. The step-down
 * button is disabled when no lower state exists, and the step-up button at
 * the largest accepted count.
 * @param props - Current count, whether auto is reachable, loaded value, and
 * the two actions.
 * @returns The active experts row.
 */
function ExpertCountField({
  expertCount,
  isAutomaticCountAvailable,
  loadedValue,
  onExpertCountChange,
  onRemoveExpertCount
}: ExpertCountFieldProps): ReactElement {
  const titleId = useId()
  const noteId = useId()
  const isLowestCount = expertCount === 1 && !isAutomaticCountAvailable

  /** Steps down one expert, or asks to remove the count below one. */
  function handleFewerExpertsClick(): void {
    if (expertCount === null) return
    if (expertCount === 1) {
      onRemoveExpertCount()
      return
    }
    onExpertCountChange(expertCount - 1)
  }

  return (
    <LoadSettingRow
      loadedValue={loadedValue}
      note="Experts each token is routed through. Only mixture-of-experts models use this; auto leaves the count to the model."
      noteId={noteId}
      title="Active experts"
      titleId={titleId}
    >
      <div className="settings-view__load-stepper">
        <Button
          aria-describedby={noteId}
          aria-label="Fewer experts"
          disabled={expertCount === null || isLowestCount}
          onClick={handleFewerExpertsClick}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          −
        </Button>
        <output aria-labelledby={titleId}>{expertCount ?? "auto"}</output>
        <Button
          aria-describedby={noteId}
          aria-label="More experts"
          disabled={expertCount === MAXIMUM_MODEL_LOAD_SETTING_VALUE}
          onClick={() => onExpertCountChange((expertCount ?? 0) + 1)}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          +
        </Button>
      </div>
    </LoadSettingRow>
  )
}

/** Properties accepted by {@link ModelLoadSettingFields}. */
export type ModelLoadSettingFieldsProps = {
  /** Key of the model being edited. */
  readonly modelKey: string
  /** Maximum context length the runtime reports for the model. */
  readonly maxContextLength: number
  /** Configuration the model would be loaded with now. */
  readonly configuration: CompleteModelLoadConfiguration
  /** Whether removing the model's own expert count leaves it to the model. */
  readonly isAutomaticExpertCountAvailable: boolean
  /** Current reload prompt, whose differences mark the changed rows; null for none. */
  readonly reloadPrompt: ModelReloadPrompt | null
  /**
   * Requests that settings be assigned to a model. Called once per edit.
   *
   * @param modelKey - Key of the model being edited.
   * @param settings - Settings to assign; the others keep their values.
   */
  readonly onAssignModelLoadSettings: (
    modelKey: string,
    settings: ModelLoadConfiguration
  ) => void
  /**
   * Requests that a model's own expert count be removed.
   *
   * @param modelKey - Key of the model being edited.
   */
  readonly onRemoveModelExpertCount: (modelKey: string) => void
}

/**
 * Presents the five load settings of one model, in the pane's order.
 *
 * @remarks The parent owns the configuration and applies every proposal; the
 * rows render the supplied values until it supplies new ones. Each row whose
 * loaded value is known and differs shows that value.
 * @param props - Model facts, current configuration, reload prompt, and the
 * two actions.
 * @returns The context length, eval batch size, flash attention, KV cache,
 * and active experts rows.
 */
export default function ModelLoadSettingFields({
  modelKey,
  maxContextLength,
  configuration,
  isAutomaticExpertCountAvailable,
  reloadPrompt,
  onAssignModelLoadSettings,
  onRemoveModelExpertCount
}: ModelLoadSettingFieldsProps): ReactElement {
  return (
    <>
      <ContextLengthField
        contextLength={configuration.contextLength}
        loadedValue={findLoadedSettingValue(reloadPrompt, "contextLength")}
        maxContextLength={maxContextLength}
        modelKey={modelKey}
        onContextLengthChange={(contextLength) =>
          onAssignModelLoadSettings(modelKey, { contextLength })
        }
      />
      <EvalBatchSizeField
        evalBatchSize={configuration.evalBatchSize}
        loadedValue={findLoadedSettingValue(reloadPrompt, "evalBatchSize")}
        onEvalBatchSizeChange={(evalBatchSize) =>
          onAssignModelLoadSettings(modelKey, { evalBatchSize })
        }
      />
      <LoadSwitchField
        isEnabled={configuration.flashAttention}
        loadedValue={findLoadedSettingValue(reloadPrompt, "flashAttention")}
        note="Leaner attention math. Usually less memory and faster replies."
        onIsEnabledChange={(flashAttention) =>
          onAssignModelLoadSettings(modelKey, { flashAttention })
        }
        title="Flash attention"
      />
      <LoadSwitchField
        isEnabled={configuration.offloadKVCacheToGpu}
        loadedValue={findLoadedSettingValue(
          reloadPrompt,
          "offloadKVCacheToGpu"
        )}
        note={formatKvCacheNote(configuration.offloadKVCacheToGpu)}
        onIsEnabledChange={(offloadKVCacheToGpu) =>
          onAssignModelLoadSettings(modelKey, { offloadKVCacheToGpu })
        }
        title="KV cache on GPU"
      />
      <ExpertCountField
        expertCount={configuration.numExperts ?? null}
        isAutomaticCountAvailable={isAutomaticExpertCountAvailable}
        loadedValue={findLoadedSettingValue(reloadPrompt, "numExperts")}
        onExpertCountChange={(numExperts) =>
          onAssignModelLoadSettings(modelKey, { numExperts })
        }
        onRemoveExpertCount={() => onRemoveModelExpertCount(modelKey)}
      />
    </>
  )
}

/**
 * Formats the note of the KV cache row for its current state.
 *
 * @param isKvCacheOnGpu - Whether the KV cache is kept in GPU memory.
 * @returns What the current placement costs and what the other would change.
 */
function formatKvCacheNote(isKvCacheOnGpu: boolean): string {
  return isKvCacheOnGpu
    ? "The attention cache sits in GPU memory. Off moves it to RAM: frees GPU memory, slows every token."
    : "In RAM. GPU memory goes to the weights instead, and every token is a little slower."
}
