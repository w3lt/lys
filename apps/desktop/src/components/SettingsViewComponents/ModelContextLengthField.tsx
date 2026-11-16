import { useId, type ReactElement } from "react"

import { Slider } from "@/components/ui/slider"
import {
  calculateContextLengthStopIndex,
  formatTokenCount,
  listContextLengthStops
} from "@/lib/models/model-load-configuration"

import { formatContextTokens } from "./model-pane-presentation"

/** Properties accepted by {@link ModelContextLengthField}. */
export type ModelContextLengthFieldProps = {
  /** Context length shown, in tokens. */
  readonly contextLength: number
  /** Maximum context length the provider reports for the model. */
  readonly maxContextLength: number
  /** What the length is measured against, or why it cannot be changed. */
  readonly note: string
  /**
   * Proposes a context length, called once for each stop the thumb reaches;
   * null shows the length without letting it be changed.
   *
   * @param contextLength - Proposed length in tokens: one of the slider's
   * stops, so never above the model's maximum.
   */
  readonly onContextLengthChange: ((contextLength: number) => void) | null
}

/**
 * Edits a model's context length on a slider over the model's stops.
 *
 * @remarks The parent owns the length; the slider
 * proposes the stop it moves to, which never exceeds the model's maximum,
 * and shows a length between two stops at the lower one. The exact length
 * is shown in tokens beside the label and announced as the slider's value
 * text, and each stop is labelled under the track; the labels are hidden
 * from assistive technology, which reads the value text. The label names the slider and the
 * note describes it. Without a change callback the slider is disabled. A
 * model whose maximum gives fewer than two stops shows only the length.
 * @param props - Shown length, the model's maximum, the note, and the
 * proposal.
 * @returns The labelled length, the slider with its stop labels, and the
 * note.
 */
export default function ModelContextLengthField({
  contextLength,
  maxContextLength,
  note,
  onContextLengthChange
}: ModelContextLengthFieldProps): ReactElement {
  const labelId = useId()
  const noteId = useId()
  const stops = listContextLengthStops(maxContextLength)

  /**
   * Proposes the stop the slider moved to.
   *
   * @param emission - Position or positions the slider reports.
   */
  function handleStopChange(emission: number | readonly number[]): void {
    const stopIndex = typeof emission === "number" ? emission : emission[0]
    const stop = stopIndex === undefined ? undefined : stops.at(stopIndex)
    if (stop === undefined || onContextLengthChange === null) return
    onContextLengthChange(stop)
  }

  return (
    <div className="settings-view__models-context">
      <div className="settings-view__models-context-heading">
        <span id={labelId}>Context length</span>
        <span className="settings-view__models-mono">
          {formatContextTokens(contextLength)}
        </span>
      </div>
      {stops.length < 2 ? null : (
        <div className="settings-view__models-context-track">
          <Slider
            aria-describedby={noteId}
            aria-labelledby={labelId}
            aria-valuetext={formatContextTokens(contextLength)}
            disabled={onContextLengthChange === null}
            max={stops.length - 1}
            min={0}
            onValueChange={handleStopChange}
            step={1}
            thumbAlignment="center"
            value={[calculateContextLengthStopIndex(stops, contextLength)]}
          />
          <ol aria-hidden="true" className="settings-view__models-ticks">
            {stops.map((stop, index) => (
              <li
                key={stop}
                style={{ left: `${(index / (stops.length - 1)) * 100}%` }}
              >
                {formatTokenCount(stop)}
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="settings-view__models-note" id={noteId}>
        {note}
      </p>
    </div>
  )
}
