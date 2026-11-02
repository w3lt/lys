import {
  checkEmailAccountApiResponseSchema,
  type CheckEmailAccountApiRequestBody,
  type CheckEmailAccountApiResponse
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { checkEmailAccount } from "@/lib/apis/http/email"
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
 * @returns What `checkEmailAccount` rejected with.
 * @throws When the check resolves instead.
 */
async function getAccountCheckFailure(response: Response): Promise<unknown> {
  startBackendFake({ [ACCOUNT_CHECK_ROUTE]: () => response })
  return await checkEmailAccount(CONNECTION, CHECK_BODY).then(
    () => {
      throw new Error("The check resolved")
    },
    (failure: unknown) => failure
  )
}

describe("checkEmailAccount", () => {
  it("posts the account and its password as JSON to the backend origin, uncached, and returns the frozen outcome", async () => {
    const backend = startBackendFake({
      [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
    })

    const outcome = await checkEmailAccount(CONNECTION, CHECK_BODY)

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

  it.each<CheckEmailAccountApiResponse>([
    {
      status: "checked",
      imap: { status: "failed", reason: "wrong-password" },
      smtp: { status: "accepted" }
    },
    {
      status: "checked",
      imap: { status: "failed", reason: "unreachable" },
      smtp: { status: "failed", reason: "timed-out" }
    },
    { status: "unavailable", reason: "server-missing" },
    { status: "unavailable", reason: "server-failed" }
  ])(
    "returns the $status outcome as the backend answered it",
    async (answer) => {
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, answer)
      })

      await expect(checkEmailAccount(CONNECTION, CHECK_BODY)).resolves.toEqual(
        answer
      )
    }
  )

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
      checkEmailAccount(CONNECTION, CHECK_BODY)
    ).rejects.toMatchObject({
      message: "The backend could not be reached.",
      cause: transportFailure
    })
  })
})
