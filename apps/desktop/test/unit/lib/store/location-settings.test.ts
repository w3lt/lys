import { locationSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createLocationSettingsSlice,
  type LocationSettingsSlice
} from "@/lib/store/location-settings"
import type { LysSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  STORED_LOCATION_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type LocationStore = LocationSettingsSlice & { settings: LysSettings }

/** Location the person saves in place of the stored one. */
const NEW_LOCATION = locationSettingsSchema.parse({
  city: null,
  region: "Québec",
  country: "Canada"
})

/** Location whose parts are all null: none saved. */
const NO_LOCATION = locationSettingsSchema.parse({
  city: null,
  region: null,
  country: null
})

/**
 * Creates a store holding the stored settings, with a saved location.
 *
 * @returns A store owning one location slice, whose saves run through the
 * application's settings-group saves over the native host.
 */
function createLocationStore() {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<LocationStore>()((set, get) => ({
    settings: STORED_SETTINGS,
    ...createLocationSettingsSlice(set, get, {
      saveLocationSettings: settingsGroupSaves.saveLocationSettings
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

describe("createLocationSettingsSlice", () => {
  it("starts with no save", () => {
    const store = createLocationStore()

    expect(store.getState().locationSave).toEqual({ status: "idle" })
  })

  it("reports saving until the write completes, then holds the new location, keeping the other groups on disk", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLocationStore()

    const save = store.getState().saveLocation(NEW_LOCATION)
    await waitForMicrotasks()
    const whileWriting = store.getState()
    writes[0]?.resolve(null)

    await expect(save).resolves.toBe("saved")
    expect(whileWriting.locationSave).toEqual({ status: "saving" })
    expect(whileWriting.settings.location).toEqual(STORED_LOCATION_SETTINGS)
    expect(store.getState().locationSave).toEqual({ status: "saved" })
    expect(store.getState().settings.location).toEqual(NEW_LOCATION)
    expect(listSettingsWrites(host.commands)).toEqual([
      { newSettings: { ...STORED_SETTINGS_DOCUMENT, location: NEW_LOCATION } }
    ])
  })

  it("removes the saved location with a location whose parts are all null", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLocationStore()

    const removal = store.getState().saveLocation(NO_LOCATION)
    await waitForMicrotasks()
    writes[0]?.resolve(null)

    await expect(removal).resolves.toBe("saved")
    expect(store.getState().settings.location).toEqual(NO_LOCATION)
    expect(listSettingsWrites(host.commands)).toEqual([
      { newSettings: { ...STORED_SETTINGS_DOCUMENT, location: NO_LOCATION } }
    ])
  })

  it("keeps the saved location in memory and reports a failed save without the host's detail", async () => {
    const { writes } = startControlledSettingsHost()
    const store = createLocationStore()

    const save = store.getState().saveLocation(NEW_LOCATION)
    await waitForMicrotasks()
    writes[0]?.reject("EACCES: /Users/someone/.lys/settings.json")

    await expect(save).resolves.toBe("failed")
    expect(store.getState().locationSave).toEqual({
      status: "failed",
      error: "Lys couldn't write your location to its settings file."
    })
    expect(store.getState().settings.location).toEqual(STORED_LOCATION_SETTINGS)
  })

  it("answers busy without writing while another save runs", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createLocationStore()

    const first = store.getState().saveLocation(NEW_LOCATION)
    await waitForMicrotasks()
    const second = await store.getState().saveLocation(NO_LOCATION)
    writes[0]?.resolve(null)
    await first

    expect(second).toBe("busy")
    expect(listSettingsWrites(host.commands)).toHaveLength(1)
    expect(store.getState().settings.location).toEqual(NEW_LOCATION)
  })
})
