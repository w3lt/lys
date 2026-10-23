import type { ComponentProps, ReactElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { locationSettingsSchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { useStore } from "zustand"
import { createStore } from "zustand/vanilla"
import LocationCard from "@/components/SettingsViewComponents/LocationCard"
import {
  createLocationSettingsSlice,
  type LocationSaveOutcome,
  type LocationSettingsSlice
} from "@/lib/store/location-settings"
import type { LysSettings } from "@/lib/store/settings"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import { STORED_SETTINGS } from "../../support/settingsFixtures"

/** Location saved on disk: a city and a country, no region. */
const SAVED_LOCATION = locationSettingsSchema.parse({
  city: "Lyon",
  region: null,
  country: "France"
})

/** Hint that describes every field. */
const FIELDS_HINT = "Each field is optional and holds up to 100 characters."

/** Properties accepted by the card. */
type LocationCardProps = ComponentProps<typeof LocationCard>

/** Store state the location slice borrows: the current settings and the slice. */
type LocationStore = LocationSettingsSlice & { readonly settings: LysSettings }

/**
 * Renders the card for a saved location with no save, and a spy for the save
 * request, which resolves with `saved` unless the case changes it.
 *
 * @param props - Card facts and request the case varies.
 * @returns The save spy and the render result.
 */
function startLocationCard(props: Partial<LocationCardProps> = {}) {
  const onSaveLocation = vi.fn<LocationCardProps["onSaveLocation"]>(() =>
    Promise.resolve("saved")
  )
  const cardProps: LocationCardProps = {
    savedLocation: SAVED_LOCATION,
    saveState: { status: "idle" },
    onSaveLocation,
    ...props
  }
  const rendered = render(<LocationCard {...cardProps} />)
  return { onSaveLocation, rendered }
}

/**
 * Renders the card on a store that owns the application's location slice, as
 * the Tools pane does. The stored location is {@link SAVED_LOCATION}.
 *
 * @returns The settings write of the first save, which stays pending until
 * the case settles it.
 */
function startLocationCardOnStore(): ControlledPromise<void> {
  const settingsWrite = createControlledPromise<void>()
  const store = createStore<LocationStore>()((set, get) => ({
    settings: STORED_SETTINGS,
    ...createLocationSettingsSlice(set, get, {
      saveLocationSettings: () => settingsWrite.promise
    })
  }))

  /**
   * Presents the card with the store's location, save, and command.
   *
   * @returns The card.
   */
  function StoreLocationCard(): ReactElement {
    const savedLocation = useStore(store, (state) => state.settings.location)
    const saveState = useStore(store, (state) => state.locationSave)
    const saveLocation = useStore(store, (state) => state.saveLocation)
    return (
      <LocationCard
        onSaveLocation={saveLocation}
        saveState={saveState}
        savedLocation={savedLocation}
      />
    )
  }

  render(<StoreLocationCard />)
  return settingsWrite
}

/**
 * Gets one field of the card.
 *
 * @param label - Label of the field.
 * @returns The input with that label.
 */
function getField(label: "City" | "Region" | "Country"): HTMLInputElement {
  const field = screen.getByLabelText(label)
  if (!(field instanceof HTMLInputElement)) throw new Error(`No ${label} input`)
  return field
}

describe("LocationCard", () => {
  it("shows the saved location in labelled fields, each described by the constraints", () => {
    startLocationCard()

    expect(screen.getByRole("form", { name: "Location" })).toBeInTheDocument()
    expect(getField("City")).toHaveValue("Lyon")
    expect(getField("Region")).toHaveValue("")
    expect(getField("Country")).toHaveValue("France")
    for (const label of ["City", "Region", "Country"] as const) {
      expect(getField(label)).toHaveAccessibleDescription(FIELDS_HINT)
    }
    expect(screen.getByRole("status")).toHaveTextContent(
      "saved · a model gets it only by calling get_location"
    )
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("saves the trimmed fields once on Enter, a blank field as null", async () => {
    const { onSaveLocation } = startLocationCard()
    const user = userEvent.setup()

    await user.type(getField("Region"), "  Auvergne-Rhône-Alpes ")
    expect(screen.getByRole("status")).toHaveTextContent(
      "unsaved · enter to save, esc to discard"
    )
    await user.keyboard("{Enter}")

    expect(onSaveLocation).toHaveBeenCalledOnce()
    expect(onSaveLocation).toHaveBeenCalledWith({
      city: "Lyon",
      region: "Auvergne-Rhône-Alpes",
      country: "France"
    })
  })

  it("removes the location when every field is emptied and saved with the button", async () => {
    const { onSaveLocation } = startLocationCard()
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.clear(getField("Country"))
    expect(screen.getByRole("status")).toHaveTextContent(
      "unsaved · enter to remove your location, esc to discard"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onSaveLocation).toHaveBeenCalledWith({
      city: null,
      region: null,
      country: null
    })
  })

  it("marks a field that is not a place name, says why, and offers no Save", async () => {
    const { onSaveLocation } = startLocationCard()
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "é".repeat(101))
    await user.keyboard("{Enter}")

    expect(getField("City")).toHaveAttribute("aria-invalid", "true")
    expect(getField("City")).toHaveAccessibleDescription(
      `Use at most 100 characters. ${FIELDS_HINT}`
    )
    expect(getField("Country")).not.toHaveAttribute("aria-invalid")
    expect(screen.getByRole("status")).toHaveTextContent(
      "can't save yet · fix the marked field"
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(onSaveLocation).not.toHaveBeenCalled()
  })

  it("discards the edit on Escape", async () => {
    startLocationCard()
    const user = userEvent.setup()

    await user.type(getField("City"), "-la-Duchère")
    await user.keyboard("{Escape}")

    expect(getField("City")).toHaveValue("Lyon")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("keeps the edit on an Escape that ends text composition", async () => {
    startLocationCard()
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "東京都")
    const isNotPrevented = fireEvent.keyDown(getField("City"), {
      key: "Escape",
      isComposing: true
    })

    expect(isNotPrevented).toBe(true)
    expect(getField("City")).toHaveValue("東京都")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("shows the saved location once the save succeeds", async () => {
    const save = createControlledPromise<LocationSaveOutcome>()
    const { onSaveLocation, rendered } = startLocationCard()
    onSaveLocation.mockReturnValue(save.promise)
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "Grenoble")
    await user.keyboard("{Enter}")
    const saved = locationSettingsSchema.parse({
      city: "Grenoble",
      region: null,
      country: "France"
    })
    rendered.rerender(
      <LocationCard
        onSaveLocation={onSaveLocation}
        saveState={{ status: "saved" }}
        savedLocation={saved}
      />
    )
    save.resolve("saved")
    await waitForMicrotasks()

    expect(getField("City")).toHaveValue("Grenoble")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("says a save runs, then that it failed, and keeps the edit", async () => {
    const settingsWrite = startLocationCardOnStore()
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "Grenoble{Enter}")

    expect(screen.getByRole("status")).toHaveTextContent("saving…")
    expect(getField("City")).toHaveValue("Grenoble")

    await act(async () => {
      settingsWrite.reject(new Error("The settings file is read-only."))
      await waitForMicrotasks()
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      "Lys couldn't write your location to its settings file."
    )
    expect(getField("City")).toHaveValue("Grenoble")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("keeps an edit typed while the save ran once the save succeeds", async () => {
    const settingsWrite = startLocationCardOnStore()
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "Grenoble{Enter}")
    await user.type(getField("Region"), "Isère")
    await act(async () => {
      settingsWrite.resolve()
      await waitForMicrotasks()
    })

    expect(getField("City")).toHaveValue("Grenoble")
    expect(getField("Region")).toHaveValue("Isère")
    expect(screen.getByRole("status")).toHaveTextContent(
      "unsaved · enter to save, esc to discard"
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("asks for no save while one runs", async () => {
    const { onSaveLocation } = startLocationCard({
      saveState: { status: "saving" }
    })
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "Grenoble{Enter}")

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(onSaveLocation).not.toHaveBeenCalled()
  })

  it("shows a failed save in the status line", () => {
    startLocationCard({
      saveState: {
        status: "failed",
        error: "Lys couldn't write your location to its settings file."
      }
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      "Lys couldn't write your location to its settings file."
    )
  })
})
