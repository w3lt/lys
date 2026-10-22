import {
  useId,
  useState,
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
  formatLocationMessage,
  formatPlaceNameProblem,
  LOCATION_FIELDS_HINT,
  LOCATION_PART_AUTOCOMPLETE,
  LOCATION_PART_LABELS,
  LOCATION_PARTS,
  parseLocationDraft,
  type LocationDraft,
  type LocationPart,
  type PlaceNameProblem
} from "./location-presentation"

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

/** Properties accepted by {@link LocationField}. */
type LocationFieldProps = {
  /** Part of the location the field holds. */
  readonly part: LocationPart
  /** Identifier of the input, which its label names. */
  readonly fieldId: string
  /** Identifier of the hint that states every field's constraints. */
  readonly hintId: string
  /** Text in the field. */
  readonly text: string
  /** Why the trimmed text is not a place name, or undefined when it is one. */
  readonly problem: PlaceNameProblem | undefined
  /** Proposes new text for the field. */
  readonly onTextChange: (text: string) => void
  /** Proposes discarding the card's edit, on Escape. */
  readonly onDiscardEdit: () => void
}

/**
 * Presents one labelled field of the location and, when its text is not a
 * place name, what to change.
 *
 * @remarks The card owns the text; the field owns no state or effects. The
 * input is described by its problem, when it has one, then by the hint that
 * states the constraints. Escape proposes discarding the card's edit.
 * @param props - Part, identifiers, text, problem, and the proposals.
 * @returns The field.
 */
function LocationField({
  part,
  fieldId,
  hintId,
  text,
  problem,
  onTextChange,
  onDiscardEdit
}: LocationFieldProps): ReactElement {
  const problemId = `${fieldId}-problem`

  /**
   * Proposes discarding the edit on Escape.
   *
   * @param event - Key pressed in the input.
   */
  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape") return
    event.preventDefault()
    onDiscardEdit()
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
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={handleFieldKeyDown}
        spellCheck={false}
        type="text"
        value={text}
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
 * Presents the location form: a hint, the city, region, and country fields,
 * the status line, and Save.
 *
 * @remarks The application store owns the saved location and the save; the
 * card owns only the person's edit, which starts from the saved location and
 * resets after a save that succeeded or on Escape. Enter or Save asks the
 * parent to save the trimmed fields, a blank field as null, only when they
 * are valid, differ from the saved location, and no save runs; Save is
 * disabled otherwise. Emptying every field and saving removes the location.
 * The status line is a polite live region.
 * @param props - Saved location, save state, and the save request.
 * @returns The card.
 */
export default function LocationCard({
  savedLocation,
  saveState,
  onSaveLocation
}: LocationCardProps): ReactElement {
  const [editedDraft, setEditedDraft] = useState<LocationDraft | null>(null)
  const cardId = useId()
  const hintId = `${cardId}-hint`
  const draft = editedDraft ?? buildLocationDraft(savedLocation)
  const draftParse = parseLocationDraft(draft, savedLocation)
  const problems = draftParse.status === "invalid" ? draftParse.problems : {}
  const isSaving = saveState.status === "saving"
  const message = formatLocationMessage({
    savedLocation,
    draftParse,
    saveState
  })

  /**
   * Saves the location and resets the edit once it is saved.
   *
   * @param location - Valid location that differs from the saved one.
   */
  async function handleSaveLocation(location: LocationSettings): Promise<void> {
    if ((await onSaveLocation(location)) === "saved") setEditedDraft(null)
  }

  /**
   * Asks the parent to save the edited location when it is valid and new.
   *
   * @param event - Submit event of the form.
   */
  function handleSubmitLocation(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (draftParse.status !== "changed" || isSaving) return
    void handleSaveLocation(draftParse.location)
  }

  return (
    <form
      aria-labelledby={`${cardId}-name`}
      className="settings-view__location-card"
      onSubmit={handleSubmitLocation}
    >
      <div className="settings-view__identity-lines">
        <h3 id={`${cardId}-name`}>Location</h3>
        <p id={hintId}>{LOCATION_FIELDS_HINT}</p>
      </div>
      <div className="settings-view__location-fields">
        {LOCATION_PARTS.map((part) => (
          <LocationField
            fieldId={`${cardId}-${part}`}
            hintId={hintId}
            key={part}
            onDiscardEdit={() => setEditedDraft(null)}
            onTextChange={(text) => setEditedDraft({ ...draft, [part]: text })}
            part={part}
            problem={problems[part]}
            text={draft[part]}
          />
        ))}
      </div>
      <div className="settings-view__location-footer">
        <p
          aria-live="polite"
          className="settings-view__location-status"
          data-tone={message.tone}
          role="status"
        >
          {message.text}
        </p>
        <Button
          disabled={draftParse.status !== "changed" || isSaving}
          size="sm"
          type="submit"
        >
          Save
        </Button>
      </div>
    </form>
  )
}
