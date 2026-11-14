import type { EmailAccount } from "@lys/share"

import { findEmailPreset } from "@/lib/models/email-presets"
import {
  isEmailAccountCheckAccepted,
  type EmailAccountCheckState,
  type EmailAccountSaveState
} from "@/lib/store/email-settings"
import type { LysIdentity } from "@/lib/store/local-profile"

import type { SettingsRailTone } from "./LeftBar"

/** A line with the color of its state. */
export type LysPaneMessage = {
  /** Text of the line. */
  readonly text: string
  /** Color of its state. */
  readonly tone: SettingsRailTone
}

/**
 * Formats a time of day as hours and minutes on a 24-hour clock.
 *
 * @param date - The moment.
 * @returns The local time, such as `13:42`.
 */
export function formatClockTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date)
}

/**
 * Formats a time zone's offset from UTC at a moment.
 *
 * @param timeZone - IANA time zone.
 * @param at - The moment, which daylight saving time depends on.
 * @returns The offset, such as `UTC+01:00`, or `UTC+00:00` for UTC itself.
 */
export function formatTimeZoneOffset(timeZone: string, at: Date): string {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value
  return offset === undefined || offset === "GMT"
    ? "UTC+00:00"
    : offset.replace("GMT", "UTC")
}

/**
 * Lists the time zones Lys can write in.
 *
 * @param currentTimeZone - The zone chosen now, which is listed even when
 * this runtime does not know it.
 * @returns Every IANA zone this runtime knows, in its order, with the
 * current one.
 */
export function listTimeZones(currentTimeZone: string): readonly string[] {
  const timeZones = Intl.supportedValuesOf("timeZone")
  return timeZones.includes(currentTimeZone)
    ? timeZones
    : [currentTimeZone, ...timeZones]
}

/**
 * Formats the closed About Lys section's summary.
 *
 * @param identity - How Lys introduces itself.
 * @returns The name, full name, time zone, and languages that are not
 * empty, joined by middle dots.
 */
export function formatLysIdentitySummary(identity: LysIdentity): string {
  return [
    identity.name,
    identity.fullName,
    identity.timeZone,
    identity.writesIn
  ]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" · ")
}

/**
 * Formats the closed Email section's summary.
 *
 * @param account - Lys's saved account, or null.
 * @returns `No mailbox yet` without an account; otherwise the address and
 * where Lys reads mail: the provider when the address names a known one,
 * and the incoming server otherwise.
 */
export function formatLysMailboxSummary(account: EmailAccount | null): string {
  if (account === null) return "No mailbox yet"
  const provider = findEmailPreset(account.address)?.name
  return `${account.address} · ${provider ?? `${account.imap.host}:${account.imap.port}`}`
}

/**
 * Formats the line that says what the latest save or check of Lys's
 * mailbox found, under its summary.
 *
 * @param saveState - Latest save or removal.
 * @param checkState - Latest check.
 * @returns A running check or save; a failed save or check; what the
 * latest check found; or that saving signed in to both servers.
 */
export function formatLysMailboxCheckMessage(
  saveState: EmailAccountSaveState,
  checkState: EmailAccountCheckState
): LysPaneMessage {
  if (checkState.status === "checking") {
    return { text: "Signing in to IMAP and SMTP…", tone: "pending" }
  }
  if (saveState.status === "saving") return { text: "Saving…", tone: "pending" }
  if (saveState.status === "failed") {
    return { text: saveState.error, tone: "danger" }
  }
  if (checkState.status === "failed") {
    return { text: checkState.error, tone: "danger" }
  }
  if (checkState.status === "checked") {
    return isEmailAccountCheckAccepted(checkState.outcome)
      ? { text: "Both servers answered the latest check.", tone: "success" }
      : {
          text: "A server refused the latest check. Edit servers to see why.",
          tone: "danger"
        }
  }
  return {
    text: "Lys signed in to both servers when this mailbox was saved.",
    tone: "neutral"
  }
}
