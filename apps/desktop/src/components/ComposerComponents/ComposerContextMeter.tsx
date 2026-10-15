import { ChevronDown } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"

import {
  type ContextMeterState,
  type ContextUsage,
  formatTokenCount
} from "./composer-context"

/** Visual weight assigned to one breakdown row. */
type ContextRowTone = "neutral" | "quiet" | "accent" | "warning"

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
  /** What is known about the window. */
  readonly meter: ContextMeterState
  /** Whether files are staged in the tray; they are never sent. */
  readonly hasStagedFiles: boolean
  /** Invoked once when the user asks to change the window size. */
  readonly onChangeWindow: () => void
}

/** Sentence added to every note while files are staged. */
const STAGED_FILES_NOTE =
  "Staged files are not sent yet, so they are not counted."

/**
 * Builds the breakdown row for the stored messages the next turn includes.
 *
 * @param usage - Breakdown of the window.
 * @returns A quiet `none` row before the first message; otherwise how many
 * messages and their tokens.
 */
function buildHistoryRow(usage: ContextUsage): ContextRow {
  if (usage.historyMessageCount === 0) {
    return { label: "Earlier messages", value: "none", tone: "quiet" }
  }

  return {
    label:
      usage.historyMessageCount === 1
        ? "1 earlier message"
        : `${usage.historyMessageCount} earlier messages`,
    value: `~${formatTokenCount(usage.historyTokens)}`,
    tone: "neutral"
  }
}

/**
 * Builds the breakdown row describing the window beyond the request.
 *
 * @param usage - Breakdown of the window.
 * @returns The overflow while the request does not fit, otherwise the room
 * left.
 */
function buildRemainderRow(usage: ContextUsage): ContextRow {
  if (usage.overflowTokens > 0) {
    return {
      label: "Over the window",
      value: `~${formatTokenCount(usage.overflowTokens)}`,
      tone: "warning"
    }
  }

  return {
    label: "Room left",
    value: `~${formatTokenCount(usage.freeTokens)}`,
    tone: "neutral"
  }
}

/**
 * Builds the breakdown rows for one measured window.
 *
 * @param usage - Breakdown of the window.
 * @returns The rows rendered inside the disclosure panel, in send order.
 */
function buildContextRows(usage: ContextUsage): readonly ContextRow[] {
  return [
    {
      label: "Agent instructions",
      value: `~${formatTokenCount(usage.systemPromptTokens)}`,
      tone: "quiet"
    },
    {
      label: "Tool definitions",
      value:
        usage.toolTokens === 0
          ? "none"
          : `~${formatTokenCount(usage.toolTokens)}`,
      tone: "quiet"
    },
    buildHistoryRow(usage),
    {
      label: "Your message",
      value: `~${formatTokenCount(usage.messageTokens)}`,
      tone: "accent"
    },
    buildRemainderRow(usage),
    {
      label: "Reserved for the reply",
      value: `~${formatTokenCount(usage.reserve)}`,
      tone: "quiet"
    }
  ]
}

/**
 * Writes the sentence explaining what the meter shows.
 *
 * @param meter - What is known about the window.
 * @returns The explanation shown beneath the breakdown rows, without the
 * staged-files sentence.
 */
function formatContextNote(meter: ContextMeterState): string {
  switch (meter.status) {
    case "measuring":
      return "Measuring what your next message would be sent with."
    case "unknown":
      return `${meter.reason} Sending still checks that the conversation fits the model.`
    case "measured":
      return meter.usage.overflowTokens > 0
        ? "This message would not fit. Lys sends every earlier message with each new one and never shortens them, so start a new conversation, shorten your message, or load the model with a longer context."
        : "Counted with the model's tokenizer; your message is estimated. Lys sends every earlier message with each new one and never shortens them."
  }
}

/**
 * Formats the meter's own label.
 *
 * @param meter - What is known about the window.
 * @returns The compact label shown beside the fill bar.
 */
function formatMeterLabel(meter: ContextMeterState): string {
  switch (meter.status) {
    case "measuring":
      return "measuring…"
    case "unknown":
      return "window unknown"
    case "measured":
      return meter.usage.overflowTokens > 0
        ? `over by ~${formatTokenCount(meter.usage.overflowTokens)}`
        : `${formatTokenCount(meter.usage.usedTokens)} / ${formatTokenCount(meter.usage.contextLength)}`
  }
}

/**
 * Calculates how much of the meter's bar is filled.
 *
 * @param meter - What is known about the window.
 * @returns The CSS width of the fill: the share of the window the request
 * and the reserve take, or `0%` until the window is measured.
 */
function calculateMeterFillWidth(meter: ContextMeterState): string {
  const filledFraction =
    meter.status === "measured" ? meter.usage.filledFraction : 0
  return `${(filledFraction * 100).toFixed(1)}%`
}

/**
 * Selects the meter's tone from how full the window is.
 *
 * @param meter - What is known about the window.
 * @returns The tone applied to the fill bar and label; `normal` until the
 * window is measured.
 */
function readMeterTone(meter: ContextMeterState): "over" | "tight" | "normal" {
  if (meter.status !== "measured") return "normal"
  if (meter.usage.overflowTokens > 0) return "over"
  if (meter.usage.filledFraction >= 0.85) return "tight"

  return "normal"
}

/**
 * Reports how full the window is and what is occupying it.
 *
 * @remarks The parent owns what is known
 * about the window, whether files are staged, and the request to change the
 * window; this component owns only whether its panel is disclosed. The control is a disclosure: the
 * button carries `aria-expanded` and points at the panel it reveals, the panel
 * closes on Escape and on a pointer press outside it, and focus is returned to
 * the button when Escape closes it. The window is the context length the model
 * is loaded with. Counts are prefixed with `~`, because the draft is estimated
 * and the backend's counts include an allowance for the chat template; no
 * state claims that earlier messages are shortened or summarized, because
 * they never are. The meter's fill is accompanied by a text label so the state
 * is never carried by the bar alone.
 *
 * @param props - What is known about the window, whether files are staged,
 * and the window-change callback.
 * @returns The composer's context meter and its breakdown panel.
 */
export default function ComposerContextMeter({
  meter,
  hasStagedFiles,
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

  const tone = readMeterTone(meter)
  const meterLabel = formatMeterLabel(meter)
  const note = hasStagedFiles
    ? `${formatContextNote(meter)} ${STAGED_FILES_NOTE}`
    : formatContextNote(meter)

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
            style={{ width: calculateMeterFillWidth(meter) }}
          />
        </span>
        <span aria-hidden="true">{meterLabel}</span>
        <ChevronDown aria-hidden="true" className="composer__caret" />
      </button>

      {isOpen ? (
        <div className="composer__meter-panel" id={panelId}>
          <div className="composer__meter-panel-heading">
            <span className="composer__eyebrow">window</span>
            {meter.status === "measured" ? (
              <span>{formatTokenCount(meter.usage.contextLength)} tokens</span>
            ) : null}
          </div>

          {meter.status === "measured" ? (
            <dl className="composer__meter-rows">
              {buildContextRows(meter.usage).map((row) => (
                <div
                  className="composer__meter-row"
                  data-tone={row.tone}
                  key={row.label}
                >
                  <dt>
                    <span
                      aria-hidden="true"
                      className="composer__meter-swatch"
                    />
                    {row.label}
                  </dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <p className="composer__meter-note">{note}</p>

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
