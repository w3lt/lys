import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { startBackendFake } from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import {
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"

/**
 * Renders the settings view on the Profile pane with the stored settings,
 * whose location is Lyon, France, and a host whose writes succeed, and
 * waits for the body.
 *
 * @returns The stores and the host observation handle.
 */
async function startProfilePane() {
  const host = startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => null,
    list_tools: () => []
  })
  startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
  const { useLysStore, SettingsView } = await loadFreshSettingsView("profile")
  const { useLocalProfileStore } = await import("@/lib/store/local-profile")
  useLysStore.setState({ settings: STORED_SETTINGS })
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("heading", { level: 2, name: /About you/ })
  await waitForRenderedWork()
  return { useLysStore, useLocalProfileStore, host }
}

/**
 * Gets the disclosure button of one of the pane's sections.
 *
 * @param title - Matches the section's title.
 * @returns The button in the section's level-two heading.
 */
function getSectionButton(title: RegExp): HTMLElement {
  return within(
    screen.getByRole("heading", { level: 2, name: title })
  ).getByRole("button")
}

describe("ProfilePaneContent", () => {
  it("shows what a model learns with every request, and the location only when asked", async () => {
    const { useLysStore } = await startProfilePane()
    const user = userEvent.setup()

    expect(
      screen.getByText(
        "Lys works for you. This is everything it passes on, and when."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("Your name, languages and preferences.")
    ).toBeInTheDocument()
    expect(screen.getByText("Lyon")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Tools" }))

    expect(useLysStore.getState().settingsPane).toBe("tools")
  })

  it("keeps About you at once, and the model view and help follow it", async () => {
    const { useLocalProfileStore } = await startProfilePane()
    const user = userEvent.setup()
    const name = screen.getByRole("textbox", { name: "Name" })

    await user.type(name, "Ada Lovelace")
    await user.type(
      screen.getByRole("textbox", { name: /^Lys calls you/ }),
      "Ada"
    )
    await user.type(
      screen.getByRole("textbox", { name: /^Pronouns/ }),
      "she/her"
    )

    expect(useLocalProfileStore.getState().personIdentity).toMatchObject({
      name: "Ada Lovelace",
      callName: "Ada",
      pronouns: "she/her"
    })
    expect(name).toHaveAccessibleDescription(
      'Used when Lys writes on your behalf, as in "Assistant to Ada".'
    )
    expect(
      screen.getByText(
        "Lys works for Ada. This is everything it passes on, and when."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("Your name, pronouns, languages and preferences.")
    ).toBeInTheDocument()
    await user.click(getSectionButton(/About you/))
    expect(getSectionButton(/About you/)).toHaveTextContent(
      "Ada · she/her · English"
    )
  })

  it("saves the location from its section, which get_location reads", async () => {
    const { useLysStore } = await startProfilePane()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Country" }))
    await user.click(screen.getByRole("button", { name: "Save location" }))
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.location).toEqual({
      city: null,
      region: null,
      country: "France"
    })
    await user.click(getSectionButton(/^Location/))
    expect(getSectionButton(/^Location/)).toHaveTextContent(
      "France · shared down to country"
    )
  })

  it("chooses how answers are written, and previews it", async () => {
    const { useLocalProfileStore } = await startProfilePane()
    const user = userEvent.setup()
    const temperature = screen.getByRole("group", { name: "Temperature" })

    expect(
      within(temperature).getByRole("button", { name: "°C" })
    ).toHaveAttribute("aria-pressed", "true")
    await user.click(within(temperature).getByRole("button", { name: "°F" }))
    await user.click(
      within(screen.getByRole("group", { name: "Time" })).getByRole("button", {
        name: "5:05 pm"
      })
    )

    expect(useLocalProfileStore.getState().writingPreferences).toMatchObject({
      temperature: "fahrenheit",
      clock: "12-hour"
    })
    expect(
      screen.getByText(
        "Dates like 14/11/2026 at 5:05 pm, distances in kilometres, weather in °F, weeks from Monday."
      )
    ).toBeInTheDocument()
  })

  it("counts the notes, and leaves them out of every request once switched off", async () => {
    const { useLocalProfileStore } = await startProfilePane()
    const user = userEvent.setup()
    const notes = screen.getByRole("textbox", { name: "Notes" })

    await user.type(notes, "Keep answers short.")

    expect(screen.getByText("19 / 1000")).toBeInTheDocument()
    expect(notes).toHaveAccessibleDescription("~11 tokens with every request.")
    expect(
      screen.getByText("Your name, languages and preferences, and your notes.")
    ).toBeInTheDocument()
    expect(notes).toHaveAttribute("maxlength", "1000")

    await user.click(
      screen.getByRole("switch", { name: "Send with every request" })
    )

    expect(useLocalProfileStore.getState().notesForLys).toEqual({
      text: "Keep answers short.",
      isSentWithEveryRequest: false
    })
    expect(notes).toHaveAccessibleDescription(
      "Kept here, not sent. Switch it on to add it to every request."
    )
    expect(
      screen.getByText("Your name, languages and preferences.")
    ).toBeInTheDocument()
  })

  it("shows the Lys pane from its closing note, with focus on its title", async () => {
    const { useLysStore } = await startProfilePane()
    const user = userEvent.setup()
    screen.getByRole("button", { name: "Lys" }).focus()

    await user.keyboard("{Enter}")

    expect(useLysStore.getState().settingsPane).toBe("lys")
    expect(
      await screen.findByRole("heading", { level: 1, name: "Lys" })
    ).toHaveFocus()
  })
})
