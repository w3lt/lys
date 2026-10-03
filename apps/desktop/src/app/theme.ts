import {
  isSameLysPersonalityPeriod,
  lysPersonalityPeriodSchema,
  type LysPersonality,
  type LysPersonalityPeriod
} from "@lys/share"

/** Supported document appearance modes, the authority for {@link Theme}. */
const THEMES = ["dark", "light"] as const

/** Supported document appearance mode. */
export type Theme = (typeof THEMES)[number]

/**
 * Theme the person selected, with the period of Lys's personality during
 * which they selected it.
 *
 * @remarks The choice applies only while that period lasts. When a new
 * period begins, the theme of its side applies until the person selects
 * again.
 */
export type ThemeChoice = {
  /** Theme selected with the title-bar toggle. */
  readonly theme: Theme
  /** Period that was current when the theme was selected. */
  readonly personalityPeriod: LysPersonalityPeriod
}

/**
 * Local-storage key holding the person's latest theme choice as JSON.
 *
 * @remarks Earlier versions stored a plain theme name under `lys.theme`.
 * That key is no longer read or written, so such a value is ignored.
 */
const THEME_CHOICE_STORAGE_KEY = "lys.themeChoice"

/**
 * Schema version of the stored theme choice that this release writes and
 * reads. A stored choice with any other version is not applied.
 */
const THEME_CHOICE_SCHEMA_VERSION = 1

/**
 * Properties of a stored theme choice, the authority for
 * {@link StoredThemeChoiceRecord}; a stored record has exactly these keys.
 */
const STORED_THEME_CHOICE_KEYS = [
  "schemaVersion",
  "theme",
  "personalityPeriod"
] as const

/**
 * Record with exactly the stored theme-choice properties, whose values are
 * not yet validated.
 */
type StoredThemeChoiceRecord = Readonly<
  Record<(typeof STORED_THEME_CHOICE_KEYS)[number], unknown>
>

/**
 * Calculates the theme that matches a side of Lys's personality.
 *
 * @param personality - Side of Lys whose theme is needed.
 * @returns The dark theme for Caliginia and the light theme for Lysiptera.
 */
function calculateSideTheme(personality: LysPersonality): Theme {
  switch (personality) {
    case "dark":
      return "dark"
    case "light":
      return "light"
  }
}

/**
 * Calculates the theme shown during a period of Lys's personality.
 *
 * @param themeChoice - Latest choice the person made, or `undefined` when
 * none is known.
 * @param personalityPeriod - Current period read from the desktop host.
 * @returns The chosen theme when it was chosen during the current period;
 * otherwise the theme of the current side.
 */
export function calculateTheme(
  themeChoice: ThemeChoice | undefined,
  personalityPeriod: LysPersonalityPeriod
): Theme {
  return themeChoice !== undefined &&
    isSameLysPersonalityPeriod(themeChoice.personalityPeriod, personalityPeriod)
    ? themeChoice.theme
    : calculateSideTheme(personalityPeriod.personality)
}

/**
 * Checks whether an untrusted value names a supported theme.
 *
 * @param value - Value read from storage.
 * @returns Whether the value is one of {@link THEMES}.
 */
function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value)
}

/**
 * Checks whether an untrusted value is a record with exactly the stored
 * theme-choice properties.
 *
 * @param value - Value decoded from storage.
 * @returns Whether the value is an object whose keys are exactly
 * {@link STORED_THEME_CHOICE_KEYS}; their values remain unchecked.
 */
function isStoredThemeChoiceRecord(
  value: unknown
): value is StoredThemeChoiceRecord {
  if (typeof value !== "object" || value === null) return false

  const keys = Object.keys(value)

  return (
    keys.length === STORED_THEME_CHOICE_KEYS.length &&
    STORED_THEME_CHOICE_KEYS.every((key) => keys.includes(key))
  )
}

/**
 * Parses a value decoded from storage into a theme choice.
 *
 * @param storedValue - JSON value read from storage.
 * @returns The validated choice, or `undefined` when the value is not a
 * complete choice of the supported schema version.
 */
function parseThemeChoice(storedValue: unknown): ThemeChoice | undefined {
  if (
    !isStoredThemeChoiceRecord(storedValue) ||
    storedValue.schemaVersion !== THEME_CHOICE_SCHEMA_VERSION ||
    !isTheme(storedValue.theme)
  ) {
    return undefined
  }

  const personalityPeriod = lysPersonalityPeriodSchema.safeParse(
    storedValue.personalityPeriod
  )

  return personalityPeriod.success
    ? { theme: storedValue.theme, personalityPeriod: personalityPeriod.data }
    : undefined
}

/**
 * Finds the theme choice the person made in an earlier session.
 *
 * @returns The stored choice, or `undefined` when none is stored, the stored
 * value is not a complete choice of the supported schema version, or storage
 * is unavailable. The theme then follows the current side.
 */
export function findStoredThemeChoice(): ThemeChoice | undefined {
  try {
    const storedChoice = window.localStorage.getItem(THEME_CHOICE_STORAGE_KEY)

    return storedChoice === null
      ? undefined
      : parseThemeChoice(JSON.parse(storedChoice))
  } catch {
    // Unavailable storage and undecodable text both leave no usable choice.
    return undefined
  }
}

/**
 * Saves the person's theme choice for later sessions, replacing any earlier
 * choice.
 *
 * @param themeChoice - Choice to store with the current schema version.
 * @throws If local storage is unavailable or refuses the write.
 */
export function saveThemeChoice(themeChoice: ThemeChoice): void {
  const storedThemeChoice = {
    schemaVersion: THEME_CHOICE_SCHEMA_VERSION,
    theme: themeChoice.theme,
    personalityPeriod: themeChoice.personalityPeriod
  } satisfies StoredThemeChoiceRecord

  window.localStorage.setItem(
    THEME_CHOICE_STORAGE_KEY,
    JSON.stringify(storedThemeChoice)
  )
}
