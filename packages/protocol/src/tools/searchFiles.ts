import * as z from "zod"

/** Validates a count reported by the desktop, which fits a safe integer. */
const searchFilesCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

/**
 * Validates the search request sent as the `filter` argument of the desktop
 * `find_files` command, which implements the search-files tool.
 *
 * @remarks The schema checks only the filter's shape. The desktop owns the
 * query and limit rules: it rejects a blank, multiline, or overlong query and
 * limits outside its accepted ranges with a declared failure from
 * {@link searchFilesErrorSchema}, and it applies its own default to each
 * omitted limit. Unknown keys are rejected because the desktop rejects them
 * too.
 */
export const searchFilesFilterSchema = z
  .strictObject({
    /**
     * Absolute path of the directory whose tree is searched. Symbolic links
     * are followed for this root only.
     */
    root: z.string(),
    /** Text to find, compared case-insensitively after Unicode lowercasing. */
    query: z.string(),
    /** Part of each regular file compared with the query. */
    target: z.enum(["name", "content", "nameAndContent"]),
    /** Maximum number of matching files to report; omission selects the desktop's default. */
    maxResults: searchFilesCountSchema.optional(),
    /**
     * Maximum number of matching lines reported per file; omission selects
     * the desktop's default. Unused when `target` is `name`.
     */
    maxSnippetsPerFile: searchFilesCountSchema.optional()
  })
  .readonly()

/** Search request sent as the `filter` argument of the desktop `find_files` command. */
export type SearchFilesFilter = z.infer<typeof searchFilesFilterSchema>

/** Validates one line of a file that contains the query. */
const contentSnippetSchema = z
  .strictObject({
    /** One-based number of the line, where lines end at `\n` or `\r\n`. */
    lineNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /**
     * The whole line without its line ending, or, when the line exceeds the
     * desktop's snippet length, the part around the first match.
     */
    text: z.string(),
    /** Whether `text` is only part of a longer line. */
    isPartialLine: z.boolean()
  })
  .readonly()

/** Validates the first matching lines of one file, in file order. */
const contentSnippetsSchema = z.array(contentSnippetSchema).min(1).readonly()

/**
 * Validates one matching regular file, identified by what matched.
 *
 * @remarks `path` is absolute and starts with the search root as it was
 * given, so it can be passed to `read_text_file`.
 */
const fileMatchSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      /**
       * The file's name contains the query; its content does not, or was not
       * compared.
       */
      kind: z.literal("name"),
      /** Absolute path of the file. */
      path: z.string().min(1)
    })
    .readonly(),
  z
    .strictObject({
      /**
       * The file's content contains the query; its name does not, or was not
       * compared.
       */
      kind: z.literal("content"),
      /** Absolute path of the file. */
      path: z.string().min(1),
      /** The first matching lines in file order. */
      snippets: contentSnippetsSchema
    })
    .readonly(),
  z
    .strictObject({
      /** Both the file's name and its content contain the query. */
      kind: z.literal("nameAndContent"),
      /** Absolute path of the file. */
      path: z.string().min(1),
      /** The first matching lines in file order. */
      snippets: contentSnippetsSchema
    })
    .readonly()
])

/**
 * Validates the report that the desktop `find_files` command returns.
 *
 * @remarks The report observes the tree while it was walked. Directories are
 * walked breadth-first without following symbolic links, so matches appear
 * shallowest first and, within a directory, in byte order of their names.
 * `completion` tells whether more matches may exist.
 */
export const searchFilesReportSchema = z
  .strictObject({
    /** Matching files in traversal order, at most the requested maximum. */
    matches: z.array(fileMatchSchema).readonly(),
    /**
     * Why the search ended: `complete` after examining every entry that was
     * not skipped, `resultLimitReached` after finding the requested number of
     * matches, or `scanLimitReached` when the desktop's entry or content-byte
     * budget ran out first.
     */
    completion: z.enum(["complete", "resultLimitReached", "scanLimitReached"]),
    /**
     * Entries that could not be examined: directories that could not be
     * listed, entries whose type or content could not be read, and entries
     * whose path is not valid UTF-8.
     */
    skippedPathCount: searchFilesCountSchema,
    /**
     * Files whose content was not searched because they exceed the desktop's
     * content-search size limit; their names were still compared when the
     * target includes names.
     */
    oversizedFileCount: searchFilesCountSchema
  })
  .readonly()

/** Report that the desktop `find_files` command returns. */
export type SearchFilesReport = z.infer<typeof searchFilesReportSchema>

/**
 * Validates a failure that the desktop `find_files` command declares.
 *
 * @remarks This mirrors the desktop's serialized failure. `code` identifies
 * the failure and is the only field consumers should branch on; the other
 * fields belong to that code. A failure means that no search ran or that it
 * stopped without a report. `message` is display text from the operating
 * system or the async runtime and is not a stable contract. Adding a code is
 * a compatibility change for consumers that branch exhaustively.
 */
export const searchFilesErrorSchema = z.discriminatedUnion("code", [
  z
    .strictObject({
      /** The root is not an absolute path. */
      code: z.literal("rootNotAbsolute")
    })
    .readonly(),
  z
    .strictObject({
      /** Nothing exists at the root path. */
      code: z.literal("rootNotFound")
    })
    .readonly(),
  z
    .strictObject({
      /** The root exists but is not a directory. */
      code: z.literal("rootNotADirectory")
    })
    .readonly(),
  z
    .strictObject({
      /** The operating system denied access to the root directory. */
      code: z.literal("permissionDenied")
    })
    .readonly(),
  z
    .strictObject({
      /** The query is empty or contains only whitespace. */
      code: z.literal("emptyQuery")
    })
    .readonly(),
  z
    .strictObject({
      /** The query contains a line break, so it could never match one line. */
      code: z.literal("multilineQuery")
    })
    .readonly(),
  z
    .strictObject({
      /** The query is longer than the desktop's query limit. */
      code: z.literal("queryTooLong"),
      /** Inclusive query limit, counted in Unicode scalar values. */
      maxChars: searchFilesCountSchema
    })
    .readonly(),
  z
    .strictObject({
      /** The requested maximum number of results is 0 or above the limit. */
      code: z.literal("maxResultsOutOfRange"),
      /** Inclusive upper bound; the lower bound is 1. */
      maximum: searchFilesCountSchema
    })
    .readonly(),
  z
    .strictObject({
      /** The requested maximum number of snippets per file is 0 or above the limit. */
      code: z.literal("maxSnippetsPerFileOutOfRange"),
      /** Inclusive upper bound; the lower bound is 1. */
      maximum: searchFilesCountSchema
    })
    .readonly(),
  z
    .strictObject({
      /**
       * Inspecting the root failed for another reason, or the search task
       * stopped unexpectedly.
       */
      code: z.literal("searchFailed"),
      /** Display-only description of the failure. */
      message: z.string()
    })
    .readonly()
])

/** Failure that the desktop `find_files` command declares. */
export type SearchFilesError = z.infer<typeof searchFilesErrorSchema>
