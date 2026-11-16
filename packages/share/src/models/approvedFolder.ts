import * as z from "zod"

/**
 * Most characters, counted as Unicode code points, an approved folder's path
 * may have, inclusive: macOS's longest path, 1024 bytes, for a path in ASCII.
 *
 * @remarks The settings file never holds a longer path: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file. Raising it changes which settings files load and requires a
 * coordinated desktop release.
 */
export const MAXIMUM_APPROVED_FOLDER_PATH_LENGTH = 1024

/** Finds a control character (Unicode general category Cc), such as a line break. */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

/** Finds white space (Unicode White_Space) at the end of a text. */
const TRAILING_WHITE_SPACE_PATTERN = /\p{White_Space}$/u

/**
 * Answers whether a text follows the approved folder path rule: it starts
 * with `/`, has 1 to {@link MAXIMUM_APPROVED_FOLDER_PATH_LENGTH} code points,
 * no control character, and no white space at its end.
 *
 * @param value - Text to inspect, as typed.
 * @returns True when the text is a valid approved folder path.
 */
function isApprovedFolderPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    [...value].length <= MAXIMUM_APPROVED_FOLDER_PATH_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !TRAILING_WHITE_SPACE_PATTERN.test(value)
  )
}

/**
 * Validates the path of a folder the person lets tools use, as they typed
 * it: an absolute path on this machine.
 *
 * @remarks The rule matches the desktop host's `ApprovedFolder`. Parsing
 * never trims, normalizes, or resolves the path; a caller that wants trimmed
 * input trims it first, and each consumer resolves `.` and `..` parts its own
 * way: the backend's tool call policy by text, the host's file tools by the
 * real path on disk. Whether the folder exists is not checked. The path is
 * personal data.
 */
export const approvedFolderPathSchema = z
  .string()
  .refine(
    isApprovedFolderPath,
    `A folder is an absolute path that starts with /, at most ${MAXIMUM_APPROVED_FOLDER_PATH_LENGTH} characters, without line breaks or other control characters, and without spaces at its end.`
  )
