import {
  listToolsResultSchema,
  readTextFileContentSchema,
  readTextFileErrorSchema,
  readTextFileInputSchema,
  searchFilesErrorSchema,
  searchFilesFilterSchema,
  searchFilesReportSchema,
  type ListToolsResult,
  type ReadTextFileError,
  type ReadTextFileInput,
  type SearchFilesError,
  type SearchFilesFilter,
  type SearchFilesReport
} from "@lys/protocol"
import { invoke, type InvokeArgs } from "@tauri-apps/api/core"

/** Registered name of the Tauri command that implements the read-text-file tool. */
const READ_TEXT_FILE_COMMAND = "read_text_file"

/** Registered name of the Tauri command that implements the search-files tool. */
const FIND_FILES_COMMAND = "find_files"

/** Registered name of the Tauri command that lists every client tool. */
const LIST_TOOLS_COMMAND = "list_tools"

/** Outcome of one read-text-file tool call. */
export type ReadTextFileResult =
  | {
      /** The desktop returned the file's text. */
      readonly status: "succeeded"
      /** Complete UTF-8 text of the file. */
      readonly content: string
    }
  | {
      /** The desktop declared why it returned no text. */
      readonly status: "failed"
      /** Declared failure, such as a missing file or one over the read limit. */
      readonly error: ReadTextFileError
    }

/** Outcome of one search-files tool call. */
export type SearchFilesResult =
  | {
      /** The desktop finished the search and returned its report. */
      readonly status: "succeeded"
      /** Matches and the reason the search ended. */
      readonly report: SearchFilesReport
    }
  | {
      /** The desktop declared why it returned no report. */
      readonly status: "failed"
      /** Declared failure, such as an invalid query or a missing root. */
      readonly error: SearchFilesError
    }

/** How one Tauri command settled, before its value is validated. */
type TauriCommandSettlement =
  | {
      /** The command resolved. */
      readonly status: "resolved"
      /** Untrusted value the command returned. */
      readonly value: unknown
    }
  | {
      /** The command rejected. */
      readonly status: "rejected"
      /** Untrusted rejection reason, declared by the command or by Tauri itself. */
      readonly reason: unknown
    }

/**
 * Reads one UTF-8 text file through the desktop's read-text-file tool.
 *
 * @param input - Absolute path of the file to read; symbolic links are
 * followed.
 * @returns A promise that resolves once the desktop finishes the read:
 * `succeeded` with the complete text, or `failed` with the failure the desktop
 * declared.
 * @throws A Zod error, before the command is sent, when `input` does not match
 * {@link readTextFileInputSchema}, or when the desktop returns something other
 * than text.
 * @throws An `Error` whose `cause` is the rejection when the desktop rejects
 * without a declared failure, for example because the command is not
 * registered or cannot decode a path that is not well-formed UTF-16.
 * @remarks The desktop reads any absolute path its process can read; deciding
 * whether Lys may read the path belongs to the caller. The read cannot be
 * cancelled.
 */
export async function readTextFile(
  input: ReadTextFileInput
): Promise<ReadTextFileResult> {
  const commandArgs = readTextFileInputSchema.parse(input)
  const settlement = await sendTauriCommand(READ_TEXT_FILE_COMMAND, commandArgs)

  if (settlement.status === "resolved") {
    const content = readTextFileContentSchema.parse(settlement.value)

    return Object.freeze({
      status: "succeeded",
      content
    } satisfies ReadTextFileResult)
  }

  const failure = readTextFileErrorSchema.safeParse(settlement.reason)

  if (!failure.success) {
    throw createUndeclaredRejectionError(
      READ_TEXT_FILE_COMMAND,
      settlement.reason
    )
  }

  return Object.freeze({
    status: "failed",
    error: failure.data
  } satisfies ReadTextFileResult)
}

/**
 * Finds files under a directory by name or content through the desktop's
 * search-files tool.
 *
 * @param filter - Absolute root, query, target, and optional limits of the
 * search.
 * @returns A promise that resolves once the desktop finishes the search:
 * `succeeded` with the report, whose `completion` tells whether more matches
 * may exist, or `failed` with the failure the desktop declared.
 * @throws A Zod error, before the command is sent, when `filter` does not match
 * {@link searchFilesFilterSchema}, or when the desktop returns a malformed
 * report.
 * @throws An `Error` whose `cause` is the rejection when the desktop rejects
 * without a declared failure, for example because the command is not
 * registered or cannot decode a root or query that is not well-formed UTF-16.
 * @remarks The desktop searches any absolute root its process can list;
 * deciding whether Lys may search the directory belongs to the caller. The
 * search cannot be cancelled; the desktop's result and scan budgets bound it.
 */
export async function findFiles(
  filter: SearchFilesFilter
): Promise<SearchFilesResult> {
  const validatedFilter = searchFilesFilterSchema.parse(filter)
  const settlement = await sendTauriCommand(FIND_FILES_COMMAND, {
    filter: validatedFilter
  })

  if (settlement.status === "resolved") {
    const report = searchFilesReportSchema.parse(settlement.value)

    return Object.freeze({
      status: "succeeded",
      report
    } satisfies SearchFilesResult)
  }

  const failure = searchFilesErrorSchema.safeParse(settlement.reason)

  if (!failure.success) {
    throw createUndeclaredRejectionError(FIND_FILES_COMMAND, settlement.reason)
  }

  return Object.freeze({
    status: "failed",
    error: failure.data
  } satisfies SearchFilesResult)
}

/**
 * Lists every client tool Lys has, in the order Settings shows them.
 *
 * @returns A promise that resolves with the validated, frozen list once the
 * desktop answers.
 * @throws A Zod error when the desktop returns a list that does not match
 * {@link listToolsResultSchema}, such as a definition that drifted from the
 * shared shape.
 * @throws The Tauri rejection when the command is not registered.
 * @remarks The desktop builds the list from its own definitions and reads
 * nothing from disk, so the command declares no failure of its own. The read
 * cannot be cancelled.
 */
export async function listTools(): Promise<ListToolsResult> {
  const value = await invoke<unknown>(LIST_TOOLS_COMMAND)

  return listToolsResultSchema.parse(value)
}

/**
 * Sends one command to the Tauri host and captures how it settled.
 *
 * @param command - Registered Tauri command name.
 * @param commandArgs - Argument object whose keys name the command's
 * parameters.
 * @returns A promise that resolves once the host settles the command, with
 * the untrusted value or rejection reason left for the caller to validate.
 */
async function sendTauriCommand(
  command: string,
  commandArgs: InvokeArgs
): Promise<TauriCommandSettlement> {
  try {
    const value = await invoke<unknown>(command, commandArgs)

    return Object.freeze({ status: "resolved", value })
  } catch (reason: unknown) {
    return Object.freeze({ status: "rejected", reason })
  }
}

/**
 * Creates the error thrown when a tool command rejects without a declared
 * failure.
 *
 * @param command - Registered name of the command that rejected.
 * @param reason - Untrusted rejection, kept as the error's `cause`.
 * @returns A new error that names the command and keeps the rejection.
 */
function createUndeclaredRejectionError(
  command: string,
  reason: unknown
): Error {
  return new Error(
    `The ${command} command failed without a declared tool failure.`,
    { cause: reason }
  )
}
