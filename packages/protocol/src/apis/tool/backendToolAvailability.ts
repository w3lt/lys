import { toolNameSchema } from "@lys/share"
import * as z from "zod"

/**
 * Validates why a backend tool cannot run now.
 *
 * @remarks `api-key-missing`: no Tavily API key is saved. `api-key-invalid`:
 * the saved key fails the key format. `settings-unreadable`: the settings
 * file cannot be read, is too large, or is not a JSON object.
 * `page-reader-not-ready`: vmo, Lys's page reader, did not answer its health
 * route with `200 OK` in time, for example because it is stopped, still
 * starting, stopping, or not responding. Adding a reason is a compatibility
 * change for every consumer that branches on it.
 */
export const backendToolUnavailableReasonSchema = z.enum([
  "api-key-missing",
  "api-key-invalid",
  "settings-unreadable",
  "page-reader-not-ready"
])

/** Why a backend tool cannot run now. */
export type BackendToolUnavailableReason = z.infer<
  typeof backendToolUnavailableReasonSchema
>

/**
 * Validates why the saved Tavily API key cannot be used: the
 * {@link backendToolUnavailableReasonSchema} reasons about the key and the
 * settings file that holds it.
 *
 * @remarks The key check answers with one of these, never with a reason
 * about another tool's dependency, so adding a backend tool reason leaves
 * the key check's wire values unchanged.
 */
export const webSearchKeyUnavailableReasonSchema =
  backendToolUnavailableReasonSchema.extract([
    "api-key-missing",
    "api-key-invalid",
    "settings-unreadable"
  ])

/** Why the saved Tavily API key cannot be used. */
export type WebSearchKeyUnavailableReason = z.infer<
  typeof webSearchKeyUnavailableReasonSchema
>

/**
 * Validates one backend tool that cannot run now: its name and why. The
 * output is frozen; unknown fields are rejected.
 */
export const unavailableBackendToolSchema = z
  .strictObject({
    /** Name of a listed backend tool. */
    name: toolNameSchema,
    /** Why it cannot run now. */
    reason: backendToolUnavailableReasonSchema
  })
  .readonly()

/** One backend tool that cannot run now. */
export type UnavailableBackendTool = z.infer<
  typeof unavailableBackendToolSchema
>
