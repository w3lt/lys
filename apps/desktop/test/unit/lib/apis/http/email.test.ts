import {
  checkEmailAccountApiResponseSchema,
  type CheckEmailAccountApiRequestBody,
  type CheckEmailAccountApiResponse
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { sendEmailAccountCheck } from "@/lib/apis/http/email"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake
} from "../../../support/backendFake"
import {
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD
} from "../../../support/settingsFixtures"

/** Connection the cases pass. */
const CONNECTION = Object.freeze({ backendUrl: FIXTURE_BACKEND_URL })

/** Route key of the account check. */
const ACCOUNT_CHECK_ROUTE = "POST /api/v1/mcp/email/account-check"

/** Account and password the cases send. */
const CHECK_BODY: CheckEmailAccountApiRequestBody = Object.freeze({
  account: STORED_EMAIL_ACCOUNT,
  password: STORED_EMAIL_PASSWORD
})

/** Answer of a check both servers accepted. */
const ACCEPTED_CHECK = checkEmailAccountApiResponseSchema.parse({
  status: "checked",
  imap: { status: "accepted" },
  smtp: { status: "accepted" }
})

/**
 * Sends an account check against one answer and returns the rejection.
 *
 * @param response - Answer of the account-check route.
 * @returns What `sendEmailAccountCheck` rejected with.
 * @throws When the check resolves instead.
 */
async function getAccountCheckFailure(response: Response): Promise<unknown> {
  startBackendFake({ [ACCOUNT_CHECK_ROUTE]: () => response })
  return await sendEmailAccountCheck(CONNECTION, CHECK_BODY).then(
    () => {
      throw new Error("The check resolved")
    },
    (failure: unknown) => failure
  )
}

describe("sendEmailAccountCheck", () => {
  it("posts the account and its password as JSON to the backend origin, uncached, and returns the frozen outcome", async () => {
    const backend = startBackendFake({
      [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
    })

    const outcome = await sendEmailAccountCheck(CONNECTION, CHECK_BODY)

    expect(outcome).toEqual(ACCEPTED_CHECK)
    expect(Object.isFrozen(outcome)).toBe(true)
    const [request] = backend.requests
    expect(request?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/mcp/email/account-check`
    )
    expect(request?.body).toEqual({
      account: STORED_EMAIL_ACCOUNT,
      password: STORED_EMAIL_PASSWORD
    })
    expect(request?.headers.get("content-type")).toBe("application/json")
    expect(request?.headers.get("accept")).toBe("application/json")
    expect(request?.cache).toBe("no-store")
  })

  it.each<[string, CheckEmailAccountApiResponse]>([
    [
      "a checked outcome whose IMAP password was refused",
      {
        status: "checked",
        imap: { status: "failed", reason: "wrong-password" },
        smtp: { status: "accepted" }
      }
    ],
    [
      "a checked outcome whose IMAP server was unreachable and SMTP server timed out",
      {
        status: "checked",
        imap: { status: "failed", reason: "unreachable" },
        smtp: { status: "failed", reason: "timed-out" }
      }
    ],
    [
      "an unavailable outcome whose email server is missing",
      { status: "unavailable", reason: "server-missing" }
    ],
    [
      "an unavailable outcome whose email server failed",
      { status: "unavailable", reason: "server-failed" }
    ]
  ])("returns %s as the backend answered it", async (_label, answer) => {
    startBackendFake({
      [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, answer)
    })

    await expect(
      sendEmailAccountCheck(CONNECTION, CHECK_BODY)
    ).resolves.toEqual(answer)
  })

  it.each([
    [
      "a failure status, even with an outcome body",
      buildJsonResponse(400, ACCEPTED_CHECK)
    ],
    [
      "an outcome body not declared as JSON",
      new Response(JSON.stringify(ACCEPTED_CHECK), {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    ]
  ])("rejects %s with a caller-safe error", async (_label, response) => {
    const failure = await getAccountCheckFailure(response)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The backend returned an invalid account check."
    })
  })

  it("names only the status of an answer that is not an outcome, never the password", async () => {
    const failure = await getAccountCheckFailure(
      new Response(STORED_EMAIL_PASSWORD, { status: 503 })
    )

    expect(failure).toMatchObject({
      message: "The backend returned an invalid account check.",
      cause: expect.objectContaining({
        message: "Unexpected account check response (HTTP 503)."
      })
    })
  })

  it.each([
    [
      "a reason Lys does not know",
      {
        status: "checked",
        imap: { status: "failed", reason: "mailbox-full" },
        smtp: { status: "accepted" }
      }
    ],
    ["a server missing", { status: "checked", imap: { status: "accepted" } }],
    [
      "the password echoed back",
      { ...ACCEPTED_CHECK, password: STORED_EMAIL_PASSWORD }
    ]
  ])(
    "rejects an outcome with %s, keeping the decoding failure as its cause",
    async (_label, body) => {
      const failure = await getAccountCheckFailure(buildJsonResponse(200, body))

      expect(failure).toMatchObject({
        message: "The backend returned an invalid account check.",
        cause: expect.objectContaining({ name: "ZodError" })
      })
    }
  )

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({
      [ACCOUNT_CHECK_ROUTE]: () => Promise.reject(transportFailure)
    })

    await expect(
      sendEmailAccountCheck(CONNECTION, CHECK_BODY)
    ).rejects.toMatchObject({
      message: "The backend could not be reached.",
      cause: transportFailure
    })
  })
})
