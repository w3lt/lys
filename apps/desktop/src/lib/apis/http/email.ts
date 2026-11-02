import {
  checkEmailAccountApi,
  type CheckEmailAccountApiRequestBody,
  type CheckEmailAccountApiResponse
} from "@lys/protocol"

/** Transport scope sampled once for one email account request. */
type EmailApiConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
}

/** HTTP status of an answered account check. */
const HTTP_OK_STATUS = 200

/**
 * Asks the backend to sign in to the IMAP and SMTP servers of an email
 * account with its password, without reading or sending mail.
 *
 * @param connection - Backend origin. The check cannot be cancelled; the
 * backend ends it within about a minute.
 * @param body - Account and password that passed the shared rules; the
 * password is a secret, sent only in this request's JSON body over the
 * loopback origin.
 * @returns The validated, frozen outcome once the backend answers: each
 * server's sign-in outcome, or why no sign-in was tried. It never holds the
 * account or the password.
 * @throws A caller-safe error when the backend cannot be reached, when it
 * answers with another status, naming only that status, or when its answer
 * has another media type or an outcome that does not match the shared
 * schema; the decoding failure is kept as its cause.
 */
export async function checkEmailAccount(
  connection: EmailApiConnection,
  body: CheckEmailAccountApiRequestBody
): Promise<CheckEmailAccountApiResponse> {
  const response = await sendEmailAccountCheckRequest(connection, body)
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  try {
    if (
      response.status !== HTTP_OK_STATUS ||
      mediaType !== "application/json"
    ) {
      await response.body?.cancel()
      throw new Error(
        `Unexpected account check response (HTTP ${response.status}).`
      )
    }
    const payload: unknown = await response.json()
    return checkEmailAccountApi.responses[HTTP_OK_STATUS].parse(payload)
  } catch (cause) {
    throw new Error("The backend returned an invalid account check.", {
      cause
    })
  }
}

/**
 * Sends one account check as a JSON POST and returns its response, in any
 * HTTP status.
 *
 * @param connection - Backend origin.
 * @param body - Account and password to send.
 * @returns The response whose body remains owned by the caller.
 * @throws A caller-safe error retaining the transport failure as its cause.
 */
async function sendEmailAccountCheckRequest(
  connection: EmailApiConnection,
  body: CheckEmailAccountApiRequestBody
): Promise<Response> {
  try {
    return await fetch(`${connection.backendUrl}${checkEmailAccountApi.path}`, {
      method: checkEmailAccountApi.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      cache: "no-store"
    })
  } catch (cause) {
    throw new Error("The backend could not be reached.", { cause })
  }
}
