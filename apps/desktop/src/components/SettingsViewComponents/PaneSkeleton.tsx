import type { CSSProperties } from "react"

import type { SettingsPane } from "@/app/types"
import { Skeleton } from "@/components/ui/skeleton"

/** Geometry and labels for one repeated skeleton row. */
type SkeletonRow = {
  /**
   * Name of the setting or listed entry, such as an agent, that the row stands
   * in for, unique among its siblings.
   */
  readonly id: string
  /** Width of the row's primary label placeholder. */
  readonly label: string
  /** Width of the row's secondary description placeholder. */
  readonly description: string
  /** The control placeholder's CSS width and height, parked at row end. */
  readonly control: {
    /** CSS width of the control placeholder. */
    readonly width: string
    /** CSS height of the control placeholder. */
    readonly height: string
  }
}

/** Geometry for one card-shaped loading placeholder. */
type SkeletonCard = {
  /** Name of the card the placeholder stands in for, unique within its pane. */
  readonly id: string
  /** Width of the card title placeholder. */
  readonly title: string
  /** Width of the card metadata placeholder. */
  readonly meta: string
  /** A setting the card carries under its own divider, below the status line. */
  readonly row?: SkeletonRow
}

/** Geometry for one compact two-column skeleton line. */
type SkeletonListLine = {
  /** Name of the entry the line stands in for, unique within its list. */
  readonly id: string
  /** CSS width of the line's secondary placeholder. */
  readonly width: string
}

/** Complete placeholder geometry for one settings pane. */
type PaneSkeletonShape = {
  /** Card-shaped blocks rendered before row content. */
  readonly cards: ReadonlyArray<SkeletonCard>
  /** A section heading and its rule, introducing the rows beneath it. */
  readonly heading: boolean
  /** Repeated label/description/control rows beneath the optional heading. */
  readonly rows: ReadonlyArray<SkeletonRow>
  /** Compact two-column lines: runtime log entries, or model options. */
  readonly list: ReadonlyArray<SkeletonListLine>
  /** One tall surface, standing in for the system prompt field. */
  readonly block: boolean
}

/** Authoritative placeholder geometry keyed by every supported settings pane. */
const PANE_SKELETONS: Record<SettingsPane, PaneSkeletonShape> = {
  runtime: {
    cards: [
      {
        id: "backend",
        title: "128px",
        meta: "196px",
        row: {
          id: "autostart",
          label: "164px",
          description: "268px",
          control: { width: "44px", height: "24px" }
        }
      },
      {
        id: "model-residency",
        title: "104px",
        meta: "168px",
        row: {
          id: "residency-note",
          label: "212px",
          description: "268px",
          control: { width: "0", height: "0" }
        }
      }
    ],
    heading: false,
    rows: [],
    list: [],
    block: false
  },
  model: {
    cards: [],
    heading: true,
    rows: [
      {
        id: "context-size",
        label: "132px",
        description: "96px",
        control: { width: "150px", height: "30px" }
      }
    ],
    list: [
      { id: "first-model", width: "64%" },
      { id: "second-model", width: "78%" },
      { id: "third-model", width: "52%" }
    ],
    block: false
  },
  generation: {
    cards: [],
    heading: false,
    rows: [
      {
        id: "temperature",
        label: "116px",
        description: "218px",
        control: { width: "212px", height: "22px" }
      },
      {
        id: "reply-ceiling",
        label: "94px",
        description: "158px",
        control: { width: "96px", height: "24px" }
      },
      {
        id: "ceiling",
        label: "98px",
        description: "132px",
        control: { width: "212px", height: "22px" }
      }
    ],
    list: [],
    block: false
  },
  agents: {
    cards: [],
    heading: true,
    rows: [
      {
        id: "first-agent",
        label: "96px",
        description: "240px",
        control: { width: "12px", height: "12px" }
      },
      {
        id: "second-agent",
        label: "84px",
        description: "212px",
        control: { width: "12px", height: "12px" }
      },
      {
        id: "third-agent",
        label: "104px",
        description: "228px",
        control: { width: "12px", height: "12px" }
      }
    ],
    list: [],
    block: false
  }
}

/** Delay between successive card placeholder animations, in milliseconds. */
const CARD_STAGGER_MS = 130
/** Delay between successive row/list placeholder animations, in milliseconds. */
const LINE_STAGGER_MS = 90

/**
 * Creates the CSS custom property used to stagger one skeleton element.
 *
 * @param index - Zero-based position within the repeated placeholder group.
 * @param stepMs - Delay increment per position, in milliseconds.
 * @returns A style object containing the renderer-facing delay custom property.
 */
function stagger(index: number, stepMs: number) {
  return { "--skeleton-delay": `${index * stepMs}ms` } as CSSProperties
}

/**
 * Presents an accessible loading placeholder for one settings pane.
 *
 * @remarks The parent owns the pane value;
 * this component reads only the immutable geometry registry and owns no state,
 * effects, resources, callbacks, or persistence. The `role="status"` and
 * visually hidden text provide one polite announcement, while decorative bars
 * are hidden from assistive technology. Pixel widths are CSS geometry strings;
 * stagger delays are milliseconds. The component is the `Suspense` fallback of
 * every pane, and the Agents pane also shows it while its first list read is
 * pending. It renders cards, rows, list lines, or a block according to the
 * selected pane's current shape; it does not claim that the controls or
 * entries themselves are ready or available.
 *
 * @param props - Pane identity whose placeholder shape should be rendered.
 * @returns The accessible skeleton stack for the pane.
 */
export default function PaneSkeleton({
  pane
}: {
  /** Settings pane whose loading geometry is displayed. */
  pane: SettingsPane
}) {
  const shape = PANE_SKELETONS[pane]
  const hasLines = shape.heading || shape.rows.length > 0

  return (
    /*
     * The bars themselves say nothing to a screen reader; the status line does.
     * Announcing it politely lets a reader finish the pane title first, which
     * is the part that says which settings are being read.
     */
    <div aria-live="polite" className="settings-view__stack" role="status">
      <span className="sr-only">Reading {pane} settings</span>

      {shape.cards.length > 0 ? (
        <div aria-hidden="true" className="settings-view__skeleton-cards">
          {shape.cards.map((card, index) => (
            <div
              className="settings-view__skeleton-card"
              key={card.id}
              style={stagger(index, CARD_STAGGER_MS)}
            >
              <div className="settings-view__skeleton-card-row">
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

              {card.row ? (
                <>
                  <div className="settings-view__skeleton-card-divider" />
                  <div className="settings-view__skeleton-card-row">
                    <div className="settings-view__skeleton-lines">
                      <Skeleton
                        className="settings-view__skeleton-bar"
                        style={{ width: card.row.label }}
                      />
                      <Skeleton
                        className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                        data-tone="muted"
                        style={{ width: card.row.description }}
                      />
                    </div>
                    <Skeleton
                      className="settings-view__skeleton-control"
                      style={{
                        width: card.row.control.width,
                        height: card.row.control.height
                      }}
                    />
                  </div>
                </>
              ) : null}
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
              key={row.id}
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

          {shape.list.map((line, index) => (
            <div
              className="settings-view__skeleton-list-item"
              key={line.id}
              style={stagger(index, LINE_STAGGER_MS)}
            >
              <Skeleton
                className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                data-tone="muted"
              />
              <Skeleton
                className="settings-view__skeleton-bar settings-view__skeleton-bar--secondary"
                style={{ width: line.width }}
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
