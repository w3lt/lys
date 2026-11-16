import { useId, type ReactElement } from "react"

import { Switch } from "@/components/ui/switch"

import {
  calculateToolCallsTone,
  formatToolCallsStatus,
  formatToolContextUse,
  type ToolCallsSummary,
  type ToolContextUse
} from "./tool-presentation"

/** Properties accepted by {@link ToolCallsCard}. */
export type ToolCallsCardProps = {
  /** Switch state, model support, and the switched-on tools to describe. */
  readonly summary: ToolCallsSummary
  /** Whether the loaded model was not trained for tools, which locks the card. */
  readonly isLocked: boolean
  /** Proposes switching tool calls on or off. */
  readonly onAreToolCallsOnChange: (areToolCallsOn: boolean) => void
  /**
   * Context length the loaded model was loaded with, or null while no model
   * is loaded or its length is unknown.
   */
  readonly contextLength: number | null
}

/** Properties accepted by {@link ToolContextMeter}. */
type ToolContextMeterProps = {
  /** How much of the context the tool descriptions take. */
  readonly contextUse: ToolContextUse
}

/**
 * Presents how much of the context the descriptions of the switched-on
 * tools take, with a bar while the loaded model's context length is known.
 *
 * @remarks The card owns the numbers; the meter owns no state. The bar is
 * an image named by its numbers.
 * @param props - How much of the context the descriptions take.
 * @returns The meter.
 */
function ToolContextMeter({ contextUse }: ToolContextMeterProps): ReactElement {
  return (
    <div className="settings-view__context">
      <div className="settings-view__context-top">
        <span className="settings-view__eyebrow">Context per request</span>
        <span className="settings-view__context-label">{contextUse.label}</span>
      </div>
      {contextUse.fraction === null ? null : (
        <div
          aria-label={`Tool descriptions: ${contextUse.label}`}
          className="settings-view__context-bar"
          role="img"
        >
          <span
            style={{
              inlineSize: `${(contextUse.fraction * 100).toFixed(2)}%`
            }}
          />
        </div>
      )}
      <span className="settings-view__context-note">
        The most the descriptions of the tools that are on take: a request
        carries a tool's description once Armitage finds that tool for it. Tools
        from MCP servers are not counted here.
      </span>
    </div>
  )
}

/**
 * Presents the tool-calls switch and what agents are offered.
 *
 * @remarks The parent owns every value and decides whether to accept the
 * proposal; the card owns no state or effects. The switch is named Tool calls
 * and described by the status line. While the card is locked, the switch is
 * disabled. Under the switch, the card says how much of the context the
 * descriptions of the switched-on tools take, with a bar while the loaded
 * model's context length is known; the bar is an image named by its
 * numbers.
 * @param props - Summary, lock, the context length, and the parent's
 * proposal.
 * @returns The tool-calls card.
 */
export function ToolCallsCard({
  summary,
  isLocked,
  onAreToolCallsOnChange,
  contextLength
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
      <ToolContextMeter
        contextUse={formatToolContextUse(summary, contextLength)}
      />
    </section>
  )
}
