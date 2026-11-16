import { useId, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useLysStore } from "@/lib/store"
import {
  useLocalProfileStore,
  type WritingPreferences
} from "@/lib/store/local-profile"

import LocationCard from "./LocationCard"
import {
  estimateEveryRequestTokens,
  formatAboutYouSummary,
  formatAskedLocation,
  formatEveryRequestList,
  formatLocationSummary,
  formatModelViewSummary,
  formatNotesHelp,
  formatNotesSummary,
  formatPersonDisplayName,
  formatPreferencesPreview,
  formatPreferencesSummary,
  MAXIMUM_NOTES_LENGTH,
  WRITING_PREFERENCE_ROWS,
  type WritingPreferenceRow
} from "./profile-presentation"
import SettingsChoiceGroup from "./SettingsChoiceGroup"
import SettingsPanelField from "./SettingsPanelField"
import SettingsPanelSection from "./SettingsPanelSection"

/** Properties accepted by {@link SectionReachBadge}. */
type SectionReachBadgeProps = {
  /** What the badge says. */
  readonly label: string
}

/** Properties accepted by {@link WritingPreferenceRowView}. */
type WritingPreferenceRowViewProps = {
  /** The row. */
  readonly row: WritingPreferenceRow
  /** The choice of each preference. */
  readonly preferences: WritingPreferences
  /** Changes the choice of some preferences. */
  readonly onPreferencesChange: (change: Partial<WritingPreferences>) => void
}

/**
 * Presents the badge that says when a section's values reach a model.
 *
 * @param props - What the badge says.
 * @returns The badge.
 */
function SectionReachBadge({ label }: SectionReachBadgeProps): ReactElement {
  return (
    <span className="settings-view__badge">
      <span aria-hidden="true" className="settings-view__badge-dot" />
      {label}
    </span>
  )
}

/**
 * Presents what a model learns about the person: what goes with every
 * request, and what only when a model asks.
 *
 * @remarks The local profile store owns About you and the notes; the
 * application store owns the saved location and which pane shows; the
 * section owns no state. Tools shows the Tools pane, where `get_location`
 * is switched.
 * @returns The section.
 */
function ModelViewSection(): ReactElement {
  const identity = useLocalProfileStore((state) => state.personIdentity)
  const notes = useLocalProfileStore((state) => state.notesForLys)
  const location = useLysStore((state) => state.settings.location)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const displayName = formatPersonDisplayName(identity)
  const tokens = estimateEveryRequestTokens(identity, notes)

  return (
    <SettingsPanelSection
      aside={null}
      description={`Lys works for ${displayName}. This is everything it passes on, and when.`}
      eyebrow={null}
      leading={
        <span aria-hidden="true" className="settings-view__initial">
          {displayName.charAt(0).toUpperCase()}
        </span>
      }
      section="model-view"
      summary={formatModelViewSummary(tokens, location)}
      title="What a model learns about you"
    >
      <div className="settings-view__model-view">
        <div className="settings-view__model-view-tile">
          <span className="settings-view__eyebrow">With every request</span>
          <span className="settings-view__model-view-value">
            ~{tokens} <span>tokens</span>
          </span>
          <span>{formatEveryRequestList(identity, notes)}</span>
        </div>
        <div className="settings-view__model-view-tile">
          <span className="settings-view__eyebrow">Only when asked</span>
          <span className="settings-view__model-view-value">
            {formatAskedLocation(location)}
          </span>
          <span>
            Your location, when a model calls <code>get_location</code>. Switch
            that tool in{" "}
            <Button
              onClick={() => setSettingsPane("tools")}
              type="button"
              variant="link"
            >
              Tools
            </Button>
            .
          </span>
        </div>
      </div>
    </SettingsPanelSection>
  )
}

/**
 * Presents the fields of how Lys addresses the person: name, what Lys
 * calls them, pronouns, and the languages they read.
 *
 * @remarks The local profile store owns the values; the fields own no
 * state. Each change is kept at once.
 * @returns The fields.
 */
