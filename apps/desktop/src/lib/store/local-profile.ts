import { create, type StoreApi, type UseBoundStore } from "zustand"

/** How Lys introduces itself, as the Lys pane's About Lys section edits it. */
export type LysIdentity = {
  /** Name used in the From line and when Lys introduces itself. */
  readonly name: string
  /** Full name given when someone asks for it; empty for none. */
  readonly fullName: string
  /** IANA time zone the dates and times in Lys's messages use. */
  readonly timeZone: string
  /** Languages Lys writes in, the first one by default. */
  readonly writesIn: string
}

/** How Lys addresses the person, as the Profile pane's About you edits it. */
export type PersonIdentity = {
  /** The person's name. */
  readonly name: string
  /** What Lys calls the person; empty uses the name. */
  readonly callName: string
  /** The person's pronouns; empty for none. */
  readonly pronouns: string
  /** Languages the person reads, the first one by default. */
  readonly reads: string
}

/** One way of writing answers the Profile pane's Preferences section chooses. */
export type WritingPreference =
  "units" | "temperature" | "dates" | "clock" | "week"

/** The choice of each writing preference. */
export type WritingPreferences = {
  /** Units of distances, weights, and volumes. */
  readonly units: "metric" | "imperial"
  /** Unit of temperatures. */
  readonly temperature: "celsius" | "fahrenheit"
  /** Order of a written day. */
  readonly dates: "day-month-year" | "month-day-year" | "iso"
  /** Clock a time of day is written in. */
  readonly clock: "24-hour" | "12-hour"
  /** First day of a week. */
  readonly week: "monday" | "sunday"
}

/** The person's notes for Lys, as the Profile pane's Notes for Lys edits them. */
export type NotesForLys = {
  /** The notes; empty for none. */
  readonly text: string
  /** Whether the notes go with every request. */
  readonly isSentWithEveryRequest: boolean
}

/** Observable state of the local profile store. */
type LocalProfileState = {
  /** How Lys introduces itself. */
  readonly lysIdentity: LysIdentity
  /** Object URL of the portrait the person picked for Lys, or null. */
  readonly lysPortraitUrl: string | null
  /** When About Lys last changed, or null before any change. */
  readonly lysIdentityEditedAt: Date | null
  /** How Lys addresses the person. */
  readonly personIdentity: PersonIdentity
  /** How answers are written for the person. */
  readonly writingPreferences: WritingPreferences
  /** The person's notes for Lys. */
  readonly notesForLys: NotesForLys
}

/** Actions of the local profile store. */
type LocalProfileActions = {
  /**
   * Changes some of how Lys introduces itself, and records when.
   *
   * @param change - The fields that change.
   */
  readonly updateLysIdentity: (change: Partial<LysIdentity>) => void
  /**
   * Replaces Lys's portrait, and records when.
   *
   * @param portrait - The picked image.
   * @remarks The URL of the replaced portrait is revoked.
   */
  readonly replaceLysPortrait: (portrait: Blob) => void
  /**
   * Changes some of how Lys addresses the person.
   *
   * @param change - The fields that change.
   */
  readonly updatePersonIdentity: (change: Partial<PersonIdentity>) => void
  /**
   * Changes the choice of some writing preferences.
   *
   * @param change - The preferences that change.
   */
  readonly updateWritingPreferences: (
    change: Partial<WritingPreferences>
  ) => void
  /**
   * Changes the notes or whether they go with every request.
   *
   * @param change - The fields that change.
   */
  readonly updateNotesForLys: (change: Partial<NotesForLys>) => void
}

/** Local profile store state and actions. */
export type LocalProfileStore = LocalProfileState & LocalProfileActions

/** Clock and object URLs the store reads, replaced in tests. */
export type LocalProfileStoreDependencies = {
  /** Reads the current time. */
  readonly now: () => Date
  /** Time zone of this machine, which Lys's starts with. */
  readonly machineTimeZone: string
  /**
   * Creates an object URL for an image.
   *
   * @param image - The image.
   * @returns Its URL.
   */
  readonly createObjectUrl: (image: Blob) => string
  /**
   * Revokes an object URL.
   *
   * @param url - The URL.
   */
  readonly revokeObjectUrl: (url: string) => void
}

/**
 * Builds the starting state.
 *
 * @param machineTimeZone - Time zone of this machine.
 * @returns Lys named Lys, writing in English from this machine's time zone,
 * a person without a name, metric preferences, and empty notes sent with
 * every request.
 */
function buildInitialState(machineTimeZone: string): LocalProfileState {
  return {
    lysIdentity: {
      name: "Lys",
      fullName: "",
      timeZone: machineTimeZone,
      writesIn: "English"
    },
    lysPortraitUrl: null,
    lysIdentityEditedAt: null,
    personIdentity: { name: "", callName: "", pronouns: "", reads: "English" },
    writingPreferences: {
      units: "metric",
      temperature: "celsius",
      dates: "day-month-year",
      clock: "24-hour",
      week: "monday"
    },
    notesForLys: { text: "", isSentWithEveryRequest: true }
  }
}

/**
 * Builds the local profile store's starting state and its actions.
 *
 * @param set - Merges a change into the store's state.
 * @param get - Reads the store's state.
 * @param dependencies - Clock, this machine's time zone, and object URLs.
 * @returns The starting state and the actions.
 */
function buildLocalProfileStore(
  set: StoreApi<LocalProfileStore>["setState"],
  get: StoreApi<LocalProfileStore>["getState"],
  dependencies: LocalProfileStoreDependencies
): LocalProfileStore {
  /**
   * Replaces Lys's portrait, revoking the URL of the replaced one, and
   * records when.
   *
   * @param portrait - The picked image.
   */
  function replaceLysPortrait(portrait: Blob): void {
    const replacedUrl = get().lysPortraitUrl
    if (replacedUrl !== null) dependencies.revokeObjectUrl(replacedUrl)
    set({
      lysPortraitUrl: dependencies.createObjectUrl(portrait),
      lysIdentityEditedAt: dependencies.now()
    })
  }

  return {
    ...buildInitialState(dependencies.machineTimeZone),
    updateLysIdentity: (change) =>
      set((state) => ({
        lysIdentity: { ...state.lysIdentity, ...change },
        lysIdentityEditedAt: dependencies.now()
      })),
    replaceLysPortrait,
    updatePersonIdentity: (change) =>
      set((state) => ({
        personIdentity: { ...state.personIdentity, ...change }
      })),
    updateWritingPreferences: (change) =>
      set((state) => ({
        writingPreferences: { ...state.writingPreferences, ...change }
      })),
    updateNotesForLys: (change) =>
      set((state) => ({ notesForLys: { ...state.notesForLys, ...change } }))
  }
}

/**
 * Creates the store of the profile values this renderer keeps for the
 * session: About Lys and its portrait, About you, Preferences, and Notes
 * for Lys.
 *
 * @remarks Nothing in this store is saved or sent: the values last until
 * the window reloads, and no request carries them.
 * @param dependencies - Clock, this machine's time zone, and object URLs.
 * @returns The store.
 */
export function createLocalProfileStore(
  dependencies: LocalProfileStoreDependencies
): UseBoundStore<StoreApi<LocalProfileStore>> {
  return create<LocalProfileStore>((set, get) =>
    buildLocalProfileStore(set, get, dependencies)
  )
}

/** The renderer's local profile store. */
export const useLocalProfileStore: UseBoundStore<StoreApi<LocalProfileStore>> =
  createLocalProfileStore({
    now: () => new Date(),
    machineTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    createObjectUrl: (image) => URL.createObjectURL(image),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url)
  })
