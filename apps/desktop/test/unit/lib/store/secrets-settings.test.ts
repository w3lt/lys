import type { CheckWebSearchKeyApiResponse } from "@lys/protocol"
import { tavilyApiKeySchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import { sendWebSearchKeyCheck } from "@/lib/apis/http/tools"
import {
  createSecretsSettingsSlice,
  type SecretsSettingsSlice
} from "@/lib/store/secrets-settings"
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
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type SecretsStore = SecretsSettingsSlice & { settings: LysSettings }

/** Route key of the key check. */
const KEY_CHECK_ROUTE = "POST /api/v1/tools/web_search/key-check"

/** Key the person saves in place of the stored one. */
const NEW_TAVILY_API_KEY = tavilyApiKeySchema.parse(
  "tvly-dev-fixture-1111111111111111"
)

/** Answer of a check Tavily accepted, with the plan's credits. */
const ACCEPTED_CHECK: CheckWebSearchKeyApiResponse = Object.freeze({
  status: "accepted",
  credits: Object.freeze({ used: 12, limit: 1_000 })
})

/**
 * Creates a store holding the stored settings, with a saved key.
 *
 * @returns A store owning one secrets slice, whose saves run through the
 * application's settings-group saves over the native host and whose checks
 * reach the fake backend through the real HTTP wrapper.
 */
function createSecretsStore() {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<SecretsStore>()((set, get) => ({
    settings: STORED_SETTINGS,
    ...createSecretsSettingsSlice(set, get, {
      saveSecretsSettings: settingsGroupSaves.saveSecretsSettings,
      sendWebSearchKeyCheck: () =>
        sendWebSearchKeyCheck({ backendUrl: FIXTURE_BACKEND_URL })
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

describe("createSecretsSettingsSlice", () => {
  it("starts with no save and no check", () => {
    const store = createSecretsStore()

    expect(store.getState()).toMatchObject({
      secretsSave: { status: "idle" },
      tavilyKeyCheck: { status: "idle" }
    })
  })

  describe("saveTavilyApiKey", () => {
    it("reports saving until the write completes, then holds the new key, keeping the other groups on disk", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createSecretsStore()

      const save = store.getState().saveTavilyApiKey(NEW_TAVILY_API_KEY)
      await waitForMicrotasks()
      const whileWriting = store.getState().secretsSave
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(whileWriting).toEqual({ status: "saving" })
      expect(store.getState().secretsSave).toEqual({ status: "saved" })
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        tavilyApiKey: NEW_TAVILY_API_KEY
      })
      expect(listSettingsWrites(host.commands)).toEqual([
        {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: {
              ...STORED_SETTINGS_DOCUMENT.secrets,
              tavilyApiKey: NEW_TAVILY_API_KEY
            }
          }
        }
      ])
    })

    it("removes the saved key with null", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createSecretsStore()

      const removal = store.getState().saveTavilyApiKey(null)
      await waitForMicrotasks()
      writes[0]?.resolve(null)

      await expect(removal).resolves.toBe("saved")
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        tavilyApiKey: null
      })
      expect(listSettingsWrites(host.commands)).toEqual([
        {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: { ...STORED_SETTINGS_DOCUMENT.secrets, tavilyApiKey: null }
          }
        }
      ])
    })

    it("keeps the key in memory and reports a failed save without the host's detail", async () => {
      const { writes } = startControlledSettingsHost()
      const store = createSecretsStore()

      const save = store.getState().saveTavilyApiKey(NEW_TAVILY_API_KEY)
      await waitForMicrotasks()
      writes[0]?.reject("EACCES: /Users/someone/.lys/settings.json")

      await expect(save).resolves.toBe("failed")
      expect(store.getState().secretsSave).toEqual({
        status: "failed",
        error: "Lys couldn't write the key to its settings file."
      })
      expect(store.getState().settings.secrets).toEqual(STORED_SETTINGS.secrets)
    })

    it("answers busy without writing while another save runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createSecretsStore()

      const first = store.getState().saveTavilyApiKey(NEW_TAVILY_API_KEY)
      await waitForMicrotasks()
      const second = await store.getState().saveTavilyApiKey(null)
      writes[0]?.resolve(null)
      await first

      expect(second).toBe("busy")
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        tavilyApiKey: NEW_TAVILY_API_KEY
      })
    })
  })

  describe("sendTavilyKeyCheck", () => {
    it("reports checking until the backend answers, then the outcome", async () => {
      const keyCheck = createControlledRoute()
      const backend = startBackendFake({ [KEY_CHECK_ROUTE]: keyCheck.route })
      const store = createSecretsStore()

      const check = store.getState().sendTavilyKeyCheck()
      await waitForMicrotasks()
      const whileChecking = store.getState().tavilyKeyCheck
      keyCheck.responses[0]?.resolve(buildJsonResponse(200, ACCEPTED_CHECK))
      await check

      expect(whileChecking).toEqual({ status: "checking" })
      expect(store.getState().tavilyKeyCheck).toEqual({
        status: "checked",
        outcome: ACCEPTED_CHECK
      })
      expect(backend.requests).toHaveLength(1)
    })

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
      "reports that the check could not be asked when %s",
      async (_label, route) => {
        startBackendFake({ [KEY_CHECK_ROUTE]: route })
        const store = createSecretsStore()

        await expect(
          store.getState().sendTavilyKeyCheck()
        ).resolves.toBeUndefined()

        expect(store.getState().tavilyKeyCheck).toEqual({
          status: "failed",
          error: "Lys couldn't reach its backend to check the key."
        })
      }
    )

    it("sends nothing while a check runs", async () => {
      const keyCheck = createControlledRoute()
      const backend = startBackendFake({ [KEY_CHECK_ROUTE]: keyCheck.route })
      const store = createSecretsStore()

      const first = store.getState().sendTavilyKeyCheck()
      await waitForMicrotasks()
      await store.getState().sendTavilyKeyCheck()
      keyCheck.responses[0]?.resolve(buildJsonResponse(200, ACCEPTED_CHECK))
      await first

      expect(backend.requests).toHaveLength(1)
    })

    it("sends nothing while a removal runs, so the removed key is never reported as accepted", async () => {
      const { writes } = startControlledSettingsHost()
      const backend = startBackendFake({
        [KEY_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
      })
      const store = createSecretsStore()

      const removal = store.getState().saveTavilyApiKey(null)
      await waitForMicrotasks()
      await store.getState().sendTavilyKeyCheck()
      writes[0]?.resolve(null)
      await removal
      await waitForMicrotasks()

      expect(backend.requests).toHaveLength(0)
      expect(store.getState().tavilyKeyCheck).toEqual({ status: "idle" })
      expect(store.getState().settings.secrets).toEqual({
        ...STORED_SETTINGS.secrets,
        tavilyApiKey: null
      })
    })

    it("drops the late answer of a check that a save started after", async () => {
      const { writes } = startControlledSettingsHost()
      const keyCheck = createControlledRoute()
      startBackendFake({ [KEY_CHECK_ROUTE]: keyCheck.route })
      const store = createSecretsStore()

      const check = store.getState().sendTavilyKeyCheck()
      await waitForMicrotasks()
      const save = store.getState().saveTavilyApiKey(NEW_TAVILY_API_KEY)
      await waitForMicrotasks()
      keyCheck.responses[0]?.resolve(buildJsonResponse(200, ACCEPTED_CHECK))
      await check
      writes[0]?.resolve(null)
      await save

      expect(store.getState().tavilyKeyCheck).toEqual({ status: "idle" })
    })
  })
})
