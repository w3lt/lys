import { checkEmailAccountApiResponseSchema } from "@lys/protocol"
import { emailPasswordSchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { createStore } from "zustand/vanilla"
import { sendEmailAccountCheck } from "@/lib/apis/http/email"
import {
  createEmailSettingsSlice,
  type EmailSettingsSlice
} from "@/lib/store/email-settings"
import type { McpSettingsSaveOutcome } from "@/lib/store/mcp-settings"
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
  EMAIL_ON_SETTINGS,
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

/**
 * Builds a spy for the capability a removal switches the email server off
 * with.
 *
 * @param outcome - What saving the switch answers; `saved` by default.
 * @returns The spy.
 */
function buildSwitchOffSpy(outcome: McpSettingsSaveOutcome = "saved") {
  return vi.fn(() => Promise.resolve(outcome))
}

/**
 * Creates a store holding a saved account.
 *
 * @param settings - Settings the store starts with; the stored settings,
 * with the email server off, by default.
 * @returns A store owning one email slice, whose saves run through the
 * application's settings-group saves over the native host and whose checks
 * reach the fake backend through the real HTTP wrapper.
 */
function createEmailStore(settings: LysSettings = STORED_SETTINGS) {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<EmailStore>()((set, get) => ({
    settings,
    ...createEmailSettingsSlice(set, get, {
      saveEmailAccountSettings: settingsGroupSaves.saveEmailAccountSettings,
      sendEmailAccountCheck: (body) =>
        sendEmailAccountCheck({ backendUrl: FIXTURE_BACKEND_URL }, body)
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
    /**
     * Answer of a check that could not sign in because the email server is
     * missing.
     */
    const unavailableCheck = checkEmailAccountApiResponseSchema.parse({
      status: "unavailable",
      reason: "server-missing"
    })

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
      ["no sign-in could be tried", unavailableCheck]
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

    it("checks again on the next save after a check that could not be asked, saving once the new check accepts", async () => {
      const { host, writes } = startControlledSettingsHost()
      let checks = 0
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => {
          checks += 1
          return checks === 1
            ? Promise.reject(createTransportFailure())
            : buildJsonResponse(200, ACCEPTED_CHECK)
        }
      })
      const store = createEmailStore()
      await store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      const afterUnaskedCheck = store.getState().emailAccountCheck

      const save = store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      await waitForMicrotasks()
      await waitForMicrotasks()
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(afterUnaskedCheck).toEqual({
        status: "failed",
        error: "Lys couldn't reach its backend to check the account."
      })
      expect(checks).toBe(2)
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
      expect(store.getState().emailAccountCheck).toEqual({
        status: "checked",
        outcome: ACCEPTED_CHECK
      })
      expect(store.getState().settings.email).toEqual({ account: NEW_ACCOUNT })
    })

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

    it("forgets a failed write once a new check starts, so a refusal of the new check is the outcome", async () => {
      startNativeHostFake({
        load_settings: () => STORED_SETTINGS_DOCUMENT,
        save_settings: () => Promise.reject("Disk full")
      })
      let checks = 0
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => {
          checks += 1
          return buildJsonResponse(
            200,
            checks === 1 ? ACCEPTED_CHECK : REFUSED_CHECK
          )
        }
      })
      const store = createEmailStore()
      await store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      const afterFailedWrite = store.getState().emailAccountSave

      await expect(
        store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      ).resolves.toBe("refused")

      expect(afterFailedWrite).toEqual({
        status: "failed",
        error: "Lys couldn't write the email account to its settings file."
      })
      expect(store.getState().emailAccountSave).toEqual({ status: "idle" })
      expect(store.getState().emailAccountCheck).toEqual({
        status: "checked",
        outcome: REFUSED_CHECK
      })
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

      const removal = store.getState().deleteEmailAccount(buildSwitchOffSpy())
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

  describe("deleteEmailAccount", () => {
    it("removes the account and the password in one write and resets the check, leaving the switch of a server that is off alone", async () => {
      const { host, writes } = startControlledSettingsHost()
      startBackendFake({
        [ACCOUNT_CHECK_ROUTE]: () => buildJsonResponse(200, REFUSED_CHECK)
      })
      const store = createEmailStore()
      await store.getState().saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      const saveEmailServerSwitchOff = buildSwitchOffSpy()

      const removal = store
        .getState()
        .deleteEmailAccount(saveEmailServerSwitchOff)
      await waitForMicrotasks()
      const whileWriting = store.getState().emailAccountSave
      writes[0]?.resolve(null)

      await expect(removal).resolves.toBe("saved")
      expect(saveEmailServerSwitchOff).not.toHaveBeenCalled()
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

      const removal = store.getState().deleteEmailAccount(buildSwitchOffSpy())
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
      const saveEmailServerSwitchOff = buildSwitchOffSpy()
      const removal = await store
        .getState()
        .deleteEmailAccount(saveEmailServerSwitchOff)
      await waitForMicrotasks()
      writes[0]?.resolve(null)
      await save

      expect(removal).toBe("busy")
      expect(saveEmailServerSwitchOff).not.toHaveBeenCalled()
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
      expect(store.getState().settings.email).toEqual({ account: NEW_ACCOUNT })
    })

    it("switches the email server off first while it is on, saving until the account is removed too", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createEmailStore(EMAIL_ON_SETTINGS)
      const switchOff = createControlledPromise<McpSettingsSaveOutcome>()
      const saveEmailServerSwitchOff = vi.fn(() => switchOff.promise)

      const removal = store
        .getState()
        .deleteEmailAccount(saveEmailServerSwitchOff)
      await waitForMicrotasks()
      const whileSwitching = store.getState().emailAccountSave
      const writesWhileSwitching = listSettingsWrites(host.commands).length
      const secondRemoval = await store
        .getState()
        .deleteEmailAccount(buildSwitchOffSpy())
      const save = await store
        .getState()
        .saveEmailAccount(NEW_ACCOUNT, NEW_PASSWORD)
      switchOff.resolve("saved")
      await waitForMicrotasks()
      const whileWriting = store.getState().emailAccountSave
      writes[0]?.resolve(null)

      await expect(removal).resolves.toBe("saved")
      expect(saveEmailServerSwitchOff).toHaveBeenCalledTimes(1)
      expect(whileSwitching).toEqual({ status: "saving" })
      expect(writesWhileSwitching).toBe(0)
      expect(secondRemoval).toBe("busy")
      expect(save).toBe("busy")
      expect(whileWriting).toEqual({ status: "saving" })
      expect(store.getState().emailAccountSave).toEqual({ status: "saved" })
      expect(store.getState().settings.email).toEqual({ account: null })
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
    })

    it.each(["failed", "busy"] as const)(
      "keeps the account and says why when switching the email server off answers %s, writing nothing",
      async (outcome) => {
        /** Why a removal kept the account because the server stayed on. */
        const switchOffFailure =
          "Lys couldn't switch the email server off, so the account wasn't removed."

        const host = startNativeHostFake({
          load_settings: () => STORED_SETTINGS_DOCUMENT,
          save_settings: () => null
        })
        const store = createEmailStore(EMAIL_ON_SETTINGS)

        await expect(
          store.getState().deleteEmailAccount(buildSwitchOffSpy(outcome))
        ).resolves.toBe("failed")

        expect(store.getState().emailAccountSave).toEqual({
          status: "failed",
          error: switchOffFailure
        })
        expect(store.getState().settings.email).toEqual(STORED_SETTINGS.email)
        expect(store.getState().settings.secrets).toEqual(
          STORED_SETTINGS.secrets
        )
        expect(listSettingsWrites(host.commands)).toEqual([])
      }
    )
  })
})
