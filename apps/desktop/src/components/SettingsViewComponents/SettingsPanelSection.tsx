import { ChevronDown } from "lucide-react"
import { useId, type ReactElement, type ReactNode } from "react"

import {
  useSettingsSections,
  type SettingsSection
} from "./SettingsSectionsContext"

/** Properties accepted by {@link SettingsPanelSection}. */
export type SettingsPanelSectionProps = {
  /** Section the panel presents, whose open state the settings view owns. */
  readonly section: SettingsSection
  /** Mark shown before the titles, such as an initial, or null for none. */
  readonly leading: ReactNode
  /** Short uppercase label above the title, or null for none. */
  readonly eyebrow: string | null
  /** Title of the section, which names its disclosure button. */
  readonly title: string
  /** Line shown under the title while the section is open, or null. */
  readonly description: string | null
  /** One-line summary shown under the title while the section is closed. */
  readonly summary: string
  /** Controls and states shown at the end of the header, or null for none. */
  readonly aside: ReactNode
  /** Body shown while the section is open. */
  readonly children: ReactNode
}

/**
 * Presents one collapsible section of the Lys or Profile pane as a panel:
 * its header, with the disclosure button and its aside, and its body while
 * it is open.
 *
 * @remarks The settings view owns whether the section is open, and which
 * section's button takes focus, through {@link useSettingsSections}; the
 * parent owns the titles, the summary, the aside, and the body. The
 * disclosure button sits in a level-two heading and names the section; it
 * controls the body, which is not rendered while the section is closed, so
 * nothing hidden takes focus. While the rail asked to jump to the section,
 * the button takes focus once attached, which scrolls it into view, and
 * reports it.
 * @param props - Section, titles, summary, aside, and body.
 * @returns The panel.
 */
export default function SettingsPanelSection({
  section,
  leading,
  eyebrow,
  title,
  description,
  summary,
  aside,
  children
}: SettingsPanelSectionProps): ReactElement {
  const bodyId = useId()
  const sections = useSettingsSections()
  const isExpanded = sections.expandedSections.has(section)

  /**
   * Focuses the attached disclosure button the rail jumped to, and reports
   * it.
   *
   * @param element - Attached button, or null when React detaches it,
   * which is ignored.
   */
  function handleRequestedButtonAttach(element: HTMLButtonElement | null) {
    if (element === null) return
    element.focus()
    sections.onSectionFocused()
  }

  return (
    <section
      className="settings-view__panel"
      data-expanded={isExpanded ? "" : undefined}
    >
      <div className="settings-view__panel-head">
        <h2 className="settings-view__panel-heading">
          <button
            aria-controls={isExpanded ? bodyId : undefined}
            aria-expanded={isExpanded}
            className="settings-view__disclosure"
            onClick={() =>
              sections.onSectionsExpandedChange([section], !isExpanded)
            }
            ref={
              sections.focusedSection === section
                ? handleRequestedButtonAttach
                : undefined
            }
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className="settings-view__disclosure-chevron"
            />
            {leading}
            <span className="settings-view__disclosure-titles">
              {eyebrow === null ? null : (
                <span className="settings-view__eyebrow">{eyebrow}</span>
              )}
              <span className="settings-view__panel-title">{title}</span>
              {isExpanded && description !== null ? (
                <span className="settings-view__panel-description">
                  {description}
                </span>
              ) : null}
              {isExpanded ? null : (
                <span className="settings-view__panel-summary">{summary}</span>
              )}
            </span>
          </button>
        </h2>
        {aside}
      </div>
      {isExpanded ? (
        <div className="settings-view__panel-body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </section>
  )
}
