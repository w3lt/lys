import type {
  NotesForLys,
  PersonIdentity,
  WritingPreference,
  WritingPreferences
} from "@/lib/store/local-profile"
import type { LocationSettings } from "@/lib/store/settings"

import { findLocationPrecision, LOCATION_PARTS } from "./location-presentation"

/** One choice of a writing preference. */
export type WritingPreferenceChoice = {
  /** Value the choice stands for. */
  readonly value: string
  /** Text of the choice. */
  readonly label: string
}

/** One row of the Preferences section. */
export type WritingPreferenceRow = {
  /** The preference. */
  readonly preference: WritingPreference
  /** Label of the row. */
  readonly label: string
  /** What the preference changes. */
  readonly help: string
  /** The choices, in order. */
  readonly choices: readonly WritingPreferenceChoice[]
}

/** Most characters the notes for Lys hold. */
export const MAXIMUM_NOTES_LENGTH = 1000

/** Rows of the Preferences section, in order. */
export const WRITING_PREFERENCE_ROWS: readonly WritingPreferenceRow[] =
  Object.freeze([
    {
      preference: "units",
      label: "Units",
      help: "Distances, weights and volumes.",
      choices: [
        { value: "metric", label: "Metric" },
        { value: "imperial", label: "Imperial" }
      ]
    },
    {
      preference: "temperature",
      label: "Temperature",
      help: "In weather and recipes.",
      choices: [
        { value: "celsius", label: "°C" },
        { value: "fahrenheit", label: "°F" }
      ]
    },
    {
      preference: "dates",
      label: "Dates",
      help: "How a day is written.",
      choices: [
        { value: "day-month-year", label: "14/11/2026" },
        { value: "month-day-year", label: "11/14/2026" },
        { value: "iso", label: "2026-11-14" }
      ]
    },
    {
      preference: "clock",
      label: "Time",
      help: "How a time of day is written.",
      choices: [
        { value: "24-hour", label: "17:05" },
        { value: "12-hour", label: "5:05 pm" }
      ]
    },
    {
      preference: "week",
      label: "Week starts on",
      help: 'For calendars and "next week".',
      choices: [
        { value: "monday", label: "Monday" },
        { value: "sunday", label: "Sunday" }
      ]
    }
  ])

/** Tokens of the frame around the notes in a request. */
const NOTES_FRAME_TOKENS = 6

/** How each written day looks. */
const DATE_SAMPLES = Object.freeze({
  "day-month-year": "14/11/2026",
  "month-day-year": "11/14/2026",
  iso: "2026-11-14"
} satisfies Readonly<Record<WritingPreferences["dates"], string>>)

/**
 * Estimates the tokens a text takes.
 *
 * @param text - The text.
 * @returns About one token for each four characters, rounded up.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Formats what Lys calls the person.
 *
 * @param identity - How Lys addresses the person.
 * @returns What Lys calls them, otherwise their name, otherwise `you`.
 */
export function formatPersonDisplayName(identity: PersonIdentity): string {
  const callName = identity.callName.trim()
  if (callName !== "") return callName
  const name = identity.name.trim()
  return name === "" ? "you" : name
}

/**
 * Estimates the tokens the profile adds to every request.
 *
 * @param identity - How Lys addresses the person.
 * @param notes - The person's notes for Lys.
 * @returns About you, the preferences, and the notes while they are sent.
 */
export function estimateEveryRequestTokens(
  identity: PersonIdentity,
  notes: NotesForLys
): number {
  /** Tokens of the frame around About you. */
  const aboutYouFrameTokens = 18
  /** Tokens of the preferences. */
  const preferencesTokens = 24
  const aboutYouTokens = estimateTokens(
    identity.name + identity.callName + identity.pronouns + identity.reads
  )
  const notesTokens =
    notes.isSentWithEveryRequest && notes.text !== ""
      ? estimateTokens(notes.text) + NOTES_FRAME_TOKENS
      : 0
  return aboutYouFrameTokens + aboutYouTokens + preferencesTokens + notesTokens
}

/**
 * Lists what goes with every request.
 *
 * @param identity - How Lys addresses the person.
 * @param notes - The person's notes for Lys.
 * @returns A sentence naming the parts of the profile sent each time.
 */