function AboutYouFields(): ReactElement {
  const identity = useLocalProfileStore((state) => state.personIdentity)
  const update = useLocalProfileStore((state) => state.updatePersonIdentity)
  const displayName = formatPersonDisplayName(identity)

  return (
    <div className="settings-view__panel-fields">
      <SettingsPanelField
        help={`Used when Lys writes on your behalf, as in "Assistant to ${displayName}".`}
        isOptional={false}
        label="Name"
        onValueChange={(name) => update({ name })}
        rows={null}
        value={identity.name}
      />
      <SettingsPanelField
        help="What Lys says when it talks to you. Empty uses your name."
        isOptional
        label="Lys calls you"
        onValueChange={(callName) => update({ callName })}
        placeholder={identity.name}
        rows={null}
        value={identity.callName}
      />
      <SettingsPanelField
        help="Used when Lys mentions you to someone else."
        isOptional
        label="Pronouns"
        onValueChange={(pronouns) => update({ pronouns })}
        placeholder="she/her, he/him, they/them…"
        rows={null}
        value={identity.pronouns}
      />
      <SettingsPanelField
        help="Lys answers in the first unless you write in another."
        isOptional={false}
        label="You read"
        onValueChange={(reads) => update({ reads })}
        rows={null}
        value={identity.reads}
      />
    </div>
  )
}

/**
 * Presents the About you section: how Lys addresses the person.
 *
 * @remarks The local profile store owns the values; the section owns no
 * state.
 * @returns The section.
 */
function AboutYouSection(): ReactElement {
  const identity = useLocalProfileStore((state) => state.personIdentity)

  return (
    <SettingsPanelSection
      aside={<SectionReachBadge label="Sent with every request" />}
      description="How Lys addresses you"
      eyebrow={null}
      leading={null}
      section="about-you"
      summary={formatAboutYouSummary(identity)}
      title="About you"
    >
      <AboutYouFields />
    </SettingsPanelSection>
  )
}

/**
 * Presents the Location section: the place the person saves for the
 * `get_location` tool.
 *
 * @remarks The application store owns the saved location and its save; the
 * section owns no state or effects. A saved change applies to the next
 * `get_location` call, because the tool reads the settings file.
 * @returns The section.
 */
function LocationSection(): ReactElement {
  const savedLocation = useLysStore((state) => state.settings.location)
  const saveState = useLysStore((state) => state.locationSave)
  const saveLocation = useLysStore((state) => state.saveLocation)

  return (
    <SettingsPanelSection
      aside={<SectionReachBadge label="Only through get_location" />}
      description="Where you are, as you say it"
      eyebrow={null}
      leading={null}
      section="location"
      summary={formatLocationSummary(savedLocation)}
      title="Location"
    >
      <LocationCard
        onSaveLocation={saveLocation}
        saveState={saveState}
        savedLocation={savedLocation}
      />
    </SettingsPanelSection>
  )
}

/**
 * Presents one preference: its label, what it changes, and its choices.
 *
 * @param props - The row, the choices made, and the change proposal.
 * @returns The row.
 */
function WritingPreferenceRowView({
  row,
  preferences,
  onPreferencesChange
}: WritingPreferenceRowViewProps): ReactElement {
  const labelId = useId()

  return (
    <div className="settings-view__panel-row">
      <div className="settings-view__row-lines">
        <span className="settings-view__row-title" id={labelId}>
          {row.label}
        </span>
        <span>{row.help}</span>
      </div>
      <SettingsChoiceGroup
        choices={row.choices}
        disabled={false}
        labelId={labelId}
        onValueChange={(value) =>
          onPreferencesChange({ [row.preference]: value })
        }
        value={preferences[row.preference]}
      />
    </div>
  )
}

/**
 * Presents the Preferences section: how answers are written for the
 * person, and a sample of it.
 *
 * @remarks The local profile store owns the choices; the section owns no
 * state.
 * @returns The section.
 */
