import type { ReactElement } from "react"

import type { SettingsPane } from "@/app/types"

import type { SettingsSection } from "./SettingsSectionsContext"

/** Color of a rail marker's dot, by the state it stands for. */
export type SettingsRailTone = "success" | "pending" | "danger" | "neutral"

/**
 * A state shown beside a rail entry: a dot whose label only assistive
 * technology reads, or a short visible text.
 */
export type SettingsRailMarker =
  | {
      /** A colored dot. */
      readonly kind: "dot"
      /** Color of the dot. */
      readonly tone: SettingsRailTone
      /** What the dot means, read after the entry's name. */
      readonly label: string
    }
  | {
      /** A short text, such as `Not set up`. */
      readonly kind: "text"
      /** The text. */
      readonly label: string
    }

/** One section of the selected pane that the rail jumps to. */
export type SettingsRailSectionItem = {
  /** Section the entry opens and moves focus to. */
  readonly value: SettingsSection
  /** Visible label of the entry. */
  readonly label: string
  /** State shown beside the label, or null. */
  readonly marker: SettingsRailMarker | null
}

/** One entry in the settings navigation rail. */
export type SettingsRailItem = {
  /** Pane this entry selects. */
  readonly value: SettingsPane
  /** Visible label for the entry. */
  readonly label: string
  /** Two-digit ordinal shown at the end of the row. */
  readonly ordinal: string
  /** State shown before the ordinal, or null. */
  readonly marker: SettingsRailMarker | null
  /** Sections listed under the entry while its pane is selected; may be empty. */
  readonly sections: readonly SettingsRailSectionItem[]
}

/** Properties accepted by {@link SettingsViewLeftBar}. */
export type SettingsViewLeftBarProps = {
  /** Rail entries in display order. */
  readonly items: readonly SettingsRailItem[]
  /** Pane that is shown. */
  readonly selectedPane: SettingsPane
  /** Single-line summary of local runtime state shown at the rail's foot. */
  readonly status: string
  /** Color of the summary's dot. */
  readonly statusTone: SettingsRailTone
  /** Proposes showing another pane. */
  readonly onPaneSelect: (pane: SettingsPane) => void
  /** Proposes opening one section of the selected pane and moving to it. */
  readonly onSectionSelect: (section: SettingsSection) => void
}

/** Properties accepted by {@link SettingsRailMarkerView}. */
type SettingsRailMarkerViewProps = {
  /** The marker. */
  readonly marker: SettingsRailMarker
}

/**
 * Presents one rail marker: a dot with its meaning for assistive
 * technology, or a visible text.
 *
 * @remarks The parent owns the marker; the component owns no state. The
 * dot's meaning is never conveyed by its color alone: its label is read as
 * part of the entry's name.
 * @param props - The marker.
 * @returns The marker.
 */
function SettingsRailMarkerView({
  marker
}: SettingsRailMarkerViewProps): ReactElement {
  switch (marker.kind) {
    case "dot":
      return (
        <span className="settings-view__rail-marker">
          <span
            aria-hidden="true"
            className="settings-view__status-dot"
            data-tone={marker.tone}
          />
          <span className="sr-only">{`, ${marker.label}`}</span>
        </span>
      )
    case "text":
      return (
        <span className="settings-view__rail-marker-text">{marker.label}</span>
      )
  }
}

/** Properties accepted by {@link SettingsRailSectionButton}. */
type SettingsRailSectionButtonProps = {
  /** The section entry. */
  readonly section: SettingsRailSectionItem
  /** Proposes opening the section and moving to it. */
  readonly onSectionSelect: (section: SettingsSection) => void
}

/**
 * Presents one section entry of the selected pane: its label and marker.
 *
 * @remarks The rail owns the entry and the request; the component owns no
 * state.
 * @param props - The entry and the request.
 * @returns The button.
 */
function SettingsRailSectionButton({
  section,
  onSectionSelect
}: SettingsRailSectionButtonProps): ReactElement {
  return (
    <button
      className="settings-view__rail-section"
      onClick={() => onSectionSelect(section.value)}
      type="button"
    >
      <span>{section.label}</span>
      {section.marker === null ? null : (
        <SettingsRailMarkerView marker={section.marker} />
      )}
    </button>
  )
}

