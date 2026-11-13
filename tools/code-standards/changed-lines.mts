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
 * `core.quotePath=false` so other characters stay unescaped. Git ends a path
 * that contains a space with a tab. A tab inside a path is always quoted, so
 * a final tab is never part of the path.
 * @param rawPath - Text after `+++ ` in the file header.
 * @returns The repository-relative path, or `null` for a deleted file.
 */
function decodeNewPath(rawPath: string): string | null {
  const quotedPath = rawPath.endsWith("\t") ? rawPath.slice(0, -1) : rawPath
  const decoded: unknown = quotedPath.startsWith('"')
    ? JSON.parse(quotedPath)
    : quotedPath
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
 * change has no hunk, such as a pure rename or a mode change, is left out.
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

/**
 * Finds the lines two ranges share.
 *
 * @param first - One range of changed lines.
 * @param second - Another range of the same file version.
 * @returns The shared lines, or `null` when the ranges do not meet.
 */
function rangeOverlap(first: LineRange, second: LineRange): LineRange | null {
  const start = Math.max(first.start, second.start)
  const end = Math.min(first.end, second.end)
  return start <= end ? Object.freeze({ start, end }) : null
}

/**
 * Keeps the lines that one version of the files changed against both of two
 * other versions, such as a merge resolution against each parent.
 *
 * @remarks Both lists describe the same new versions, so their line numbers
 * agree. A file missing from either list equals that list's old version, so
 * none of its lines changed against both.
 * @param first - Changed files against the first old version.
 * @param second - Changed files against the second old version.
 * @returns The files with at least one line changed against both versions.
 */
export function intersectChanges(
  first: readonly ChangedFile[],
  second: readonly ChangedFile[]
): ChangedFile[] {
  const secondRanges = new Map(second.map((file) => [file.path, file.ranges]))
  return first
    .map((file) => {
      const otherRanges = secondRanges.get(file.path) ?? []
      const ranges = file.ranges.flatMap((range) =>
        otherRanges.map((other) => rangeOverlap(range, other))
      )
      const shared = ranges.filter((range) => range !== null)
      return Object.freeze({ path: file.path, ranges: Object.freeze(shared) })
    })
    .filter((file) => file.ranges.length > 0)
}
