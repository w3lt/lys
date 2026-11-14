import { createContext, use } from "react"

/**
 * A collapsible section of a settings pane: Lys's About Lys and Email,
 * and Profile's model view, About you, Location, Preferences, and Notes for
 * Lys.
 */
export type SettingsSection =
  | "about-lys"
  | "lys-email"
  | "model-view"
  | "about-you"
  | "location"
  | "preferences"
  | "notes"

/**
 * Which sections are open, and the requests that open, close, and jump to
 * them.
 *
 * @remarks The settings view owns the value for as long as it is shown:
 * every section starts open, and leaving Settings forgets what was closed.
 * The rail jumps to a section by opening it and naming it as the section
 * whose disclosure button takes focus once attached; that section reports
 * the focus back, which clears the request.
 */
export type SettingsSectionsContextValue = {
  /** Sections that are open. */
  readonly expandedSections: ReadonlySet<SettingsSection>
  /** Section whose disclosure button takes focus once attached, or null. */
  readonly focusedSection: SettingsSection | null
  /**
   * Opens or closes sections.
   *
   * @param sections - The sections, such as one, or every section of a pane.
   * @param isExpanded - Whether they are open from now on.
   */
  readonly onSectionsExpandedChange: (
    sections: readonly SettingsSection[],
    isExpanded: boolean
  ) => void
  /** Reports that the requested section's disclosure button took focus. */
  readonly onSectionFocused: () => void
}

/**
 * Carries the open sections and their requests from the settings view to
 * the sections of the Lys and Profile panes.
 *
 * @remarks No default value: a section rendered outside the settings view
 * fails at once, see {@link useSettingsSections}.
 */
export const SettingsSectionsContext =
  createContext<SettingsSectionsContextValue | null>(null)

/**
 * Reads the open sections and their requests.
 *
 * @returns The value the settings view provides.
 * @throws Error when no settings view provides the value, which is a
 * programming error.
 */
export function useSettingsSections(): SettingsSectionsContextValue {
  const value = use(SettingsSectionsContext)
  if (value === null) {
    throw new Error("A settings section must be rendered in the settings view.")
  }
  return value
}
