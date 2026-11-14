import {
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement
} from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  LocationSaveOutcome,
  LocationSaveState
} from "@/lib/store/location-settings"
import type { LocationSettings } from "@/lib/store/settings"

import {
  buildLocationDraft,
  findLocationPrecision,
  raiseLocationPrecision,
  formatLocationMessage,
  formatLocationPreview,
  formatPlaceNameProblem,
  LOCATION_FIELDS_HINT,
  LOCATION_PART_AUTOCOMPLETE,
  LOCATION_PART_LABELS,
  LOCATION_PARTS,
  LOCATION_PRECISIONS,
  parseLocationDraft,
  type LocationDraft,
  type LocationDraftParse,
  type LocationMessage,
  type LocationPart,
  type LocationPrecision,
  type PlaceNameProblem
} from "./location-presentation"
import SettingsChoiceGroup from "./SettingsChoiceGroup"

/** Properties accepted by {@link LocationCard}. */
type LocationCardProps = {
  /** Location saved in the settings file; its parts may all be null. */
  readonly savedLocation: LocationSettings
  /** Latest save, owned by the application store. */
  readonly saveState: LocationSaveState
  /**
   * Requests that the parent save a location; one whose parts are all null
   * removes the saved one. Resolves with the outcome once the save settled;
   * never rejects.
   */
  readonly onSaveLocation: (
    location: LocationSettings
  ) => Promise<LocationSaveOutcome>
}

/** The person's edit of the location: the fields and the precision. */
type LocationEdit = {
  /** Text in each field. */
  readonly draft: LocationDraft
  /** How precisely the location is shared. */
  readonly precision: LocationPrecision
}

/** The card's edit, as each of its fields reads and changes it. */
type LocationFieldContext = {
  /** Identifier the card's field and hint identifiers start with. */
  readonly cardId: string
  /** The person's edit. */
  readonly edit: LocationEdit
  /** Why each field's trimmed text is not a place name, for those it is not. */
  readonly problems: Readonly<Partial<Record<LocationPart, PlaceNameProblem>>>
  /** Proposes another edit, or null to discard the edit. */
  readonly onEditChange: (edit: LocationEdit | null) => void
}

/** Properties accepted by {@link LocationField}. */
type LocationFieldProps = {
  /** Part of the location the field holds. */
  readonly part: LocationPart
  /** The card's edit and its proposal. */
  readonly context: LocationFieldContext
}

/** Properties accepted by {@link LocationFooter}. */
type LocationFooterProps = {
  /** The status line. */
  readonly message: LocationMessage
  /** Whether Save location is disabled. */
  readonly isSaveDisabled: boolean
}

/** Properties accepted by {@link LocationSharing}. */
type LocationSharingProps = {
  /** How precisely the location is shared. */
  readonly precision: LocationPrecision
  /** Outcome of reading the fields. */
  readonly draftParse: LocationDraftParse
  /** Location saved in the settings file. */
  readonly savedLocation: LocationSettings
  /** Whether a save runs, which the choice waits for. */
  readonly isSaving: boolean
  /** Proposes another precision. */
  readonly onPrecisionChange: (precision: LocationPrecision) => void
}

/**
 * Presents how precisely the location is shared, and what `get_location`
 * would return once the edit is saved.
 *
 * @remarks The card owns the precision; the component owns no state. The
 * choice is disabled while a save runs.
 * @param props - Precision, the fields, the saved location, and the
 * proposal.
 * @returns The choice and the preview.
 */
function LocationSharing({
  precision,
  draftParse,
  savedLocation,
  isSaving,
  onPrecisionChange
}: LocationSharingProps): ReactElement {
  const labelId = useId()

  return (
    <div className="settings-view__location-sharing">
      <div className="settings-view__choice-row">
        <span className="settings-view__row-title" id={labelId}>
          Share down to
        </span>
        <SettingsChoiceGroup
          choices={LOCATION_PRECISIONS.map((choice) => ({
            value: choice.precision,
            label: choice.label
          }))}
          disabled={isSaving}
          labelId={labelId}
          onValueChange={onPrecisionChange}
          value={precision}
        />
      </div>
      <div className="settings-view__preview">
        <span className="settings-view__eyebrow">get_location returns</span>
        <span className="settings-view__preview-text">
          {formatLocationPreview(draftParse, savedLocation)}
        </span>
      </div>
    </div>
  )
}

/**
 * Presents one labelled field of the location and, when its text is not a
 * place name, what to change.
 *
 * @remarks The card owns the edit; the field owns no state or effects.
 * Typing a part below the precision shares it, so a part the person types
 * is saved. The input is described by its problem, when it has one, then by
 * the hint that states the constraints. Escape proposes discarding the
 * card's edit, except an Escape that ends text composition, such as
 * cancelling a name typed through an input method.
 * @param props - Part, and the card's edit and its proposal.
 * @returns The field.
 */
