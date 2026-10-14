import { toolNameSchema } from "@lys/share"
import * as z from "zod"

/**
 * Validates why a backend tool cannot run now.
 *
 * @remarks `api-key-missing`: no Tavily API key is saved. `api-key-invalid`:
 * the saved key fails the key format. `settings-unreadable`: the settings
 * file cannot be read, is too large, or is not a JSON object. Adding a reason
 * is a compatibility change for every consumer that branches on it.
 */
export const backendToolUnavailableReasonSchema = z.enum([
  "api-key-missing",
  "api-key-invalid",
  "settings-unreadable"
])

/** Why a backend tool cannot run now. */
export type BackendToolUnavailableReason = z.infer<
  typeof backendToolUnavailableReasonSchema
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