export function formatEveryRequestList(
  identity: PersonIdentity,
  notes: NotesForLys
): string {
  const pronouns = identity.pronouns.trim() === "" ? "" : ", pronouns"
  const isNotesSent = notes.isSentWithEveryRequest && notes.text !== ""
  return `Your name${pronouns}, languages and preferences${isNotesSent ? ", and your notes." : "."}`
}

/**
 * Formats the part of the location a model gets first when it asks.
 *
 * @param location - Saved location.
 * @returns The most precise saved part, or `Nothing`.
 */
export function formatAskedLocation(location: LocationSettings): string {
  return LOCATION_PARTS.flatMap((part) => location[part] ?? [])[0] ?? "Nothing"
}

/**
 * Formats the closed model view section's summary.
 *
 * @param tokens - Tokens the profile adds to every request.
 * @param location - Saved location.
 * @returns The tokens, and whether a location is shared when asked.
 */
export function formatModelViewSummary(
  tokens: number,
  location: LocationSettings
): string {
  const isLocationSaved = LOCATION_PARTS.some((part) => location[part] !== null)
  return `~${tokens} tokens with every request · ${isLocationSaved ? "location only when asked" : "location never shared"}`
}

/**
 * Formats the closed About you section's summary.
 *
 * @param identity - How Lys addresses the person.
 * @returns What Lys calls the person, their pronouns, and what they read,
 * joined by middle dots.
 */
export function formatAboutYouSummary(identity: PersonIdentity): string {
  return [
    formatPersonDisplayName(identity),
    identity.pronouns.trim(),
    identity.reads.trim()
  ]
    .filter((part) => part !== "")
    .join(" · ")
}

/**
 * Formats the closed Location section's summary.
 *
 * @param location - Saved location.
 * @returns The saved parts and how precisely they are shared, or that
 * nothing is saved.
 */
export function formatLocationSummary(location: LocationSettings): string {
  const parts = LOCATION_PARTS.flatMap((part) => location[part] ?? [])
  if (parts.length === 0) return "Nothing saved yet"
  return `${parts.join(", ")} · shared down to ${findLocationPrecision(location)}`
}

/**
 * Formats the closed Preferences section's summary.
 *
 * @param preferences - The choice of each preference.
 * @returns Each choice in a few words, joined by middle dots.
 */
export function formatPreferencesSummary(
  preferences: WritingPreferences
): string {
  return [
    preferences.units === "metric" ? "Metric" : "Imperial",
    preferences.temperature === "celsius" ? "°C" : "°F",
    DATE_SAMPLES[preferences.dates],
    preferences.clock,
    `weeks from ${preferences.week === "monday" ? "Monday" : "Sunday"}`
  ].join(" · ")
}

/**
 * Formats how a model writes with the preferences.
 *
 * @param preferences - The choice of each preference.
 * @returns One sentence with a sample of each choice.
 */
export function formatPreferencesPreview(
  preferences: WritingPreferences
): string {
  const time = preferences.clock === "24-hour" ? "17:05" : "5:05 pm"
  const distances = preferences.units === "metric" ? "kilometres" : "miles"
  const weather = preferences.temperature === "celsius" ? "°C" : "°F"
  const week = preferences.week === "monday" ? "Monday" : "Sunday"
  return `Dates like ${DATE_SAMPLES[preferences.dates]} at ${time}, distances in ${distances}, weather in ${weather}, weeks from ${week}.`
}

/**
 * Formats the closed Notes for Lys section's summary.
 *
 * @param notes - The person's notes for Lys.
 * @returns The length of the notes and whether they are sent.
 */
export function formatNotesSummary(notes: NotesForLys): string {
  const length =
    notes.text === "" ? "No notes yet" : `${notes.text.length} characters`
  return `${length} · ${notes.isSentWithEveryRequest ? "sent with every request" : "not sent"}`
}

/**
 * Formats the line under the notes.
 *
 * @param notes - The person's notes for Lys.
 * @returns Whether the notes are sent, and the tokens they add.
 */
export function formatNotesHelp(notes: NotesForLys): string {
  if (!notes.isSentWithEveryRequest) {
    return "Kept here, not sent. Switch it on to add it to every request."
  }
  return notes.text === ""
    ? "Empty notes add nothing to a request."
    : `~${estimateTokens(notes.text) + NOTES_FRAME_TOKENS} tokens with every request.`
}
