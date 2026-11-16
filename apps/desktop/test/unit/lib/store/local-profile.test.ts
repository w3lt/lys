import { describe, expect, it, vi } from "vitest"
import {
  createLocalProfileStore,
  type LocalProfileStoreDependencies
} from "@/lib/store/local-profile"

/** First time the store's clock reads. */
const FIRST_READ = new Date("2026-11-14T09:30:00Z")

/** Second time the store's clock reads. */
const SECOND_READ = new Date("2026-11-14T09:45:00Z")

/**
 * Creates a store whose clock reads {@link FIRST_READ}, then
 * {@link SECOND_READ}, on a machine in Paris, with spies for object URLs.
 *
 * @returns The store and its dependencies.
 */
function startLocalProfileStore() {
  const dependencies = {
    now: vi
      .fn<LocalProfileStoreDependencies["now"]>()
      .mockReturnValueOnce(FIRST_READ)
      .mockReturnValueOnce(SECOND_READ),
    machineTimeZone: "Europe/Paris",
    createObjectUrl: vi
      .fn<LocalProfileStoreDependencies["createObjectUrl"]>()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second"),
    revokeObjectUrl: vi.fn<LocalProfileStoreDependencies["revokeObjectUrl"]>()
  }
  return { store: createLocalProfileStore(dependencies), dependencies }
}

describe("createLocalProfileStore", () => {
  it("starts with Lys in this machine's time zone, no person, metric preferences, and empty notes sent with every request", () => {
    const { store } = startLocalProfileStore()

    expect(store.getState()).toMatchObject({
      lysIdentity: {
        name: "Lys",
        fullName: "",
        timeZone: "Europe/Paris",
        writesIn: "English"
      },
      lysPortraitUrl: null,
      lysIdentityEditedAt: null,
      personIdentity: {
        name: "",
        callName: "",
        pronouns: "",
        reads: "English"
      },
      writingPreferences: {
        units: "metric",
        temperature: "celsius",
        dates: "day-month-year",
        clock: "24-hour",
        week: "monday"
      },
      notesForLys: { text: "", isSentWithEveryRequest: true }
    })
  })

  it("changes some of how Lys introduces itself, keeping the rest, and records when", () => {
    const { store } = startLocalProfileStore()

    store.getState().updateLysIdentity({ name: "Iris" })

    expect(store.getState().lysIdentity).toMatchObject({
      name: "Iris",
      fullName: ""
    })
    expect(store.getState().lysIdentityEditedAt).toBe(FIRST_READ)
  })

  it("replaces Lys's portrait, revoking the URL of the replaced one, and records when", () => {
    const { store, dependencies } = startLocalProfileStore()
    const first = new Blob(["first"], { type: "image/png" })
    const second = new Blob(["second"], { type: "image/png" })

    store.getState().replaceLysPortrait(first)
    expect(dependencies.revokeObjectUrl).not.toHaveBeenCalled()
    store.getState().replaceLysPortrait(second)

    expect(dependencies.createObjectUrl.mock.calls).toEqual([[first], [second]])
    expect(dependencies.revokeObjectUrl).toHaveBeenCalledExactlyOnceWith(
      "blob:first"
    )
    expect(store.getState().lysPortraitUrl).toBe("blob:second")
    expect(store.getState().lysIdentityEditedAt).toBe(SECOND_READ)
  })

  it("changes some of the person's identity, preferences, and notes, keeping the rest", () => {
    const { store } = startLocalProfileStore()

    store.getState().updatePersonIdentity({ name: "Ada" })
    store.getState().updateWritingPreferences({ clock: "12-hour" })
    store.getState().updateNotesForLys({ isSentWithEveryRequest: false })

    expect(store.getState()).toMatchObject({
      personIdentity: { name: "Ada", reads: "English" },
      writingPreferences: { clock: "12-hour", units: "metric" },
      notesForLys: { text: "", isSentWithEveryRequest: false }
    })
  })
})
