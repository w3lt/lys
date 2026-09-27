import {
  BACKEND_HOST,
  BACKEND_PORT,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT
} from "@lys/protocol"
import { homedir } from "node:os"
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
 * Loads the backend configuration from shared protocol constants, backend
 * limits, and the maintained prompt files.
 *
 * @returns A frozen configuration snapshot that satisfies the complete backend
 * configuration schema and whose prompts were read once during this call.
 * @throws If a prompt file cannot be read or its trimmed contents are empty.
 * @throws {z.ZodError} If a setting is outside its domain; each issue names the
 * failing key.
 */
export function loadBackendConfig(): BackendConfig {
  return backendConfigSchema.parse({
    backendHost: BACKEND_HOST,
    backendPort: BACKEND_PORT,
    lmstudioHost: LMSTUDIO_HOST,
    lmstudioPort: LMSTUDIO_PORT,
    databaseFilePath: join(homedir(), ".lys", "lys_db.sqlite"),
    lysSystemPrompt: readPrompt("lys-system"),
    titleGenerationPrompt: readPrompt("title-generation"),
    titleGenerationMaxAttempts: TITLE_GENERATION_MAX_ATTEMPTS,
    generatedTitleMaxLength: GENERATED_TITLE_MAX_LENGTH
  } satisfies z.input<typeof backendConfigSchema>)
}
