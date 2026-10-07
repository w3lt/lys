import * as z from "zod"

/**
 * Validates the argument object of the desktop `read_text_file` command.
 *
 * @remarks The schema checks only the argument's shape. Whether the path is
 * absolute, exists, and holds UTF-8 text within the desktop's read limit is
 * decided by the desktop, which reports those outcomes through
 * {@link readTextFileErrorSchema}. Unknown keys are rejected here, because the
 * desktop ignores extra argument keys instead of reporting them.
 */
export const readTextFileInputSchema = z
  .strictObject({
    /** Absolute path of the file to read; symbolic links are followed. */
    path: z.string()
  })
  .readonly()

/** Argument object of the desktop `read_text_file` command. */
export type ReadTextFileInput = z.infer<typeof readTextFileInputSchema>

/**
 * Validates the text that the desktop `read_text_file` command returns.
 *
 * @remarks The text is the complete file: the desktop rejects a file over its
 * read limit instead of truncating it.
 */
export const readTextFileContentSchema = z.string()

/**
 * Validates a failure that the desktop `read_text_file` command declares.
 *
 * @remarks This mirrors the desktop's serialized failure. `code` identifies
 * the failure and is the only field consumers should branch on; the other
 * fields belong to that code. `message` is display text from the operating
 * system or the async runtime and is not a stable contract. Adding a code is a
 * compatibility change for consumers that branch exhaustively.
 */
export const readTextFileErrorSchema = z.discriminatedUnion("code", [
  z
    .strictObject({
      /** The path is not absolute; relative paths are never resolved. */
      code: z.literal("pathNotAbsolute")
    })
    .readonly(),
  z
    .strictObject({
      /** Nothing exists at the path. */
      code: z.literal("fileNotFound")
    })
    .readonly(),
  z
    .strictObject({
      /** The operating system denied access to the file or a parent directory. */
      code: z.literal("permissionDenied")
    })
    .readonly(),
  z
    .strictObject({
      /** The path names a directory, FIFO, socket, or device, not a regular file. */
      code: z.literal("notAFile")
    })
    .readonly(),
  z
    .strictObject({
      /** The file exceeds the desktop's read limit, so none of it was returned. */
      code: z.literal("fileTooLarge"),
      /** Smallest size in bytes the file was observed to have. */
      sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      /** Inclusive read limit in bytes that the file exceeds. */
      maxSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .readonly(),
  z
    .strictObject({
      /** The file's bytes are not valid UTF-8, so it cannot be read as text. */
      code: z.literal("notUtf8Text")
    })
    .readonly(),
  z
    .strictObject({
      /**
       * Opening or reading the file failed for another reason, or the read
       * task stopped unexpectedly.
       */
      code: z.literal("readFailed"),
      /** Display-only description of the failure. */
      message: z.string()
    })
    .readonly()
])

/** Failure that the desktop `read_text_file` command declares. */
export type ReadTextFileError = z.infer<typeof readTextFileErrorSchema>
