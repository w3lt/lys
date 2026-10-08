import { useId, type ReactElement } from "react"

import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { CALLS_PER_REPLY_OPTIONS, type CallsPerReply } from "@/lib/store/tools"

import {
  calculateToolCallsTone,
  findCallsPerReply,
  formatToolCallsStatus,
  type ToolCallsSummary
} from "./tool-presentation"

/** Properties accepted by {@link CallsPerReplyRow}. */
type CallsPerReplyRowProps = {
  /** Number of tool calls a reply may make, owned by the parent. */
  readonly callsPerReply: CallsPerReply
  /** Whether the row recedes because tool calls are off. */
  readonly isDimmed: boolean
  /** Whether the tool controls are locked. */
  readonly isLocked: boolean
  /** Proposes another number of calls per reply. */
  readonly onCallsPerReplyChange: (callsPerReply: CallsPerReply) => void
}

/**
 * Presents how many tools a reply may call, with a choice of 4, 8, or 16.
 *
 * @remarks The parent owns the number, the dimming, and the lock; the row owns
 * no state or effects. The number is a single-choice toggle group named by its
 * label and described by its note; pressing the selected number again proposes
 * nothing. The row recedes while tool calls are off but stays operable, and
 * the group is disabled while the controls are locked.
 * @param props - Number, dimming, lock, and the number proposal.
 * @returns The calls-per-reply row of the tool-calls card.
 */
function CallsPerReplyRow({
  callsPerReply,
  isDimmed,
  isLocked,
  onCallsPerReplyChange
}: CallsPerReplyRowProps): ReactElement {
  const callsLabelId = useId()
  const callsNoteId = useId()

  /**
   * Proposes the number of calls the toggle group selected.
   *
   * @param groupValue - Pressed item values the toggle group reports.
   */
  function handleCallsPerReplyValueChange(groupValue: string[]): void {
    const nextCallsPerReply = findCallsPerReply(groupValue)
    if (nextCallsPerReply !== undefined) {
      onCallsPerReplyChange(nextCallsPerReply)
    }
  }

  return (
    <div
      className="settings-view__card-row settings-view__tool-calls-row"
      data-dimmed={isDimmed ? "" : undefined}
    >
      <div className="settings-view__identity-lines">
        <h3 id={callsLabelId}>Calls per reply</h3>
        <p id={callsNoteId}>
          How many tools she may call before she has to answer. Stops a loop
          from running on.
        </p>
      </div>
      <ToggleGroup
        aria-describedby={callsNoteId}
        aria-labelledby={callsLabelId}
        disabled={isLocked}
        onValueChange={handleCallsPerReplyValueChange}
        size="sm"
        value={[String(callsPerReply)]}
        variant="outline"
      >
        {CALLS_PER_REPLY_OPTIONS.map((option) => (
          <ToggleGroupItem
            className="settings-view__tool-segment"
            key={option}
            value={String(option)}
          >
            {option}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** Properties accepted by {@link ToolCallsCard}. */
export type ToolCallsCardProps = {
  /** Switch state, model support, and the switched-on tools to describe. */
  readonly summary: ToolCallsSummary
  /** Number of tool calls a reply may make, owned by the parent. */
  readonly callsPerReply: CallsPerReply
  /** Whether the loaded model was not trained for tools, which locks the card. */
  readonly isLocked: boolean
  /** Proposes switching tool calls on or off. */
  readonly onAreToolCallsOnChange: (areToolCallsOn: boolean) => void
  /** Proposes another number of calls per reply. */
  readonly onCallsPerReplyChange: (callsPerReply: CallsPerReply) => void
}

/**
 * Presents the tool-calls switch, what agents are offered, and the number of
 * calls a reply may make.
 *
 * @remarks The parent owns every value and decides whether to accept each
 * proposal; the card owns no state or effects. The switch is named Tool calls
 * and described by the status line. Calls per reply recedes while tool calls
 * are off. While the card is locked, both controls are disabled.
 * @param props - Summary, calls per reply, lock, and the parent's proposals.
 * @returns The tool-calls card.
 */
export function ToolCallsCard({
  summary,
  callsPerReply,
  isLocked,
  onAreToolCallsOnChange,
  onCallsPerReplyChange
}: ToolCallsCardProps): ReactElement {
  const headingId = useId()
  const statusId = useId()
  const tone = calculateToolCallsTone(summary.areToolCallsOn, summary.support)

  return (
    <section aria-labelledby={headingId} className="settings-view__card">
      <div className="settings-view__card-row">
        <div className="settings-view__identity">
          <span
            aria-hidden="true"
            className="settings-view__status-dot"
            data-tone={tone}
          />
          <div className="settings-view__identity-lines">
            <h2 id={headingId}>
              {summary.areToolCallsOn ? "Tool calls on" : "Tool calls off"}
            </h2>
            <p
              className="settings-view__meta"
              data-tone={tone === "warning" ? tone : undefined}
              id={statusId}
            >
              {formatToolCallsStatus(summary)}
            </p>
          </div>
        </div>
        <div className="settings-view__toggle-state">
          {/* The switch already announces its state; this is for the eye. */}
          <span aria-hidden="true">
            {summary.areToolCallsOn ? "on" : "off"}
          </span>
          <Switch
            aria-describedby={statusId}
            aria-label="Tool calls"
            checked={summary.areToolCallsOn}
            disabled={isLocked}
            onCheckedChange={(checked) => onAreToolCallsOnChange(checked)}
            size="lg"
          />
        </div>
      </div>

      <div className="settings-view__card-divider" />

      <CallsPerReplyRow
        callsPerReply={callsPerReply}
        isDimmed={!summary.areToolCallsOn}
        isLocked={isLocked}
        onCallsPerReplyChange={onCallsPerReplyChange}
      />
    </section>
  )
}
