import { emailAccountSchema, emailPasswordSchema } from "@lys/share"
import * as z from "zod"
import { apiMcpEmailAccountCheckRoute } from "./routes"

/**
 * Validates why signing in to one mail server failed: the server refused
 * the user name or password; it could not be reached, such as a refused
 * connection or an unknown host; its certificate was refused by the
 * operating system; it does not offer STARTTLS, which the account requires;
 * it did not answer in time; or it answered something Lys could not read.
 *
 * @remarks Adding a reason is a compatibility change for every consumer
 * that branches on it.
 */
export const emailServerCheckFailureSchema = z.enum([
  "wrong-password",
  "unreachable",
  "certificate-refused",
  "encryption-not-offered",
  "timed-out",
  "protocol-error"
])

/** Why signing in to one mail server failed. */
export type EmailServerCheckFailure = z.infer<
  typeof emailServerCheckFailureSchema
>

/**
 * Validates the outcome of signing in to one mail server. The output is
 * frozen.
 *
 * @remarks `accepted`: the server accepted the sign-in; nothing was sent
 * or read. `failed`: it did not, and why.
 */
export const emailServerCheckSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("accepted") }),
    z.strictObject({
      status: z.literal("failed"),
      /** Why the sign-in failed. */
      reason: emailServerCheckFailureSchema
    })
  ])
  .readonly()

/** Outcome of signing in to one mail server. */
export type EmailServerCheck = z.infer<typeof emailServerCheckSchema>

/**
 * Validates why no sign-in was tried: the email server Lys ships is not
 * installed where the backend expects it; it failed before it reported; or
 * another check was running, so this one was refused without running.
 *
 * @remarks Adding a reason is a compatibility change for every consumer
 * that branches on it.
 */
const emailAccountCheckUnavailableReasonSchema = z.enum([
  "server-missing",
  "server-failed",
  "busy"
])

/** Why no sign-in was tried. */
export type EmailAccountCheckUnavailableReason = z.infer<
  typeof emailAccountCheckUnavailableReasonSchema
>

/**
 * Validates the outcome of checking an email account. The output is frozen.
 *
 * @remarks `checked`: Lys signed in to the IMAP server and to the SMTP
 * server, each with its own outcome. `unavailable`: Lys could not run the
 * check, and why. The answer never contains the account or the password.
 */
export const checkEmailAccountApiResponseSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("checked"),
      /** Outcome of signing in to the IMAP server. */
      imap: emailServerCheckSchema,
      /** Outcome of signing in to the SMTP server. */
      smtp: emailServerCheckSchema
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      /** Why no sign-in was tried. */
      reason: emailAccountCheckUnavailableReasonSchema
    })
  ])
  .readonly()

/**
 * Validates the body of an account-check request: the account as the
 * person typed it and its password, sent as `application/json`. The output
 * is frozen; unknown fields are rejected.
 *
 * @remarks The body holds the password, so a request without the desktop's
 * origin must not reach the handler: a request with a JSON body needs a
 * CORS preflight, which the backend refuses for every origin but the
 * desktop's, and a body sent without a preflight, such as a form or plain
 * text, fails this schema before anything is tried. A body that fails the
 * account or password rules is answered with HTTP 400 naming the rule,
 * never the value.
 */
const checkEmailAccountApiRequestBodySchema = z
  .strictObject({
    /** Account to sign in with, under the shared account rules. */
    account: emailAccountSchema,
    /** Password to sign in with; a secret. */
    password: emailPasswordSchema
  })
  .readonly()

/** Body of an account-check request. */
export type CheckEmailAccountApiRequestBody = z.infer<
  typeof checkEmailAccountApiRequestBodySchema
>

/** Selects the account-check response validator by HTTP status. */
const checkEmailAccountApiResponseSchemas = Object.freeze({
  200: checkEmailAccountApiResponseSchema
})

/**
 * Describes the POST endpoint that signs in to the IMAP and SMTP servers of
 * an email account with its password, without sending or reading mail.
 *
 * @remarks The backend runs the check through the email server Lys ships,
 * so the sign-in follows the same TLS rules the server applies; it saves
 * nothing. A check ends within about a minute and is not cancelled when
 * the client leaves. One check runs at a time, without a queue: a check
 * sent while another runs is answered `unavailable` with `busy` at once,
 * without running, and can be sent again once the other ended. Changing
 * the method, path, or schemas changes the transmitted compatibility
 * contract and requires coordinated consumers.
 */
export const checkEmailAccountApi = Object.freeze({
  method: "POST",
  path: apiMcpEmailAccountCheckRoute,
  body: checkEmailAccountApiRequestBodySchema,
  responses: checkEmailAccountApiResponseSchemas
})

/** Outcome of checking an email account. */
export type CheckEmailAccountApiResponse = z.infer<
  typeof checkEmailAccountApiResponseSchema
>

/** Status-specific payloads returned by the account-check endpoint. */
export type CheckEmailAccountApiReply = {
  /** Outcome of the check. */
  readonly 200: CheckEmailAccountApiResponse
}

/** Fastify route type for the account-check endpoint. */
export type CheckEmailAccountApiRoute = {
  /** Validated account and password. */
  readonly Body: CheckEmailAccountApiRequestBody
  /** Status-specific check payload. */
  readonly Reply: CheckEmailAccountApiReply
}
