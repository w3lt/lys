import {
  currentTimeSchema,
  getCurrentTimeErrorSchema,
  getLocationErrorSchema,
  listToolsResultSchema,
  readTextFileContentSchema,
  readTextFileErrorSchema,
  readTextFileInputSchema,
  searchFilesErrorSchema,
  searchFilesFilterSchema,
  searchFilesReportSchema,
  savedLocationSchema,
  type CurrentTime,
  type GetCurrentTimeError,
  type GetLocationError,
  type ListToolsResult,
  type ReadTextFileError,
  type ReadTextFileInput,
  type SearchFilesError,
  type SearchFilesFilter,
  type SavedLocation,
  type SearchFilesReport
} from "@lys/protocol"
import { invoke, type InvokeArgs } from "@tauri-apps/api/core"

/** Registered name of the Tauri command that implements the read-text-file tool. */
const READ_TEXT_FILE_COMMAND = "read_text_file"

/** Registered name of the Tauri command that implements the search-files tool. */
const FIND_FILES_COMMAND = "find_files"

/** Registered name of the Tauri command that implements the get-current-time tool. */
const GET_CURRENT_TIME_COMMAND = "get_current_time"

/** Registered name of the Tauri command that implements the get-location tool. */
const GET_LOCATION_COMMAND = "get_location"

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

/** Outcome of one get-current-time tool call. */
export type GetCurrentTimeResult =
  | {
      /** The desktop returned the local date, time, and time zone. */
      readonly status: "succeeded"
      /** Local date, time, and time zone of the machine. */
      readonly currentTime: CurrentTime
    }
  | {
      /** The desktop declared why it returned no time. */
      readonly status: "failed"
      /** Declared failure: the machine's time zone is unknown. */
      readonly error: GetCurrentTimeError
    }

/** Outcome of one get-location tool call. */
export type GetLocationResult =
  | {
      /** The desktop returned the location the person saved. */
      readonly status: "succeeded"
      /** Saved location, with at least one part; personal data. */
      readonly location: SavedLocation
    }
  | {
      /** The desktop declared why it returned no location. */
      readonly status: "failed"
      /** Declared failure, such as no saved location. */
      readonly error: GetLocationError
    }

/** Validated outcome of a tool command that takes no arguments. */
type ArgumentFreeToolOutcome<Value, Failure> =
  | {
      /** The command resolved with a value that passed its schema. */
      readonly status: "succeeded"
      /** Validated value the command returned. */
      readonly value: Value
    }
  | {
      /** The command rejected with a failure it declares. */
      readonly status: "failed"
      /** Validated declared failure. */
      readonly error: Failure
    }

/** Schema that validates a command's value, throwing when it does not match. */
type CommandValueSchema<Value> = {
  /** Returns the validated value or throws a Zod error. */
  readonly parse: (value: unknown) => Value
}

/** Schema that recognizes a command's declared failures. */
type CommandFailureSchema<Failure> = {
  /** Reports whether the rejection is a declared failure, with its value. */
  readonly safeParse: (
    value: unknown
  ) =>
    | { readonly success: true; readonly data: Failure }
    | { readonly success: false }
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
 * Reads the local date, time, and time zone of this machine through the
 * desktop's get-current-time tool.
 *
 * @returns A promise that resolves once the desktop answers: `succeeded`
 * with the current time, or `failed` with the failure the desktop declared.
 * @throws A Zod error when the desktop returns a malformed time.
 * @throws An `Error` whose `cause` is the rejection when the desktop rejects
 * without a declared failure, for example because the command is not
 * registered.
 * @remarks The desktop reads the system clock and the machine's time zone;
 * the read cannot be cancelled.
 */
export async function getCurrentTime(): Promise<GetCurrentTimeResult> {
  const outcome = await sendArgumentFreeToolCommand(
    GET_CURRENT_TIME_COMMAND,
    currentTimeSchema,
    getCurrentTimeErrorSchema
  )

  if (outcome.status === "failed") {
    return outcome
  }

  return Object.freeze({
    status: "succeeded",
    currentTime: outcome.value
  } satisfies GetCurrentTimeResult)
}

/**
 * Reads the location the person saved in Settings through the desktop's
 * get-location tool.
 *
 * @returns A promise that resolves once the desktop answers: `succeeded`
 * with the saved location, or `failed` with the failure the desktop declared,
 * such as `locationNotSet`.
 * @throws A Zod error when the desktop returns a malformed location.
 * @throws An `Error` whose `cause` is the rejection when the desktop rejects
 * without a declared failure, for example because the command is not
 * registered.
 * @remarks The desktop reads the saved settings file, never Location Services
 * or the network; the read cannot be cancelled.
 */
export async function getLocation(): Promise<GetLocationResult> {
  const outcome = await sendArgumentFreeToolCommand(
    GET_LOCATION_COMMAND,
    savedLocationSchema,
    getLocationErrorSchema
  )

  if (outcome.status === "failed") {
    return outcome
  }

  return Object.freeze({
    status: "succeeded",
    location: outcome.value
  } satisfies GetLocationResult)
}

/**
 * Lists every client tool Lys has, in the order Settings shows them.
 *
 * @returns A promise that resolves with the validated, frozen list once the
 * desktop answers.
 * @throws A caller-safe error when the desktop returns a list that does not
 * match {@link listToolsResultSchema}, such as a definition that drifted from
 * the shared shape; the decoding failure is kept as its cause.
 * @throws The Tauri rejection when the command is not registered.
 * @remarks The desktop builds the list from its own definitions and reads
 * nothing from disk, so the command declares no failure of its own. The read
 * cannot be cancelled.
 */
export async function listTools(): Promise<ListToolsResult> {
  const value = await invoke<unknown>(LIST_TOOLS_COMMAND)

  try {
    return listToolsResultSchema.parse(value)
  } catch (cause) {
    throw new Error("The app returned an invalid tool list.", { cause })
  }
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

    return Object.freeze({
      status: "resolved",
      value
    } satisfies TauriCommandSettlement)
  } catch (reason: unknown) {
    return Object.freeze({
      status: "rejected",
      reason
    } satisfies TauriCommandSettlement)
  }
}

/**
 * Sends one tool command that takes no arguments and validates how it
 * settled.
 *
 * @typeParam Value - Value the command resolves with.
 * @typeParam Failure - Failure the command declares.
 * @param command - Registered Tauri command name.
 * @param valueSchema - Schema of the value the command resolves with.
 * @param failureSchema - Schema of the failures the command declares.
 * @returns A promise that resolves with the frozen outcome once the host
 * settles the command.
 * @throws A Zod error when the resolved value does not match `valueSchema`.
 * @throws An `Error` whose `cause` is the rejection when the rejection is
 * not a declared failure.
 */
async function sendArgumentFreeToolCommand<Value, Failure>(
  command: string,
  valueSchema: CommandValueSchema<Value>,
  failureSchema: CommandFailureSchema<Failure>
): Promise<ArgumentFreeToolOutcome<Value, Failure>> {
  const settlement = await sendTauriCommand(command, {})

  if (settlement.status === "resolved") {
    const value = valueSchema.parse(settlement.value)

    return Object.freeze({
      status: "succeeded",
      value
    } satisfies ArgumentFreeToolOutcome<Value, Failure>)
  }

  const failure = failureSchema.safeParse(settlement.reason)

  if (!failure.success) {
    throw createUndeclaredRejectionError(command, settlement.reason)
  }

  return Object.freeze({
    status: "failed",
    error: failure.data
  } satisfies ArgumentFreeToolOutcome<Value, Failure>)
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
