import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import type { PathLike } from "node:fs"
import { isAbsolute, join } from "node:path"
import { readPrompt } from "./utils/prompts"

/** Runtime locations, prompts, and limits used by the backend and its LM Studio clients. */
export type BackendConfig = {
  /** Interface on which Fastify accepts connections. */
  readonly backendHost: string
  /** TCP port on which Fastify accepts connections. */
  readonly backendPort: number
  /** Host used by backend LM Studio clients. */
  readonly lmstudioHost: string
  /** Port used by backend LM Studio clients. */
  readonly lmstudioPort: number
  /**
   * Filesystem path of the SQLite database owned by the conversation service.
   *
   * @remarks `lys_db.sqlite` in the `LYS_HOME` directory. The backend does not
   * create that directory.
   */
  readonly databaseFilePath: PathLike
  /**
   * System prompt sent before the user message in every chat completion and
   * stored with each new conversation.
   *
   * @remarks Read once from the maintained `lys.txt` prompt file, with
   * surrounding whitespace trimmed, when the configuration is loaded.
   */
  readonly lysSystemPrompt: string
  /**
   * System prompt sent with every title-generation request.
   *
   * @remarks Read once from the maintained `title-generation.txt` prompt file,
   * with surrounding whitespace trimmed, when the configuration is loaded.
   */
  readonly titleGenerationPrompt: string
  /**
   * Inclusive maximum number of title-generation attempts in one chat turn for
   * a conversation without a stored title.
   *
   * @remarks A positive safe integer. Each attempt is one title request, which
   * the OpenAI SDK can send up to three times when it retries a connection
   * failure, timeout, or 408, 409, 429, or 5xx response.
   */
  readonly titleGenerationMaxAttempts: number
  /**
   * Inclusive maximum length of a generated title, in Unicode code points,
   * before surrounding whitespace is trimmed.
   *
   * @remarks A positive safe integer. Title requests pass it to the endpoint as
   * the title's JSON-schema `maxLength`, and a reply whose title is longer is
   * unusable output.
   */
  readonly generatedTitleMaxLength: number
}

/**
 * Title-generation attempts allowed in one chat turn, applied as
 * `titleGenerationMaxAttempts` by {@link loadBackendConfig}. No other source
 * overrides it.
 */
const TITLE_GENERATION_MAX_ATTEMPTS = 3

/**
 * Generated-title length limit in Unicode code points, applied as
 * `generatedTitleMaxLength` by {@link loadBackendConfig}. No other source
 * overrides it.
 */
const GENERATED_TITLE_MAX_LENGTH = 100

/**
 * Loads the backend configuration from the `LYS_HOME` environment variable,
 * shared protocol constants, backend limits, and the maintained prompt files.
 *
 * @returns A frozen configuration snapshot whose database path is under
 * `LYS_HOME`, whose non-empty prompts were read once during this call, and
 * whose limits are positive safe integers.
 * @throws If `LYS_HOME` is unset or empty.
 * @throws If a prompt file cannot be read or its trimmed contents are empty.
 * @throws {RangeError} If a title-generation limit is not a positive safe
 * integer.
 * @remarks `LYS_HOME` has no backend default and is used as given. The desktop
 * host sets it to its resolved absolute Lys home for the backend it starts.
 */
export function loadBackendConfig(): BackendConfig {
  const lys_home = process.env.LYS_HOME
  if (!lys_home || !isAbsolute(lys_home)) {
    throw new Error("LYS_HOME is not set")
  }

  const lysSystemPrompt = readPrompt("lys-system")
  const titleGenerationPrompt = readPrompt("title-generation")
  const titleGenerationMaxAttempts = parsePositiveSafeInteger(
    TITLE_GENERATION_MAX_ATTEMPTS,
    "titleGenerationMaxAttempts"
  )
  const generatedTitleMaxLength = parsePositiveSafeInteger(
    GENERATED_TITLE_MAX_LENGTH,
    "generatedTitleMaxLength"
  )

  return Object.freeze({
    backendHost: BACKEND_HOST,
    backendPort: BACKEND_PORT,
    lmstudioHost: LMSTUDIO_HOST,
    lmstudioPort: LMSTUDIO_PORT,
    databaseFilePath: join(lys_home, "lys_db.sqlite"),
    lysSystemPrompt,
    titleGenerationPrompt,
    titleGenerationMaxAttempts,
    generatedTitleMaxLength
  } satisfies BackendConfig)
}

/**
 * Validates one numeric backend setting as a positive safe integer.
 *
 * @param value - Candidate setting value.
 * @param settingName - Configuration key named in the failure message.
 * @returns The same value once it is known to be a positive safe integer.
 * @throws {RangeError} If the value is not a positive safe integer.
 */
function parsePositiveSafeInteger(
  value: number,
  settingName: keyof BackendConfig
): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${settingName} must be a positive safe integer, received ${value}`
    )
  }

  return value
}
