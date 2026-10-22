import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { locationSettingsSchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import LocationCard from "@/components/SettingsViewComponents/LocationCard"
import type { LocationSaveOutcome } from "@/lib/store/location-settings"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

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

  it("keeps the edit when the save fails", async () => {
    const { onSaveLocation } = startLocationCard()
    onSaveLocation.mockResolvedValue("failed")
    const user = userEvent.setup()

    await user.clear(getField("City"))
    await user.type(getField("City"), "Grenoble")
    await user.keyboard("{Enter}")
    await waitForMicrotasks()

    expect(getField("City")).toHaveValue("Grenoble")
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