function PreferencesSection(): ReactElement {
  const preferences = useLocalProfileStore((state) => state.writingPreferences)
  const update = useLocalProfileStore((state) => state.updateWritingPreferences)

  return (
    <SettingsPanelSection
      aside={<SectionReachBadge label="Sent with every request" />}
      description="How answers are written for you"
      eyebrow={null}
      leading={null}
      section="preferences"
      summary={formatPreferencesSummary(preferences)}
      title="Preferences"
    >
      <div className="settings-view__panel-rows">
        {WRITING_PREFERENCE_ROWS.map((row) => (
          <WritingPreferenceRowView
            key={row.preference}
            onPreferencesChange={update}
            preferences={preferences}
            row={row}
          />
        ))}
      </div>
      <div className="settings-view__preview">
        <span className="settings-view__eyebrow">A model will write</span>
        <span className="settings-view__preview-text">
          {formatPreferencesPreview(preferences)}
        </span>
      </div>
    </SettingsPanelSection>
  )
}

/**
 * Presents the Notes for Lys section: what Lys keeps in mind, and whether
 * it goes with every request.
 *
 * @remarks The local profile store owns the notes and the switch; the
 * section owns no state. The notes hold at most
 * {@link MAXIMUM_NOTES_LENGTH} characters, and the count says how many are
 * used.
 * @returns The section.
 */
function NotesSection(): ReactElement {
  const notes = useLocalProfileStore((state) => state.notesForLys)
  const update = useLocalProfileStore((state) => state.updateNotesForLys)
  const fieldId = useId()
  const switchLabelId = `${fieldId}-switch`

  return (
    <SettingsPanelSection
      aside={
        <div className="settings-view__panel-aside">
          <span id={switchLabelId}>Send with every request</span>
          <Switch
            aria-labelledby={switchLabelId}
            checked={notes.isSentWithEveryRequest}
            onCheckedChange={(checked) =>
              update({ isSentWithEveryRequest: checked })
            }
          />
        </div>
      }
      description="What to keep in mind"
      eyebrow={null}
      leading={null}
      section="notes"
      summary={formatNotesSummary(notes)}
      title="Notes for Lys"
    >
      <div className="settings-view__panel-field" data-wide="">
        <label htmlFor={fieldId}>Notes</label>
        <Textarea
          aria-describedby={`${fieldId}-help`}
          id={fieldId}
          maxLength={MAXIMUM_NOTES_LENGTH}
          onChange={(event) => update({ text: event.target.value })}
          placeholder="How you like answers, what you are working on, what to avoid."
          rows={5}
          value={notes.text}
        />
        <div className="settings-view__notes-foot">
          <span className="settings-view__panel-help" id={`${fieldId}-help`}>
            {formatNotesHelp(notes)}
          </span>
          <span className="settings-view__panel-help">
            {notes.text.length} / {MAXIMUM_NOTES_LENGTH}
          </span>
        </div>
      </div>
    </SettingsPanelSection>
  )
}

/**
 * Presents the Profile pane: what a model learns about the person, About
 * you, Location, Preferences, and Notes for Lys, then where Lys's own name
 * is set.
 *
 * @remarks The pane accepts no props and is loaded lazily by the settings
 * view, which owns which sections are open. Lys shows the Lys pane.
 * @returns The Profile pane body.
 */
export default function ProfilePane(): ReactElement {
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  return (
    <div className="settings-view__panels">
      <ModelViewSection />
      <AboutYouSection />
      <LocationSection />
      <PreferencesSection />
      <NotesSection />
      <p className="settings-view__closing-note">
        Kept on this machine. A change applies from the next request; past
        conversations keep what they were sent. Lys&apos;s own name is under{" "}
        <Button
          onClick={() => setSettingsPane("lys")}
          type="button"
          variant="link"
        >
          Lys
        </Button>
        .
      </p>
    </div>
  )
}
