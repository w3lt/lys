import { checkEmailAccountApiResponseSchema } from "@lys/protocol"
import { emailPasswordSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import { checkEmailAccount } from "@/lib/apis/http/email"
import {
  createEmailSettingsSlice,
  type EmailSettingsSlice
} from "@/lib/store/email-settings"
import type { LysSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
import {
  buildJsonResponse,
  createControlledRoute,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake
} from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  STORED_EMAIL_ACCOUNT,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type EmailStore = EmailSettingsSlice & { settings: LysSettings }

/** Route key of the account check. */
const ACCOUNT_CHECK_ROUTE = "POST /api/v1/mcp/email/account-check"

/** Account the person saves in place of the stored one. */
const NEW_ACCOUNT = Object.freeze({
  ...STORED_EMAIL_ACCOUNT,
  displayName: "Ada Renamed"
})

/** Password the person saves in place of the stored one. */
const NEW_PASSWORD = emailPasswordSchema.parse("fixture-app-password-1111")

/** Answer of a check both servers accepted. */
const ACCEPTED_CHECK = checkEmailAccountApiResponseSchema.parse({
  status: "checked",
  imap: { status: "accepted" },
  smtp: { status: "accepted" }
})

/** Answer of a check the SMTP server refused. */
const REFUSED_CHECK = checkEmailAccountApiResponseSchema.parse({
  status: "checked",
  imap: { status: "accepted" },
  smtp: { status: "failed", reason: "wrong-password" }
})

/** Answer of a check that could not sign in because the email server is missing. */
const UNAVAILABLE_CHECK = checkEmailAccountApiResponseSchema.parse({
  status: "unavailable",
  reason: "server-missing"
})

/**
 * Creates a store holding the stored settings, with a saved account.
 *
 * @returns A store owning one email slice, whose saves run through the
 * application's settings-group saves over the native host and whose checks
 * reach the fake backend through the real HTTP wrapper.
 */
function createEmailStore() {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<EmailStore>()((set, get) => ({
    settings: STORED_SETTINGS,
    ...createEmailSettingsSlice(set, get, {
      saveEmailAccountSettings: settingsGroupSaves.saveEmailAccountSettings,
      sendEmailAccountCheck: (body) =>
        checkEmailAccount({ backendUrl: FIXTURE_BACKEND_URL }, body)
    })
  }))
}

/**
 * Starts a native host that loads the stored settings document and whose
 * settings writes stay pending until the case settles them, one controlled
 * promise per write.
 *
 * @returns The host observation handle and the pending writes in order.
 */
function startControlledSettingsHost() {
  const writes: ControlledPromise<null>[] = []
  const host = startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => {
      const write = createControlledPromise<null>()
      writes.push(write)
      return write.promise
    }
  })
  return { host, writes }
}

/**
 * Lists the arguments of every settings write, in order.
 *
 * @param commands - Native commands the host observed.
 * @returns The arguments each `save_settings` call carried.
 */
function listSettingsWrites(
  commands: readonly { command: string; args: unknown }[]
): unknown[] {
  return commands
    .filter((invoked) => invoked.command === "save_settings")
    .map((invoked) => invoked.args)
}