/** Properties accepted by {@link SettingsRailSections}. */
type SettingsRailSectionsProps = {
  /** Label of the pane the sections belong to. */
  readonly paneLabel: string
  /** Sections in display order. */
  readonly sections: readonly SettingsRailSectionItem[]
  /** Proposes opening one section and moving to it. */
  readonly onSectionSelect: (section: SettingsSection) => void
}

/**
 * Presents the selected pane's sections as a nested list of buttons.
 *
 * @remarks The rail owns the sections and the request; the component owns
 * no state. The list is named after its pane.
 * @param props - Pane label, sections, and the request.
 * @returns The nested list.
 */
function SettingsRailSections({
  paneLabel,
  sections,
  onSectionSelect
}: SettingsRailSectionsProps): ReactElement {
  return (
    <ul
      aria-label={`${paneLabel} sections`}
      className="settings-view__rail-sections"
    >
      {sections.map((section) => (
        <li key={section.value}>
          <SettingsRailSectionButton
            onSectionSelect={onSectionSelect}
            section={section}
          />
        </li>
      ))}
    </ul>
  )
}

/** Requests a rail entry proposes to the rail's parent. */
type SettingsRailRequests = Pick<
  SettingsViewLeftBarProps,
  "onPaneSelect" | "onSectionSelect"
>

/** Properties accepted by {@link SettingsRailEntry}. */
type SettingsRailEntryProps = {
  /** The entry. */
  readonly item: SettingsRailItem
  /** Whether the entry's pane is shown. */
  readonly isSelected: boolean
  /** Proposes showing the entry's pane or opening one of its sections. */
  readonly requests: SettingsRailRequests
}

/**
 * Presents one rail entry and, while its pane is shown, its sections.
 *
 * @remarks The rail owns the entry and the selection; the component owns no
 * state. The shown pane's button is the current page, marked with the
 * active surface.
 * @param props - Entry, selection, and the requests.
 * @returns The list item.
 */
function SettingsRailEntry({
  item,
  isSelected,
  requests
}: SettingsRailEntryProps): ReactElement {
  return (
    <li className="settings-view__rail-entry">
      <button
        aria-current={isSelected ? "page" : undefined}
        className="settings-view__rail-tab"
        data-active={isSelected ? "" : undefined}
        onClick={() => requests.onPaneSelect(item.value)}
        type="button"
      >
        <span>{item.label}</span>
        <span className="settings-view__rail-marks">
          {item.marker === null ? null : (
            <SettingsRailMarkerView marker={item.marker} />
          )}
          <span className="settings-view__rail-ordinal">{item.ordinal}</span>
        </span>
      </button>
      {isSelected && item.sections.length > 0 ? (
        <SettingsRailSections
          onSectionSelect={requests.onSectionSelect}
          paneLabel={item.label}
          sections={item.sections}
        />
      ) : null}
    </li>
  )
}

/**
 * Presents the settings navigation rail: the Lys Settings heading, one
 * button per pane, the shown pane's sections, and the runtime status line.
 *
 * @remarks The parent owns the entries, the shown pane, the status, and
 * what selecting a pane or a section does; this component owns no state or
 * effects. The rail is a navigation landmark named `Settings sections`
 * whose shown pane is the current page; keyboard users move through it
 * with Tab. The selected pane's sections are listed under its button.
 * @param props - Entries, shown pane, status summary, and the requests.
 * @returns The settings rail.
 */
export default function SettingsViewLeftBar({
  items,
  selectedPane,
  status,
  statusTone,
  onPaneSelect,
  onSectionSelect
}: SettingsViewLeftBarProps): ReactElement {
  const requests: SettingsRailRequests = { onPaneSelect, onSectionSelect }

  return (
    <nav aria-label="Settings sections" className="settings-view__rail">
      <p className="settings-view__rail-heading">
        <span className="settings-view__rail-wordmark">Lys</span>
        <span className="settings-view__rail-heading-label">Settings</span>
      </p>
      <ul className="settings-view__rail-list">
        {items.map((item) => (
          <SettingsRailEntry
            isSelected={item.value === selectedPane}
            item={item}
            key={item.value}
            requests={requests}
          />
        ))}
      </ul>
      <p className="settings-view__rail-status">
        <span
          aria-hidden="true"
          className="settings-view__status-dot"
          data-tone={statusTone}
        />
        <span>{status}</span>
      </p>
    </nav>
  )
}
