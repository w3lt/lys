import { randomInt } from "node:crypto"

/**
 * The lines Lys says when a reply finished in the background before she
 * said anything. Each is spoken exactly as written; one is picked at
 * random per notification. They are never stored.
 */
const NOTIFICATION_LINES: readonly string[] = Object.freeze([
  "Master, your response is ready.",
  "Master, I've finished my answer.",
  "Your answer is waiting for you, Master.",
  "I'm done, Master. Come and see."
])

/**
 * Picks the line a notification speaks.
 *
 * @returns One of {@link NOTIFICATION_LINES}, uniformly at random.
 */
export function getNotificationLine(): string {
  const line = NOTIFICATION_LINES[randomInt(NOTIFICATION_LINES.length)]
  if (line === undefined)
    throw new RangeError("notification line index out of range")
  return line
}
