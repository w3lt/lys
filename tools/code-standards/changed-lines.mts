/**
 * Lines of a file's new version that a change touched.
 *
 * @remarks A range of changed lines has integer bounds. A deletion between
 * two lines is the range from and to the half line between them, so it
 * overlaps exactly the constructs that span both neighboring lines.
 */
export type LineRange = {
  /** First changed line, counted from 1, or a half line for a deletion. */
  readonly start: number

  /** Last changed line, inclusive. */
  readonly end: number
}

/** One file that a change added or modified, with its changed lines. */
export type ChangedFile = {
  /** Repository-relative path of the file's new version. */
  readonly path: string

  /** Changed lines of the new version, in file order. */
  readonly ranges: readonly LineRange[]
}

/** Range that covers every line of a file the change added in full. */
export const wholeFileRange: LineRange = Object.freeze({
  start: 1,
  end: Number.POSITIVE_INFINITY
})

/** Hunk header of a unified diff; captures the new start and line count. */
const hunkHeaderPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm

/** Line naming the new version of a file in a unified diff's file header. */
const newPathPattern = /^\+\+\+ (.+)$/m

/**
 * Decodes the new-version path of a diff file header.
 *
 * @remarks Git quotes a path that contains a quote, backslash, or control
 * character, using the escapes JSON shares; the diff must be produced with
 * `core.quotePath=false` so other characters stay unescaped.
 * @param rawPath - Text after `+++ ` in the file header.
 * @returns The repository-relative path, or `null` for a deleted file.
 */
function decodeNewPath(rawPath: string): string | null {
  const decoded: unknown = rawPath.startsWith('"')
    ? JSON.parse(rawPath)
    : rawPath
  if (typeof decoded !== "string" || !decoded.startsWith("b/")) {
    return null
  }
  return decoded.slice("b/".length)
}

/**
 * Converts a hunk header to the lines it changes in the new version.
 *
 * @param match - Match of the hunk header pattern.
 * @returns The changed lines, or the half line of a pure deletion.
 */
function hunkRange(match: RegExpMatchArray): LineRange {
  const start = Number(match[1])
  const count = Number(match[2] ?? "1")
  if (count === 0) {
    return Object.freeze({ start: start + 0.5, end: start + 0.5 })
  }
  return Object.freeze({ start, end: start + count - 1 })
}

/**
 * Parses the part of a unified diff that describes one file.
 *
 * @param section - Text from one `diff --git` line to the next.
 * @returns The file's new path and changed lines, or `null` for a deleted
 * file or a section without a new path.
 */
function parseFileSection(section: string): ChangedFile | null {
  const headerEnd = section.search(/^@@ /m)
  const header = headerEnd === -1 ? section : section.slice(0, headerEnd)
  const rawPath = newPathPattern.exec(header)?.[1]
  const path = rawPath === undefined ? null : decodeNewPath(rawPath)
  if (path === null) {
    return null
  }
  const ranges = [...section.matchAll(hunkHeaderPattern)].map(hunkRange)
  return Object.freeze({ path, ranges: Object.freeze(ranges) })
}

/**
 * Parses a unified diff produced with zero context lines.
 *
 * @param diff - Output of `git diff -U0` with `core.quotePath=false`.
 * @returns Every added or modified file with its changed lines. A file whose
 * change has no hunk, such as a pure rename, has no changed line.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  return diff
    .split(/^(?=diff --git )/m)
    .map(parseFileSection)
    .filter((file) => file !== null)
}

/**
 * Tells whether a construct's lines overlap a change.
 *
 * @param firstLine - First line of the construct.
 * @param lastLine - Last line of the construct.
 * @param ranges - Changed lines of the construct's file.
 * @returns Whether a changed line, or a deletion between two of the
 * construct's lines, falls inside the construct.
 */
export function overlapsChange(
  firstLine: number,
  lastLine: number,
  ranges: readonly LineRange[]
): boolean {
  return ranges.some(
    (range) => firstLine <= range.end && lastLine >= range.start
  )
}
