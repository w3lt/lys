import type { CSSProperties } from "react"

import type { SettingsPane } from "@/app/types"
import { Skeleton } from "@/components/ui/skeleton"

/*
 * A pane's controls are read from disk the first time it is opened. Each shape
 * below repeats the block order of the pane it stands in for — cards, then a
 * section heading, then rows and compact list lines — so the layout settles
 * into place rather than jumping when the real controls arrive.
 *
 * Widths are fixed lengths where the real element is label-sized and
 * percentages where it fills the pane, matching how that element sizes itself.
 */
interface SkeletonCard {
  title: string
  meta: string
}

interface SkeletonRow {
  label: string
  description: string
  /** The control parked at the end of the row: a button, switch, or slider. */
  control: { width: string; height: string }
}

interface PaneSkeletonShape {
  cards: ReadonlyArray<SkeletonCard>
  /** A section heading and its rule, introducing the rows beneath it. */
  heading: boolean
  rows: ReadonlyArray<SkeletonRow>
  /** Compact two-column lines: runtime log entries, or model options. */
  list: ReadonlyArray<string>
  /** One tall surface, standing in for the system prompt field. */
  block: boolean
}

const PANE_SKELETONS: Record<SettingsPane, PaneSkeletonShape> = {
  runtime: {
    cards: [
      { title: "128px", meta: "196px" },
      { title: "104px", meta: "168px" }
    ],
    heading: true,
    rows: [],
    list: ["58%", "76%", "43%"],
    block: false
  },
  model: {
    cards: [],
    heading: true,
    rows: [
      {
        label: "72px",
        description: "178px",
        control: { width: "186px", height: "34px" }
      },
      {
        label: "132px",
        description: "96px",
        control: { width: "62px", height: "30px" }
      }
    ],
    list: ["64%", "78%", "52%"],
    block: false
  },
  generation: {
    cards: [],
    heading: false,
    rows: [
      {
        label: "116px",
        description: "218px",
        control: { width: "154px", height: "30px" }
      },
      {
        label: "94px",
        description: "158px",
        control: { width: "212px", height: "22px" }
      },
      {
        label: "98px",
        description: "132px",
        control: { width: "212px", height: "22px" }
      },
      {
        label: "110px",
        description: "190px",
        control: { width: "80px", height: "24px" }
      }
    ],
    list: [],
    block: false
  },
  conversation: {
    cards: [],
    heading: false,
    rows: [
      {
        label: "148px",
        description: "206px",
        control: { width: "176px", height: "30px" }
      }
    ],
    list: [],
    block: true
  }
}

/*
 * Cards are larger and fewer, so they carry the wider interval; rows and list
 * lines are dense enough that the same interval would leave the sweep looking
 * unsynchronised down the pane.
 */
const CARD_STAGGER_MS = 130
const LINE_STAGGER_MS = 90

function stagger(index: number, stepMs: number) {
  return { "--skeleton-delay": `${index * stepMs}ms` } as CSSProperties
}

export default function PaneSkeleton({ pane }: { pane: SettingsPane }) {
  const shape = PANE_SKELETONS[pane]
  const hasLines = shape.heading || shape.rows.length > 0

  return (
    /*
     * The bars themselves say nothing to a screen reader; the status line does.
     * Announcing it politely lets a reader finish the pane title first, which
     * is the part that says which settings are being read.
     */
    <div className="settings-view__stack" role="status">
      <span className="sr-only">Reading {pane} settings</span>

      {shape.cards.length > 0 ? (
        <div aria-hidden="true" className="settings-view__skeleton-cards">
          {shape.cards.map((card, index) => (
            <div
              className="settings-view__skeleton-card"
              key={index}
              style={stagger(index, CARD_STAGGER_MS)}
            >
              <div className="settings-view__skeleton-identity">
                <Skeleton className="settings-view__skeleton-dot" />
                <div className="settings-view__skeleton-lines">
                  <Skeleton
                    className="settings-view__skeleton-bar"
                    style={{ width: card.title }}
                  />
                  <Skeleton
                    className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                    data-tone="muted"
                    style={{ width: card.meta }}
                  />
                </div>
              </div>
              <div className="settings-view__skeleton-actions">
                <Skeleton className="settings-view__skeleton-action" />
                <Skeleton className="settings-view__skeleton-action" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {hasLines || shape.list.length > 0 ? (
        <div aria-hidden="true" className="settings-view__skeleton-section">
          {shape.heading ? (
            <div className="settings-view__skeleton-heading">
              <Skeleton className="settings-view__skeleton-bar" />
            </div>
          ) : null}

          {shape.rows.map((row, index) => (
            <div
              className="settings-view__skeleton-row"
              key={index}
              style={stagger(index, LINE_STAGGER_MS)}
            >
              <div className="settings-view__skeleton-lines">
                <Skeleton
                  className="settings-view__skeleton-bar"
                  style={{ width: row.label }}
                />
                <Skeleton
                  className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                  data-tone="muted"
                  style={{ width: row.description }}
                />
              </div>
              <Skeleton
                className="settings-view__skeleton-control"
                style={{ width: row.control.width, height: row.control.height }}
              />
            </div>
          ))}

          {shape.list.map((width, index) => (
            <div
              className="settings-view__skeleton-list-item"
              key={index}
              style={stagger(index, LINE_STAGGER_MS)}
            >
              <Skeleton
                className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                data-tone="muted"
              />
              <Skeleton
                className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                style={{ width }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {shape.block ? (
        <Skeleton
          aria-hidden="true"
          className="settings-view__skeleton-block"
          data-tone="muted"
        />
      ) : null}
    </div>
  )
}
