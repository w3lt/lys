import {
  useId,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode
} from "react"
import {
  MAXIMUM_MODEL_LOAD_SETTING_VALUE,
  type ModelLoadConfiguration
} from "@lys/share"
import { Minus, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"

import ModelContextLengthField from "./ModelContextLengthField"
import {
  MAXIMUM_EVAL_BATCH_SIZE,
  MEASURED_CONTEXT_NOTE,
  parseEvalBatchSize
} from "./model-load-presentation"

/** Note under the evaluation batch size while the typed size is accepted. */
const EVAL_BATCH_SIZE_NOTE =
  "Prompt tokens read at once. Larger is faster and uses more memory."

/** Note under the evaluation batch size while the typed size is not accepted. */
const EVAL_BATCH_SIZE_ERROR = `Enter a whole number from 1 to ${MAXIMUM_EVAL_BATCH_SIZE.toLocaleString("en-US")}.`

/** Properties accepted by {@link LoadSettingRow}. */
type LoadSettingRowProps = {
  /** Identifier given to the label, so the control can be named by it. */
  readonly labelId: string
  /** Name of the load setting. */
  readonly label: string
  /** Identifier given to the note, so the control can be described by it. */
  readonly noteId: string
  /** What the setting does, or what is wrong with the typed value. */
  readonly note: string
  /** Whether the note reports a value that is not accepted. */
  readonly isNoteError: boolean
  /** The setting's control, placed after the label and note. */
  readonly children: ReactNode
}

/**
 * Presents one load setting: its label, note, and control.
 *
 * @remarks Owns no state. A note reporting an error is marked by its data
 * attribute and states the problem in words, so it does not rely on colour.
 * @param props - Label, note, and the control to place.
 * @returns The setting's row.
 */
function LoadSettingRow({
  labelId,
  label,
  noteId,
  note,
  isNoteError,
  children
}: LoadSettingRowProps): ReactElement {
  return (
    <div className="settings-view__models-setting">
      <div className="settings-view__models-setting-lines">
        <span id={labelId}>{label}</span>
        <p data-error={isNoteError ? "" : undefined} id={noteId}>
          {note}
        </p>
      </div>
      {children}
    </div>
  )
}

/** Properties accepted by {@link EvalBatchSizeField}. */
type EvalBatchSizeFieldProps = {
  /** Current evaluation batch size, in tokens. */
  readonly evalBatchSize: number
  /**
   * Proposes an evaluation batch size, called once for each accepted
   * change of the typed text.
   *
   * @param evalBatchSize - Proposed size, a whole number from 1 to
   * {@link MAXIMUM_EVAL_BATCH_SIZE}.
   */
  readonly onEvalBatchSizeChange: (evalBatchSize: number) => void
}

/**
 * Edits the evaluation batch size as a number of tokens.
 *
 * @remarks Owns the text while it is not an accepted size; the parent owns
 * the size. Each change to an accepted size is proposed at once and the box
 * shows the parent's size again. Text that is not a whole number from 1 to
 * {@link MAXIMUM_EVAL_BATCH_SIZE} stays in the box, is not proposed, marks
 * the box invalid, and replaces the note with what to enter, which the box
 * is described by.
 * @param props - Current size and the proposal.
 * @returns The evaluation batch size row.
 */
function EvalBatchSizeField({
  evalBatchSize,
  onEvalBatchSizeChange
}: EvalBatchSizeFieldProps): ReactElement {
  const labelId = useId()
  const noteId = useId()
  const [rejectedText, setRejectedText] = useState<string | null>(null)

  /**
   * Proposes the typed size when it is accepted, else keeps the text.
   *
   * @param event - Native change event of the box.
   */
  function handleBatchSizeInput(event: ChangeEvent<HTMLInputElement>): void {
    const size = parseEvalBatchSize(event.target.value)
    setRejectedText(size === null ? event.target.value : null)
    if (size !== null) onEvalBatchSizeChange(size)
  }

  return (
    <LoadSettingRow
      isNoteError={rejectedText !== null}
      label="Evaluation batch size"
      labelId={labelId}
      note={
        rejectedText === null ? EVAL_BATCH_SIZE_NOTE : EVAL_BATCH_SIZE_ERROR
      }
      noteId={noteId}
    >
      <div className="settings-view__models-setting-control">
        <Input
          aria-describedby={noteId}
          aria-invalid={rejectedText !== null}
          aria-labelledby={labelId}
          className="settings-view__models-number"
          inputMode="numeric"
          max={MAXIMUM_EVAL_BATCH_SIZE}
          min={1}
          onChange={handleBatchSizeInput}
          step={1}
          type="number"
          value={rejectedText ?? String(evalBatchSize)}
        />
        <span>tokens</span>
      </div>
    </LoadSettingRow>
  )
}

/** Properties accepted by {@link LoadSwitchField}. */
type LoadSwitchFieldProps = {
  /** Name of the load setting. */
  readonly label: string
  /** What the setting does. */
  readonly note: string
  /** Whether the setting is on. */
  readonly isEnabled: boolean
  /**
   * Proposes the other state, called once when the switch is operated.
   *
   * @param isEnabled - Proposed state.
   */
  readonly onIsEnabledChange: (isEnabled: boolean) => void
}

/**
 * Presents an on/off load setting row.
 *
 * @remarks The parent owns the state. The switch announces its own state;
 * the visible On/Off word is for the eye and hidden from assistive
 * technology.
 * @param props - Label, note, current state, and the proposal.
 * @returns The setting's row.
 */
function LoadSwitchField({
  label,
  note,
  isEnabled,
  onIsEnabledChange
}: LoadSwitchFieldProps): ReactElement {
  const labelId = useId()
  const noteId = useId()
  return (
    <LoadSettingRow
      isNoteError={false}
      label={label}
      labelId={labelId}
      note={note}
      noteId={noteId}
    >
      <div className="settings-view__models-setting-control">
        <span aria-hidden="true">{isEnabled ? "On" : "Off"}</span>
        <Switch
          aria-describedby={noteId}
          aria-labelledby={labelId}
          checked={isEnabled}
          onCheckedChange={onIsEnabledChange}
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
  /**
   * Proposes an expert count, called once for each step.
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
 * @remarks The parent owns the count. An unset count reads Auto; stepping
 * up from it proposes one expert, and stepping down from one expert asks for
 * the count to be removed when that leaves it to the model. The step-down
 * button is disabled when no lower state exists, and the step-up button at
 * the largest accepted count. The count is a live region named by the
 * label, so a step is announced.
 * @param props - Current count, whether Auto is reachable, and the two
 * actions.
 * @returns The active experts row.
 */
function ExpertCountField({
  expertCount,
  isAutomaticCountAvailable,
  onExpertCountChange,
  onRemoveExpertCount
}: ExpertCountFieldProps): ReactElement {
  const labelId = useId()
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
      isNoteError={false}
      label="Active experts"
      labelId={labelId}
      note="Experts the model uses for each token. Fewer is faster; Auto leaves the count to the model."
      noteId={noteId}
    >
      <div
        aria-labelledby={labelId}
        className="settings-view__models-stepper"
        role="group"
      >
        <Button
          aria-describedby={noteId}
          aria-label="Fewer experts"
          disabled={expertCount === null || isLowestCount}
          onClick={handleFewerExpertsClick}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Minus aria-hidden="true" />
        </Button>
        <output aria-labelledby={labelId} aria-live="polite">
          {expertCount ?? "Auto"}
        </output>
        <Button
          aria-describedby={noteId}
          aria-label="More experts"
          disabled={expertCount === MAXIMUM_MODEL_LOAD_SETTING_VALUE}
          onClick={() => onExpertCountChange((expertCount ?? 0) + 1)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </LoadSettingRow>
  )
}

/** Properties accepted by {@link ModelLoadSettingFields}. */
export type ModelLoadSettingFieldsProps = {
  /** Key of the model being edited. */
  readonly modelKey: string
  /** Maximum context length the provider reports for the model. */
  readonly maxContextLength: number
  /** Configuration the model would be loaded with now. */
  readonly configuration: CompleteModelLoadConfiguration
  /** Whether removing the model's own expert count leaves it to the model. */
  readonly isAutomaticExpertCountAvailable: boolean
  /**
   * Requests that settings be assigned to a model, called once per edit.
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
 * Edits the five load settings LM Studio applies when it loads one model.
 *
 * @remarks The parent owns the configuration and
 * applies every proposal; the rows render the supplied values until it
 * supplies new ones.
 * @param props - Model facts, current configuration, and the two actions.
 * @returns The context length, then the evaluation batch size, flash
 * attention, KV cache, and active experts rows.
 */
export default function ModelLoadSettingFields({
  modelKey,
  maxContextLength,
  configuration,
  isAutomaticExpertCountAvailable,
  onAssignModelLoadSettings,
  onRemoveModelExpertCount
}: ModelLoadSettingFieldsProps): ReactElement {
  return (
    <>
      <ModelContextLengthField
        contextLength={configuration.contextLength}
        maxContextLength={maxContextLength}
        note={MEASURED_CONTEXT_NOTE}
        onContextLengthChange={(contextLength) =>
          onAssignModelLoadSettings(modelKey, { contextLength })
        }
      />
      <div className="settings-view__models-settings">
        <EvalBatchSizeField
          evalBatchSize={configuration.evalBatchSize}
          onEvalBatchSizeChange={(evalBatchSize) =>
            onAssignModelLoadSettings(modelKey, { evalBatchSize })
          }
        />
        <LoadSwitchField
          isEnabled={configuration.flashAttention}
          label="Flash attention"
          note="Faster attention that uses less memory, on models that support it."
          onIsEnabledChange={(flashAttention) =>
            onAssignModelLoadSettings(modelKey, { flashAttention })
          }
        />
        <LoadSwitchField
          isEnabled={configuration.offloadKVCacheToGpu}
          label="KV cache on GPU"
          note="Keeps the context cache in GPU memory. Faster, but it uses VRAM."
          onIsEnabledChange={(offloadKVCacheToGpu) =>
            onAssignModelLoadSettings(modelKey, { offloadKVCacheToGpu })
          }
        />
        <ExpertCountField
          expertCount={configuration.numExperts ?? null}
          isAutomaticCountAvailable={isAutomaticExpertCountAvailable}
          onExpertCountChange={(numExperts) =>
            onAssignModelLoadSettings(modelKey, { numExperts })
          }
          onRemoveExpertCount={() => onRemoveModelExpertCount(modelKey)}
        />
      </div>
    </>
  )
}