function LocationField({ part, context }: LocationFieldProps): ReactElement {
  const { cardId, edit, onEditChange } = context
  const fieldId = `${cardId}-${part}`
  const hintId = `${cardId}-hint`
  const problemId = `${fieldId}-problem`
  const problem = context.problems[part]

  /**
   * Proposes discarding the edit on an Escape that does not end text
   * composition.
   *
   * @param event - Key pressed in the input.
   */
  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return
    event.preventDefault()
    onEditChange(null)
  }

  /**
   * Proposes the edit with the field's new text, sharing the part when the
   * text is not blank and the part was below the precision.
   *
   * @param event - Change of the input.
   */
  function handleFieldChange(event: ChangeEvent<HTMLInputElement>): void {
    const text = event.target.value
    onEditChange({
      draft: { ...edit.draft, [part]: text },
      precision: raiseLocationPrecision(edit.precision, part, text)
    })
  }

  return (
    <div className="settings-view__location-field">
      <label htmlFor={fieldId}>{LOCATION_PART_LABELS[part]}</label>
      <Input
        aria-describedby={
          problem === undefined ? hintId : `${problemId} ${hintId}`
        }
        aria-invalid={problem === undefined ? undefined : true}
        autoComplete={LOCATION_PART_AUTOCOMPLETE[part]}
        id={fieldId}
        onChange={handleFieldChange}
        onKeyDown={handleFieldKeyDown}
        spellCheck={false}
        type="text"
        value={edit.draft[part]}
      />
      {problem === undefined ? null : (
        <p className="settings-view__location-field-error" id={problemId}>
          {formatPlaceNameProblem(problem)}
        </p>
      )}
    </div>
  )
}

/**
 * Presents the card's status line and Save location.
 *
 * @remarks The card owns the message and when a save is possible; the
 * footer owns no state. The status line is a polite live region.
 * @param props - The status line and whether Save location is disabled.
 * @returns The footer.
 */
function LocationFooter({
  message,
  isSaveDisabled
}: LocationFooterProps): ReactElement {
  return (
    <div className="settings-view__location-footer">
      <p
        aria-live="polite"
        className="settings-view__location-status"
        data-tone={message.tone}
        role="status"
      >
        {message.text}
      </p>
      <Button disabled={isSaveDisabled} size="sm" type="submit">
        Save location
      </Button>
    </div>
  )
}

/**
 * Presents the location form: a hint, the city, region, and country fields,
 * how precisely the location is shared, what `get_location` would return,
 * the status line, and Save location.
 *
 * @remarks The application store owns the saved location and the save; the
 * card owns only the person's edit, which starts from the saved location
 * and the precision it was saved at, and resets on Escape, and after a save
 * that succeeded unless the person changed the edit while it ran. Enter or
 * Save location asks the parent to save the trimmed fields, a blank field
 * or a part below the precision as null, only when they are valid, differ
 * from the saved location, and no save runs; Save location is disabled
 * otherwise. Emptying every field, or sharing nothing, and saving removes
 * the location. The status line is a polite live region. The section the
 * card is in names it.
 * @param props - Saved location, save state, and the save request.
 * @returns The card.
 */
export default function LocationCard({
  savedLocation,
  saveState,
  onSaveLocation
}: LocationCardProps): ReactElement {
  const [editedLocation, setEditedLocation] = useState<LocationEdit | null>(
    null
  )
  const cardId = useId()
  const edit = editedLocation ?? {
    draft: buildLocationDraft(savedLocation),
    precision: findLocationPrecision(savedLocation)
  }
  const draftParse = parseLocationDraft(
    edit.draft,
    savedLocation,
    edit.precision
  )
  const isSaving = saveState.status === "saving"
  const fieldContext: LocationFieldContext = {
    cardId,
    edit,
    problems: draftParse.status === "invalid" ? draftParse.problems : {},
    onEditChange: setEditedLocation
  }

  /**
   * Saves the location and, once it is saved, resets the edit when it
   * still holds the edit the location was read from.
   *
   * @param location - Valid location that differs from the saved one.
   * @param submittedEdit - Edit the location was read from; any later change
   * is a new edit, which the save keeps.
   */
  async function handleSaveLocation(
    location: LocationSettings,
    submittedEdit: LocationEdit | null
  ): Promise<void> {
    if ((await onSaveLocation(location)) !== "saved") return
    setEditedLocation((current) => (current === submittedEdit ? null : current))
  }

  /**
   * Asks the parent to save the edited location when it is valid and new.
   *
   * @param event - Submit event of the form.
   */
  function handleSubmitLocation(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (draftParse.status !== "changed" || isSaving) return
    void handleSaveLocation(draftParse.location, editedLocation)
  }

  return (
    <form
      aria-label="Location"
      className="settings-view__location-card"
      onSubmit={handleSubmitLocation}
    >
      <p className="settings-view__panel-intro">
        Lys never detects where you are. A model gets what you save here only
        when it calls <code>get_location</code>, and only as precisely as you
        choose. <span id={`${cardId}-hint`}>{LOCATION_FIELDS_HINT}</span>
      </p>
      <div className="settings-view__location-fields">
        {LOCATION_PARTS.map((part) => (
          <LocationField context={fieldContext} key={part} part={part} />
        ))}
      </div>
      <LocationSharing
        draftParse={draftParse}
        isSaving={isSaving}
        onPrecisionChange={(precision) =>
          setEditedLocation({ ...edit, precision })
        }
        precision={edit.precision}
        savedLocation={savedLocation}
      />
      <LocationFooter
        isSaveDisabled={draftParse.status !== "changed" || isSaving}
        message={formatLocationMessage({
          savedLocation,
          draftParse,
          saveState
        })}
      />
    </form>
  )
}
