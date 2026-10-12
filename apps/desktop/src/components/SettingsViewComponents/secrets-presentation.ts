import type {
  BackendToolUnavailableReason,
  CheckWebSearchKeyApiResponse,
  TavilyCreditUsage,
  WebSearchKeyCheckFailure
} from "@lys/protocol"
import { tavilyApiKeySchema, type TavilyApiKey } from "@lys/share"

import type {
  SecretsSaveState,
  TavilyKeyCheckState
} from "@/lib/store/secrets-settings"

/** Page where a person creates a Tavily API key. */
export const TAVILY_KEY_PAGE_URL = "https://app.tavily.com"

/** Placeholder of the key field while no key is saved. */
const TAVILY_KEY_PLACEHOLDER = "tvly-…"

/** Bullets that stand for the hidden part of a saved key. */
const KEY_MASK = "••••••••"

/** Fewest characters a key needs before its ends are shown around the mask. */
const MINIMUM_PARTLY_SHOWN_KEY_LENGTH = 16

/** Characters of a key shown before the mask. */
const SHOWN_KEY_PREFIX_LENGTH = 5

/** Characters of a key shown after the mask. */
const SHOWN_KEY_SUFFIX_LENGTH = 4

/** Formats whole numbers the same way on every machine. */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US")

/** Tone of the card's badge and status line. */
export type SecretTone =
  "muted" | "pending" | "attention" | "success" | "danger"

/** State shown on the Tavily card's badge. */
export type TavilyKeyBadge = {
  /** Lowercase badge text. */
  readonly label: "no key" | "in use" | "verified" | "rejected"
  /** Tone of the badge's dot. */
  readonly tone: SecretTone
}

/** The person's edit of the key field. */
export type TavilyKeyDraft =
  | { readonly status: "unedited" }
  | {
      readonly status: "edited"
      /** Text in the field. */
      readonly text: string
    }

/** Facts the card's status line describes. */
export type TavilyKeyStatusInput = {
  /** Saved key, or null. */
  readonly savedApiKey: TavilyApiKey | null
  /** The person's edit of the field. */
  readonly draft: TavilyKeyDraft
  /** Latest save. */
  readonly saveState: SecretsSaveState
  /** Latest check. */
  readonly keyCheck: TavilyKeyCheckState
}

/** One line under the key field. */
export type TavilyKeyMessage = {
  /** Text of the line. */
  readonly text: string
  /** Tone of the line. */
  readonly tone: SecretTone
}

/** Outcome of reading the field's text as a key. */
export type TavilyKeyDraftParse =
  | {
      /** The text, trimmed, is a valid key that differs from the saved one. */
      readonly status: "changed"
      /** The key to save. */
      readonly apiKey: TavilyApiKey
    }
  | {
      /** The field holds nothing to save: unedited, or the saved key again. */
      readonly status: "unchanged"
    }
  | {
      /** The trimmed text is not a valid key. */
      readonly status: "invalid"
    }

/** Why a key check could not tell, by reason, as a clause. */
const KEY_CHECK_FAILURE_CLAUSES = Object.freeze({
  "rate-limited": "Tavily is limiting requests; try again later",
  "timed-out": "Tavily didn't answer in time",
  unreachable: "Tavily couldn't be reached",
  "provider-error": "Tavily answered with an error",
  "invalid-response": "Tavily's answer couldn't be read"
} satisfies Readonly<Record<WebSearchKeyCheckFailure, string>>)

/** What an unavailable answer means, by reason. */
const KEY_UNAVAILABLE_MESSAGES = Object.freeze({
  "api-key-missing": "No key is saved, so nothing was checked.",
  "api-key-invalid":
    "The key in settings.json isn't valid · fix or remove secrets.tavilyApiKey there",
  "settings-unreadable":
    "Lys couldn't read settings.json · fix that file by hand"
} satisfies Readonly<Record<BackendToolUnavailableReason, string>>)

/** Line shown while no key is saved and nothing is edited. */
const NO_KEY_MESSAGE: TavilyKeyMessage = Object.freeze({
  text: "No key yet. web_search stays unavailable to agents until there is one.",
  tone: "muted"
})

/**
 * Formats a saved key for display, masked.
 *
 * @param apiKey - Saved key.
 * @returns The first 5 and last 4 characters around bullets for a key of 16
 * or more characters; bullets only for a shorter one, which would otherwise
 * be shown almost whole.
 */
function formatMaskedTavilyApiKey(apiKey: TavilyApiKey): string {
  if (apiKey.length < MINIMUM_PARTLY_SHOWN_KEY_LENGTH) return KEY_MASK
  return `${apiKey.slice(0, SHOWN_KEY_PREFIX_LENGTH)}${KEY_MASK}${apiKey.slice(-SHOWN_KEY_SUFFIX_LENGTH)}`
}

/**
 * Formats the key field's placeholder.
 *
 * @param savedApiKey - Saved key, or null.
 * @returns The masked saved key, or an example of a key's start while none is
 * saved.
 */
export function formatTavilyKeyPlaceholder(
  savedApiKey: TavilyApiKey | null
): string {
  return savedApiKey === null
    ? TAVILY_KEY_PLACEHOLDER
    : formatMaskedTavilyApiKey(savedApiKey)
}

/**
 * Calculates the text in the key field.
 *
 * @param draft - The person's edit.
 * @param isKeyShown - Whether the person asked to see the key.
 * @param savedApiKey - Saved key, or null.
 * @returns The edited text; otherwise the saved key while it is shown; empty
 * otherwise, so the masked placeholder shows.
 */
