import { ChevronDown } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"

import {
  type ComposerAttachment,
  type ContextUsage,
  formatTokenCount
} from "./composer-context"

/** Visual weight assigned to one breakdown row. */
type ContextRowTone = "neutral" | "quiet" | "accent" | "warning" | "recap"

/** One line of the context breakdown. */
type ContextRow = {
  /** What the tokens are spent on. */
  readonly label: string
  /** Formatted token count, or a word standing in for an empty share. */
  readonly value: string
  /** Visual weight for the row's swatch and text. */
  readonly tone: ContextRowTone
}

/** Properties accepted by {@link ComposerContextMeter}. */
export type ComposerContextMeterProps = {
  /** Estimated breakdown of the current context window. */
  readonly usage: ContextUsage
  /** Files staged for the next message. */
  readonly attachments: readonly ComposerAttachment[]
  /** Largest staged attachment, named when the window overflows. */
  readonly largestAttachment?: ComposerAttachment
  /** Invoked once when the user asks to change the window size. */
  readonly onChangeWindow: () => void
}

/**
 * Builds the breakdown rows for one estimated context window.
 *
 * @param usage - Estimated breakdown of the window.
 * @param attachmentCount - Number of files staged for the next message.
 * @returns The rows rendered inside the disclosure panel, in reading order.
 */
function buildContextRows(
  usage: ContextUsage,
  attachmentCount: number
): readonly ContextRow[] {
  const isOverflowing = usage.overflowTokens > 0
  const turnLabel =
    usage.keptTurnCount === 1
      ? "1 turn in the window"
      : `${usage.keptTurnCount} turns in the window`
  const compactedLabel =
    usage.compactedTurnCount === 1
      ? "1 turn compacted into a recap"
      : `${usage.compactedTurnCount} turns compacted into a recap`

  const remainderRow: ContextRow = isOverflowing
    ? {
        label: "Over the window",
        value: `~${formatTokenCount(usage.overflowTokens)}`,
        tone: "warning"
      }
    : usage.compactedTurnCount > 0
      ? {
          label: compactedLabel,
          value: `~${formatTokenCount(usage.recapTokens)}`,
          tone: "recap"
        }
      : {
          label: "Room left",
          value: `~${formatTokenCount(usage.freeTokens)}`,
          tone: "neutral"
        }

  return [
    {
      label: "Backend preamble",
      value: `~${formatTokenCount(usage.systemTokens)}`,
      tone: "quiet"
    },
    {
      label: "Attached files",
      value:
        attachmentCount > 0
          ? `~${formatTokenCount(usage.attachmentTokens)}`
          : "none",
      tone:
        attachmentCount === 0 ? "quiet" : isOverflowing ? "warning" : "accent"
    },
    {
      label: turnLabel,
      value: `~${formatTokenCount(usage.keptTokens)}`,
      tone: "neutral"
    },
    remainderRow,
    {
      label: "Reserved for the reply",
      value: `~${formatTokenCount(usage.reserve)}`,
      tone: "quiet"
    }
  ]
}

/**
 * Writes the sentence explaining the window's current condition.
 *
 * @param usage - Estimated breakdown of the window.
 * @param largestAttachment - Largest staged file, named when it is the cause.
 * @returns The explanation shown beneath the breakdown rows.
 */
function formatContextNote(
  usage: ContextUsage,
  largestAttachment?: ComposerAttachment
): string {
  if (usage.overflowTokens > 0) {
    if (!largestAttachment) {
      return "Compaction cannot fix this. Remove an attachment or raise the window."
    }

    return `Compaction cannot fix this. “${largestAttachment.name}” is ~${formatTokenCount(largestAttachment.estimatedTokens)} on its own — remove it, or raise the window past ${formatTokenCount(usage.usedTokens + usage.reserve)}.`
  }

  if (usage.compactedTurnCount > 0) {
    return "The window filled, so the oldest turns were compacted into a recap that is sent in their place. The full text stays in the transcript."
  }

  return "Everything in this conversation still fits. When it stops fitting, the oldest turns are compacted into a recap and Lys says so in the transcript."
}

