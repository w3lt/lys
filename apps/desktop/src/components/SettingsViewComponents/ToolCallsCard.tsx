import { useId, type ReactElement } from "react"

import { Switch } from "@/components/ui/switch"

import {
  calculateToolCallsTone,
  formatToolCallsStatus,
  type ToolCallsSummary
} from "./tool-presentation"

/** Properties accepted by {@link ToolCallsCard}. */
export type ToolCallsCardProps = {
  /** Switch state, model support, and the switched-on tools to describe. */
  readonly summary: ToolCallsSummary
  /** Whether the loaded model was not trained for tools, which locks the card. */
  readonly isLocked: boolean
  /** Proposes switching tool calls on or off. */
  readonly onAreToolCallsOnChange: (areToolCallsOn: boolean) => void
}

/**
 * Presents the tool-calls switch and what agents are offered.
 *
 * @remarks The parent owns every value and decides whether to accept the
 * proposal; the card owns no state or effects. The switch is named Tool calls
 * and described by the status line. While the card is locked, the switch is
 * disabled.
 * @param props - Summary, lock, and the parent's proposal.
 * @returns The tool-calls card.
 */
export function ToolCallsCard({
  summary,
  isLocked,
  onAreToolCallsOnChange
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
    </section>
  )
}
