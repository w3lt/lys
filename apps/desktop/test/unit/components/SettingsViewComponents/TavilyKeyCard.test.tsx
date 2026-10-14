import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { tavilyApiKeySchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import TavilyKeyCard from "@/components/SettingsViewComponents/TavilyKeyCard"
import type { SecretsSaveOutcome } from "@/lib/store/secrets-settings"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Key saved on disk; long enough to show its ends around the mask. */
const SAVED_KEY = tavilyApiKeySchema.parse("tvly-dev-abcdefghij1234")

/** Properties accepted by the card. */
type TavilyKeyCardProps = ComponentProps<typeof TavilyKeyCard>

/**
 * Renders the card for a saved key with no save and no check, and a spy for
 * every request; saves and removals resolve with `saved` unless the case
 * changes them.
 *
 * @param props - Card facts and requests the case varies.
 * @returns The request spies and the render result.
 */
function startTavilyKeyCard(props: Partial<TavilyKeyCardProps> = {}) {
  const requests = {
    onSaveTavilyApiKey: vi.fn<TavilyKeyCardProps["onSaveTavilyApiKey"]>(() =>
      Promise.resolve("saved")
    ),
    onRemoveTavilyApiKey: vi.fn<TavilyKeyCardProps["onRemoveTavilyApiKey"]>(
      () => Promise.resolve("saved")
    ),
    onSendTavilyKeyCheck: vi.fn<TavilyKeyCardProps["onSendTavilyKeyCheck"]>(
      () => Promise.resolve()
    )
  }
  const cardProps: TavilyKeyCardProps = {
    savedApiKey: SAVED_KEY,
    saveState: { status: "idle" },
    keyCheck: { status: "idle" },
    ...requests,
    ...props
  }
  const rendered = render(<TavilyKeyCard {...cardProps} />)
  return { requests, rendered }
}

/**
 * Gets the key field.
 *
 * @returns The input labelled API key.
 */
function getKeyField(): HTMLInputElement {
  const field = screen.getByLabelText("API key")
  if (!(field instanceof HTMLInputElement)) throw new Error("No key input")
  return field
}

/**
 * Gets the card's status line, which describes the key field.
 *
 * @returns The polite status region.
 */
function getStatusLine(): HTMLElement {
  return screen.getByRole("status")
}

describe("TavilyKeyCard", () => {
  it("names the service, the saved key's state, and a link to get a key", () => {
    startTavilyKeyCard()

    expect(screen.getByRole("article", { name: "Tavily" })).toHaveTextContent(
      /^Tavily.*in use/
    )
    const link = screen.getByRole("link", { name: /get a key/ })
    expect(link).toHaveAttribute("href", "https://app.tavily.com")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer")
  })

  it.each<[string, Partial<TavilyKeyCardProps>, string]>([
    ["no key", { savedApiKey: null }, "no key"],
    [
      "an accepted check",
      {
        keyCheck: {
          status: "checked",
          outcome: { status: "accepted", credits: null }
        }
      },
      "verified"
    ],
    [
      "a rejected check",
      { keyCheck: { status: "checked", outcome: { status: "rejected" } } },
      "rejected"
    ]
  ])("shows %s on the badge", (_label, props, badge) => {
    startTavilyKeyCard(props)

    expect(screen.getByRole("article", { name: "Tavily" })).toHaveTextContent(
      badge
    )
  })

  it("hides the saved key behind a masked placeholder, and shows it on request", async () => {
    startTavilyKeyCard()
    const user = userEvent.setup()
    const show = screen.getByRole("button", { name: "Show Tavily API key" })

    expect(getKeyField()).toHaveAttribute("type", "password")
    expect(getKeyField()).toHaveValue("")
    expect(getKeyField()).toHaveAttribute("placeholder", "tvly-••••••••1234")
    expect(getKeyField()).toHaveAccessibleDescription(
      "saved · tvly-••••••••1234"
    )
    expect(show).toHaveAttribute("aria-pressed", "false")

    await user.click(show)

    expect(getKeyField()).toHaveAttribute("type", "text")
    expect(getKeyField()).toHaveValue(SAVED_KEY)
    expect(show).toHaveAttribute("aria-pressed", "true")
  })

  it("marks an invalid key and offers no Save for it", async () => {
    const { requests } = startTavilyKeyCard()
    const user = userEvent.setup()

    await user.type(getKeyField(), "tvly bad{Enter}")

    expect(getKeyField()).toHaveAttribute("aria-invalid", "true")
    expect(getStatusLine()).toHaveTextContent(
      "not a valid key: paste it exactly as Tavily shows it, without spaces"
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(requests.onSaveTavilyApiKey).not.toHaveBeenCalled()
  })

  it("saves a new key once on Enter, trimmed, then clears and hides the field", async () => {
    const { requests } = startTavilyKeyCard()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole("button", { name: "Show Tavily API key" })
    )
    await user.clear(getKeyField())

    await user.type(getKeyField(), " tvly-new-key {Enter}")
    await waitForMicrotasks()

    expect(requests.onSaveTavilyApiKey).toHaveBeenCalledExactlyOnceWith(
      "tvly-new-key"
    )
    expect(getKeyField()).toHaveValue("")
    expect(getKeyField()).toHaveAttribute("type", "password")
  })

  it("saves a new key with the Save button", async () => {
    const { requests } = startTavilyKeyCard({ savedApiKey: null })
    const user = userEvent.setup()

    await user.type(getKeyField(), "tvly-first-key")
    expect(getStatusLine()).toHaveTextContent(
      "unsaved · enter to save, esc to discard"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(requests.onSaveTavilyApiKey).toHaveBeenCalledExactlyOnceWith(
      "tvly-first-key"
    )
  })

  it("keeps the edit when the save fails", async () => {
    const onSaveTavilyApiKey = vi.fn(() =>
      Promise.resolve<SecretsSaveOutcome>("failed")
    )
    startTavilyKeyCard({ onSaveTavilyApiKey })
    const user = userEvent.setup()

    await user.type(getKeyField(), "tvly-new-key{Enter}")
    await waitForMicrotasks()

    expect(onSaveTavilyApiKey).toHaveBeenCalledOnce()
    expect(getKeyField()).toHaveValue("tvly-new-key")
  })

  it("asks for no save while one runs", async () => {
    const { requests } = startTavilyKeyCard({ saveState: { status: "saving" } })
    const user = userEvent.setup()

    await user.type(getKeyField(), "tvly-new-key{Enter}")

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(requests.onSaveTavilyApiKey).not.toHaveBeenCalled()
  })

  it("discards the edit on Escape", async () => {
    startTavilyKeyCard()
    const user = userEvent.setup()

    await user.type(getKeyField(), "tvly-new-key{Escape}")

    expect(getKeyField()).toHaveValue("")
    expect(getStatusLine()).toHaveTextContent("saved · tvly-••••••••1234")
  })

  it("offers Test and Remove only for a saved, unedited key", async () => {
    const user = userEvent.setup()
    const { rendered } = startTavilyKeyCard({ savedApiKey: null })
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull()
    rendered.unmount()

    startTavilyKeyCard()
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled()
    await user.type(getKeyField(), "tvly-new-key")

    expect(screen.queryByRole("button", { name: "Test" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull()
  })

  it("asks once for a check per press of Test", async () => {
    const { requests } = startTavilyKeyCard()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test" }))

    expect(requests.onSendTavilyKeyCheck).toHaveBeenCalledOnce()
  })

  it.each<[string, Partial<TavilyKeyCardProps>]>([
    ["a check runs", { keyCheck: { status: "checking" } }],
    // A check during a removal would report on the key being removed.
    ["a save runs", { saveState: { status: "saving" } }]
  ])("offers no Test while %s", async (_label, props) => {
    const { requests } = startTavilyKeyCard(props)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test" }))

    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled()
    expect(requests.onSendTavilyKeyCheck).not.toHaveBeenCalled()
  })

  it("removes the key, then moves focus to the empty field", async () => {
    const removal = createControlledPromise<SecretsSaveOutcome>()
    const onRemoveTavilyApiKey = vi.fn(() => removal.promise)
    startTavilyKeyCard({ onRemoveTavilyApiKey })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove" }))
    const focusedWhileRemoving = document.activeElement
    removal.resolve("saved")
    await waitForMicrotasks()

    expect(onRemoveTavilyApiKey).toHaveBeenCalledOnce()
    expect(focusedWhileRemoving).toBe(
      screen.getByRole("button", { name: "Remove" })
    )
    expect(getKeyField()).toHaveFocus()
  })

  it("keeps focus where it is when the removal fails", async () => {
    startTavilyKeyCard({
      onRemoveTavilyApiKey: vi.fn(() =>
        Promise.resolve<SecretsSaveOutcome>("failed")
      )
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove" }))
    await waitForMicrotasks()

    expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus()
  })

  it("offers no Remove while a save runs", async () => {
    const { requests } = startTavilyKeyCard({ saveState: { status: "saving" } })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled()
    expect(requests.onRemoveTavilyApiKey).not.toHaveBeenCalled()
  })

  it("announces the status line politely", () => {
    startTavilyKeyCard({ keyCheck: { status: "checking" } })

    expect(getStatusLine()).toHaveAttribute("aria-live", "polite")
    expect(getStatusLine()).toHaveTextContent("checking with tavily…")
  })
})