/**
 * Formats the meter's own label.
 *
 * @param usage - Estimated breakdown of the window.
 * @returns The compact label shown beside the fill bar.
 */
function formatMeterLabel(usage: ContextUsage): string {
  if (usage.overflowTokens > 0) {
    return `over by ~${formatTokenCount(usage.overflowTokens)}`
  }

  const ratio = `${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.budget)}`
  if (usage.compactedTurnCount > 0) {
    return `${ratio} · ${usage.compactedTurnCount} compacted`
  }

  return ratio
}

/**
 * Selects the meter's tone from how full the window is.
 *
 * @param usage - Estimated breakdown of the window.
 * @returns The tone applied to the fill bar and label.
 */
function readMeterTone(usage: ContextUsage): "over" | "tight" | "normal" {
  if (usage.overflowTokens > 0) return "over"
  if (usage.filledFraction >= 0.85) return "tight"

  return "normal"
}

/**
 * Reports how full the window is and what is occupying it.
 *
 * @remarks The parent owns the estimated
 * usage, the staged files, and the request to change the window; this component
 * owns only whether its panel is disclosed. The control is a disclosure: the
 * button carries `aria-expanded` and points at the panel it reveals, the panel
 * closes on Escape and on a pointer press outside it, and focus is returned to
 * the button when Escape closes it. Every count shown is a client-side estimate
 * and is prefixed with `~`; the meter's fill is accompanied by a text label so
 * the state is never carried by the bar alone.
 *
 * @param props - Estimated usage, staged files, and the window-change callback.
 * @returns The composer's context meter and its breakdown panel.
 */
export default function ComposerContextMeter({
  usage,
  attachments,
  largestAttachment,
  onChangeWindow
}: ComposerContextMeterProps) {
  const [isOpen, setIsOpen] = useState(false)
  const panelId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    /**
     * Closes the panel when a press lands outside the meter.
     *
     * @param event - Pointer press observed on the document.
     */
    function handlePointerDown(event: PointerEvent): void {
      const container = containerRef.current
      if (!container || !(event.target instanceof Node)) return
      if (container.contains(event.target)) return

      setIsOpen(false)
    }

    /**
     * Closes the panel on Escape and restores focus to the trigger.
     *
     * @param event - Key press observed on the document.
     */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return

      setIsOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  const tone = readMeterTone(usage)
  const rows = buildContextRows(usage, attachments.length)
  const meterLabel = formatMeterLabel(usage)

  return (
    <div className="composer__meter" ref={containerRef}>
      {/*
       * The visible label is a bare ratio, which says nothing on its own once
       * it is read out of context, so the control is named explicitly instead
       * of taking its name from that content.
       */}
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-label={`Context window · ${meterLabel}`}
        className="composer__meter-trigger"
        data-tone={tone}
        onClick={() => setIsOpen((open) => !open)}
        ref={triggerRef}
        title="What is in the window"
        type="button"
      >
        <span aria-hidden="true" className="composer__meter-track">
          <span
            className="composer__meter-fill"
            style={{ width: `${(usage.filledFraction * 100).toFixed(1)}%` }}
          />
        </span>
        <span aria-hidden="true">{meterLabel}</span>
        <ChevronDown aria-hidden="true" className="composer__caret" />
      </button>

      {isOpen ? (
        <div className="composer__meter-panel" id={panelId}>
          <div className="composer__meter-panel-heading">
            <span className="composer__eyebrow">window</span>
            <span>{formatTokenCount(usage.budget)} tokens</span>
          </div>

          <dl className="composer__meter-rows">
            {rows.map((row) => (
              <div
                className="composer__meter-row"
                data-tone={row.tone}
                key={row.label}
              >
                <dt>
                  <span aria-hidden="true" className="composer__meter-swatch" />
                  {row.label}
                </dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          <p className="composer__meter-note">
            {formatContextNote(usage, largestAttachment)}
          </p>

          <Button
            className="composer__meter-action"
            onClick={onChangeWindow}
            size="sm"
            type="button"
            variant="outline"
          >
            Change the window
          </Button>
        </div>
      ) : null}
    </div>
  )
}
