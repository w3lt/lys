import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import { isAbsolute, join } from "node:path"
import { readPrompt } from "./utils/prompts"
import * as z from "zod"

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

/** Validates a TCP port that names one fixed endpoint, from 1 to 65535 inclusive. */
const tcpPortSchema = z.int().min(1).max(65_535)

/** Validates non-empty prompt text that has no leading or trailing whitespace. */
const promptTextSchema = z
  .string()
  .min(1)
  .refine(
    (text) => text === text.trim(),
    "Prompt text must not have leading or trailing whitespace."
  )

/**
 * Validates the complete backend configuration snapshot published by
 * {@link loadBackendConfig}.
 *
 * @remarks Every key is required and unknown keys are rejected. The schema
 * applies no defaults, and the parsed snapshot is frozen.
 */
export const backendConfigSchema = z
  .strictObject({
    /**
     * IPv4 loopback address on which Fastify accepts connections.
     *
     * @remarks The backend does not authenticate non-browser callers, so it
     * must not listen on a non-loopback interface.
     */
    backendHost: z.ipv4().startsWith("127."),
    /** TCP port on which Fastify accepts connections. */
    backendPort: tcpPortSchema,
    /**
     * Host name or IPv4 address used by backend LM Studio clients.
     *
     * @remarks Embedded unbracketed in the `http://` and `ws://` endpoint URLs.
     */
    lmstudioHost: z.hostname(),
    /** TCP port used by backend LM Studio clients. */
    lmstudioPort: tcpPortSchema,
    /** Absolute filesystem path of the SQLite database owned by the conversation service. */
    databaseFilePath: z
      .string()
      .refine(isAbsolute, "Database file path must be absolute."),
    /**
     * System prompt sent before the user message in every chat completion and
     * stored with each new conversation.
     *
     * @remarks Read once from the maintained `lys.txt` prompt file, with
     * surrounding whitespace trimmed, when the configuration is loaded.
     */
    lysSystemPrompt: promptTextSchema,
    /**
     * System prompt sent with every title-generation request.
     *
     * @remarks Read once from the maintained `title-generation.txt` prompt file,
     * with surrounding whitespace trimmed, when the configuration is loaded.
     */
    titleGenerationPrompt: promptTextSchema,
    /**
     * Inclusive maximum number of title-generation attempts in one chat turn for
     * a conversation without a stored title.
     *
     * @remarks A positive safe integer. Each attempt is one title request, which
     * the OpenAI SDK can send up to three times when it retries a connection
     * failure, timeout, or 408, 409, 429, or 5xx response.
     */
    titleGenerationMaxAttempts: z.int().min(1),
    /**
     * Inclusive maximum length of a generated title, in Unicode code points,
     * before surrounding whitespace is trimmed.
     *
     * @remarks A positive safe integer. Title requests pass it to the endpoint as
     * the title's JSON-schema `maxLength`, and a reply whose title is longer is
     * unusable output.
     */
    generatedTitleMaxLength: z.int().min(1)
  })
  .readonly()

/** Runtime locations, prompts, and limits used by the backend and its LM Studio clients. */
export type BackendConfig = z.infer<typeof backendConfigSchema>

/**
 * Loads the backend configuration from the `LYS_HOME` environment variable,
 * shared protocol constants, backend limits, and the maintained prompt files.
 *
 * @returns A frozen configuration snapshot that satisfies the complete backend
 * configuration schema, whose database path is `lys_db.sqlite` in the
 * `LYS_HOME` directory, and whose prompts were read once during this call.
 * @throws If `LYS_HOME` is unset, empty, or not an absolute path, as
 * described by {@link parseLysHome}.
 * @throws If a prompt file cannot be read or its trimmed contents are empty.
 * @throws {z.ZodError} If a setting is outside its domain; each issue names the
 * failing key.
 * @remarks `LYS_HOME` has no backend default, and the backend does not create
 * that directory. The desktop host sets it to its resolved absolute Lys home
 * for the backend it starts.
 */
export function loadBackendConfig(): BackendConfig {
  const lysHome = parseLysHome(process.env.LYS_HOME)
  return backendConfigSchema.parse({
    backendHost: BACKEND_HOST,
    backendPort: BACKEND_PORT,
    lmstudioHost: LMSTUDIO_HOST,
    lmstudioPort: LMSTUDIO_PORT,
    databaseFilePath: join(lysHome, "lys_db.sqlite"),
    lysSystemPrompt: readPrompt("lys-system"),
    titleGenerationPrompt: readPrompt("title-generation"),
    titleGenerationMaxAttempts: TITLE_GENERATION_MAX_ATTEMPTS,
    generatedTitleMaxLength: GENERATED_TITLE_MAX_LENGTH
  } satisfies z.input<typeof backendConfigSchema>)
}

/**
 * Validates the raw `LYS_HOME` environment value as the Lys home directory.
 *
 * @param value - Raw `LYS_HOME` value, or `undefined` when the variable is
 * unset.
 * @returns The value unchanged once it is known to be an absolute path. The
 * directory is not required to exist.
 * @throws If the value is unset or empty, with the message
 * `LYS_HOME is not set`.
 * @throws If the value is a relative path, including an unexpanded `~/…`, with
 * a message that quotes the rejected value.
 */
function parseLysHome(value: string | undefined): string {
  if (!value) {
    throw new Error("LYS_HOME is not set")
  }

  if (!isAbsolute(value)) {
    throw new Error(
      `LYS_HOME must be an absolute path, got ${JSON.stringify(value)}`
    )
  }

  return value
}