export function calculateTavilyKeyFieldValue(
  draft: TavilyKeyDraft,
  isKeyShown: boolean,
  savedApiKey: TavilyApiKey | null
): string {
  if (draft.status === "edited") return draft.text
  return isKeyShown && savedApiKey !== null ? savedApiKey : ""
}

/**
 * Reads the field's text as a key to save.
 *
 * @param draft - The person's edit.
 * @param savedApiKey - Saved key, or null.
 * @returns `changed` with the trimmed key when it is valid and differs from
 * the saved one, `unchanged` when there is nothing to save, or `invalid`.
 * Surrounding whitespace is the only change made to the text.
 */
export function parseTavilyKeyDraft(
  draft: TavilyKeyDraft,
  savedApiKey: TavilyApiKey | null
): TavilyKeyDraftParse {
  if (draft.status === "unedited") return { status: "unchanged" }
  const trimmed = draft.text.trim()
  if (trimmed === "" || trimmed === savedApiKey) return { status: "unchanged" }
  const parsed = tavilyApiKeySchema.safeParse(trimmed)
  return parsed.success
    ? { status: "changed", apiKey: parsed.data }
    : { status: "invalid" }
}

/**
 * Calculates the badge of the Tavily card.
 *
 * @param savedApiKey - Saved key, or null.
 * @param keyCheck - Latest check.
 * @returns `no key` without a key; `verified` or `rejected` after a check
 * that said so; `in use` otherwise.
 */
export function calculateTavilyKeyBadge(
  savedApiKey: TavilyApiKey | null,
  keyCheck: TavilyKeyCheckState
): TavilyKeyBadge {
  if (savedApiKey === null) return { label: "no key", tone: "attention" }
  if (keyCheck.status === "checked" && keyCheck.outcome.status === "accepted") {
    return { label: "verified", tone: "success" }
  }
  if (keyCheck.status === "checked" && keyCheck.outcome.status === "rejected") {
    return { label: "rejected", tone: "danger" }
  }
  return { label: "in use", tone: "success" }
}

/**
 * Formats an accepted key's line.
 *
 * @param credits - Plan credits, or null.
 * @returns "key accepted", with the credits used of the plan's when known.
 */
function formatAcceptedKeyText(credits: TavilyCreditUsage | null): string {
  if (credits === null) return "key accepted"
  const used = NUMBER_FORMAT.format(credits.used)
  return credits.limit === null
    ? `key accepted · ${used} credits used`
    : `key accepted · ${used} of ${NUMBER_FORMAT.format(credits.limit)} credits used`
}

/**
 * Formats the line of a check the backend answered.
 *
 * @param outcome - Backend's answer.
 * @returns The line for that outcome.
 */
function formatKeyCheckOutcome(
  outcome: CheckWebSearchKeyApiResponse
): TavilyKeyMessage {
  switch (outcome.status) {
    case "accepted":
      return { text: formatAcceptedKeyText(outcome.credits), tone: "success" }
    case "rejected":
      return {
        text: "Tavily rejected this key · check it and save again",
        tone: "danger"
      }
    case "unavailable":
      return { text: KEY_UNAVAILABLE_MESSAGES[outcome.reason], tone: "danger" }
    case "failed":
      return {
        text: `couldn't check the key: ${KEY_CHECK_FAILURE_CLAUSES[outcome.reason]}`,
        tone: "danger"
      }
  }
}

/**
 * Formats the line of the latest check, or undefined when it has nothing to
 * say.
 *
 * @param keyCheck - Latest check.
 * @returns The line, or undefined before any check.
 */
function formatKeyCheckMessage(
  keyCheck: TavilyKeyCheckState
): TavilyKeyMessage | undefined {
  switch (keyCheck.status) {
    case "idle":
      return undefined
    case "checking":
      return { text: "checking with tavily…", tone: "pending" }
    case "checked":
      return formatKeyCheckOutcome(keyCheck.outcome)
    case "failed":
      return {
        text: `couldn't check the key: ${keyCheck.error}`,
        tone: "danger"
      }
  }
}

/**
 * Formats the line under the key field.
 *
 * @param input - Saved key, edit, save, and check.
 * @returns, in order of precedence: what an edit means (invalid, or unsaved
 * with how to save or discard); a running or failed save; the latest check;
 * then the masked saved key or that no key is saved.
 */
export function formatTavilyKeyMessage(
  input: TavilyKeyStatusInput
): TavilyKeyMessage {
  const draft = parseTavilyKeyDraft(input.draft, input.savedApiKey)
  if (draft.status === "invalid") {
    return {
      text: "not a valid key: paste it exactly as Tavily shows it, without spaces",
      tone: "danger"
    }
  }
  if (draft.status === "changed") {
    return {
      text: "unsaved · enter to save, esc to discard",
      tone: "attention"
    }
  }
  if (input.saveState.status === "saving")
    return { text: "saving…", tone: "pending" }
  if (input.saveState.status === "failed")
    return { text: input.saveState.error, tone: "danger" }
  const checkMessage = formatKeyCheckMessage(input.keyCheck)
  if (checkMessage !== undefined) return checkMessage
  if (input.savedApiKey === null) return NO_KEY_MESSAGE
  return {
    text: `saved · ${formatMaskedTavilyApiKey(input.savedApiKey)}`,
    tone: "muted"
  }
}