describe("createEmailSettingsSlice", () => {
  it("starts with no save and no check", () => {
    const store = createEmailStore()

    expect(store.getState()).toMatchObject({
      emailAccountSave: { status: "idle" },
      emailAccountCheck: { status: "idle" }
    })
  })

  describe("saveEmailAccount", () => {
    it("reports checking, then saving until the write completes, then holds the account and the password, keeping the other groups on disk", async () => {
      const { host, writes } = startControlledSettingsHost()
      const accountCheck = createControlledRoute()
      const backend = startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: accountCheck.route
      })
      const store = createEmailStore()

      const save = store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      await waitForMicrotasks()
      const whileChecking = store.getState().emailAccountCheck
      expect(listSettingsWrites(host.commands)).toEqual([])
      accountCheck.responses[0]?.resolve(buildJsonResponse(200, ACCEPTED_CHECK))
      await waitForMicrotasks()
      const whileWriting = store.getState().emailAccountSave
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(whileChecking).toEqual({ status: "checking" })
      expect(whileWriting).toEqual({ status: "saving" })
      expect(store.getState().emailAccountCheck).toEqual({
        status: "checked",
        outcome: ACCEPTED_CHECK
      })
      expect(store.getState().emailAccountSave).toEqual({ status: "saved" })
      expect(store.getState().settings.email).toEqual({ account: NEW_ACCOUNT })
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        emailPassword: NEW_PASSWORD
      })
      expect(backend.requests[0]?.body).toEqual({
        account: NEW_ACCOUNT,
        password: NEW_PASSWORD
      })
      expect(listSettingsWrites(host.commands)).toEqual([
        {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: {
              ...STORED_SETTINGS_DOCUMENT.secrets,
              emailPassword: NEW_PASSWORD
            },
            email: { account: NEW_ACCOUNT }
          }
        }
      ])
    })

    it.each([
      ["a server refused the sign-in", REFUSED_CHECK],
      ["no sign-in could be tried", UNAVAILABLE_CHECK]
    ])(
      "answers refused and writes nothing when %s, keeping the outcome",
      async (_label, outcome) => {
        const { host } = startControlledSettingsHost()
        startBackendFake({
          [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, outcome)
        })
        const store = createEmailStore()

        await expect(
          store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
        ).resolves.toBe("refused")

        expect(store.getState().emailAccountCheck).toEqual({
          status: "checked",
          outcome
        })
        expect(store.getState().emailAccountSave).toEqual({ status: "idle" })
        expect(store.getState().settings.email).toEqual(STORED_SETTINGS.email)
        expect(store.getState().settings.secrets).toEqual(
          STORED_SETTINGS.secrets
        )
        expect(listSettingsWrites(host.commands)).toEqual([])
      }
    )

    it.each([
      [
        "the backend cannot be reached",
        () => Promise.reject(createTransportFailure())
      ],
      [
        "the backend answers with an error status",
        () => new Response(null, { status: 500 })
      ]
    ])(
      "answers failed and writes nothing when %s, reporting that the check could not be asked",
      async (_label, route) => {
        const { host } = startControlledSettingsHost()
        startBackendFake({ [ACCOUNT_CHECK_ROUTE]: route })
        const store = createEmailStore()

        await expect(
          store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
        ).resolves.toBe("failed")

        expect(store.getState().emailAccountCheck).toEqual({
          status: "failed",
          error: "Lys couldn't reach its backend to check the account."
        })
        expect(store.getState().emailAccountSave).toEqual({ status: "idle" })
        expect(listSettingsWrites(host.commands)).toEqual([])
      }
    )

    it("keeps the stored account in memory and reports a failed save without the host's detail", async () => {
      const { writes } = startControlledSettingsHost()
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
      })
      const store = createEmailStore()

      const save = store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      await waitForMicrotasks()
      await waitForMicrotasks()
      writes[0]?.reject("EACCES: /Users/someone/.lys/settings.json")

      await expect(save).resolves.toBe("failed")
      expect(store.getState().emailAccountSave).toEqual({
        status: "failed",
        error: "Lys couldn't write the email account to its settings file."
      })
      expect(store.getState().settings.email).toEqual(STORED_SETTINGS.email)
      expect(store.getState().settings.secrets).toEqual(STORED_SETTINGS.secrets)
    })

    it("answers busy without checking or writing while another save's check runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      const accountCheck = createControlledRoute()
      const backend = startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: accountCheck.route
      })
      const store = createEmailStore()

      const first = store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      await waitForMicrotasks()
      const second = await store
        .getState()
        .saveEmailAccount(STORED_EMAIL_ACCOUNT, NEW_PASSWORD)
      accountCheck.responses[0]?.resolve(buildJsonResponse(200, ACCEPTED_CHECK))
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await first

      expect(second).toBe("busy")
      expect(backend.requests).toHaveLength(1)
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
      expect(store.getState().settings.email).toEqual({ account: NEW_ACCOUNT })
    })

    it("answers busy while a removal runs", async () => {
      const { writes } = startControlledSettingsHost()
      const backend = startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
      })
      const store = createEmailStore()

      const removal = store.getState().removeEmailAccount()
      await waitForMicrotasks()
      const save = await store
        .getState()
        .saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      writes[0]?.resolve(null)
      await removal

      expect(save).toBe("busy")
      expect(backend.requests).toHaveLength(0)
      expect(store.getState().settings.email).toEqual({ account: null })
    })
  })

  describe("removeEmailAccount", () => {
    it("removes the account and the password in one write and resets the check", async () => {
      const { host, writes } = startControlledSettingsHost()
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, REFUSED_CHECK)
      })
      const store = createEmailStore()
      await store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)

      const removal = store.getState().removeEmailAccount()
      await waitForMicrotasks()
      const whileWriting = store.getState().emailAccountSave
      writes[0]?.resolve(null)

      await expect(removal).resolves.toBe("saved")
      expect(whileWriting).toEqual({ status: "saving" })
      expect(store.getState().emailAccountCheck).toEqual({ status: "idle" })
      expect(store.getState().emailAccountSave).toEqual({ status: "saved" })
      expect(store.getState().settings.email).toEqual({ account: null })
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        emailPassword: null
      })
      expect(listSettingsWrites(host.commands)).toEqual([
        {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: {
              ...STORED_SETTINGS_DOCUMENT.secrets,
              emailPassword: null
            },
            email: { account: null }
          }
        }
      ])
    })

    it("keeps the account in memory and reports a failed removal", async () => {
      const { writes } = startControlledSettingsHost()
      const store = createEmailStore()

      const removal = store.getState().removeEmailAccount()
      await waitForMicrotasks()
      writes[0]?.reject("EACCES: /Users/someone/.lys/settings.json")

      await expect(removal).resolves.toBe("failed")
      expect(store.getState().emailAccountSave).toEqual({
        status: "failed",
        error: "Lys couldn't write the email account to its settings file."
      })
      expect(store.getState().settings.email).toEqual(STORED_SETTINGS.email)
      expect(store.getState().settings.secrets).toEqual(STORED_SETTINGS.secrets)
    })

    it("answers busy without writing while a save runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
      })
      const store = createEmailStore()

      const save = store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      await waitForMicrotasks()
      const removal = await store.getState().removeEmailAccount()
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await save

      expect(removal).toBe("busy")
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
      expect(store.getState().settings.email).toEqual({ account: NEW_ACCOUNT })
    })
  })
})
