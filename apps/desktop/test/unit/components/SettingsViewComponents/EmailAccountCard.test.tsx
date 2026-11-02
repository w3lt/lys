import type { ComponentProps } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import EmailAccountCard from "@/components/SettingsViewComponents/EmailAccountCard"
import type {
  EmailAccountRemovalOutcome,
  EmailAccountSaveOutcome
} from "@/lib/store/email-settings"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"
import {
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD
} from "../../support/settingsFixtures"

/** Properties accepted by the card. */
type EmailAccountCardProps = ComponentProps<typeof EmailAccountCard>

/** Problem of an address that is not one. */
const ADDRESS_PROBLEM = /address/i

/**
 * Renders the card for the stored account and password with no save and no
 * check, the backend running, and a spy for every request; saves and
 * removals resolve with `saved` unless the case changes them.
 *
 * @param props - Card facts and requests the case varies.
 * @returns The request spies and the render result.
 */
function startEmailAccountCard(props: Partial<EmailAccountCardProps> = {}) {
  const requests = {
    onSaveEmailAccount: vi.fn<EmailAccountCardProps["onSaveEmailAccount"]>(() =>
      Promise.resolve("saved")
    ),
    onRemoveEmailAccount: vi.fn<EmailAccountCardProps["onRemoveEmailAccount"]>(
      () => Promise.resolve("saved")
    )
  }
  const cardProps: EmailAccountCardProps = {
    savedAccount: STORED_EMAIL_ACCOUNT,
    savedPassword: STORED_EMAIL_PASSWORD,
    saveState: { status: "idle" },
    checkState: { status: "idle" },
    isBackendRunning: true,
    ...requests,
    ...props
  }
  const rendered = render(<EmailAccountCard {...cardProps} />)
  return { requests, rendered }
}

/**
 * Renders the card without a saved account, as a first visit shows it.
 *
 * @param props - Card facts and requests the case varies.
 * @returns The request spies and the render result.
 */
function startEmptyEmailAccountCard(
  props: Partial<EmailAccountCardProps> = {}
) {
  return startEmailAccountCard({
    savedAccount: null,
    savedPassword: null,
    ...props
  })
}

/**
 * Gets the card.
 *
 * @returns The form named Email account.
 */
function getCard(): HTMLElement {
  return screen.getByRole("form", { name: "Email account" })
}

/**
 * Gets one text field of the account.
 *
 * @param label - Visible label of the field.
 * @returns The input.
 */
function getField(label: string): HTMLElement {
  return within(getCard()).getByRole("textbox", { name: label })
}

/**
 * Gets one text field of one server.
 *
 * @param server - Legend of the server's fields.
 * @param label - Visible label of the field.
 * @returns The input.
 */
function getServerField(server: string, label: string): HTMLElement {
  return within(screen.getByRole("group", { name: server })).getByRole(
    "textbox",
    { name: label }
  )
}

/**
 * Gets one way to secure the connection to one server.
 *
 * @param server - Legend of the server's fields.
 * @param label - Label of the way.
 * @returns The pressable choice.
 */
function getSecurityChoice(server: string, label: string): HTMLElement {
  const security = within(
    screen.getByRole("group", { name: server })
  ).getByRole("group", { name: "Security" })
  return within(security).getByRole("button", { name: label })
}

/**
 * Gets the password field.
 *
 * @returns The input labelled Password.
 */
function getPasswordField(): HTMLInputElement {
  const field = screen.getByLabelText("Password")
  if (!(field instanceof HTMLInputElement)) throw new Error("No password input")
  return field
}

/**
 * Gets the card's status line.
 *
 * @returns The polite status region.
 */
function getStatusLine(): HTMLElement {
  return within(getCard()).getByRole("status")
}

/**
 * Gets the Save button.
 *
 * @returns The submit button.
 */
function getSaveButton(): HTMLElement {
  return within(getCard()).getByRole("button", { name: "Save" })
}

/**
 * Updates the fields of an empty card to a Gmail account, typing each.
 *
 * @param user - User-event session of the case.
 */
async function updateGmailAccountFields(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await user.type(getField("Address"), "ada@gmail.com")
  await user.type(getField("Display name"), "Ada")
  await user.type(getField("User name"), "ada@gmail.com")
  await user.type(getPasswordField(), "app-password")
}

describe("EmailAccountCard", () => {
  it("names the card, shows the saved account, and keeps the saved password out of the field", () => {
    startEmailAccountCard()

    expect(getCard()).toHaveTextContent(
      "Lys signs in to IMAP and SMTP before saving. Gmail, iCloud, and Yahoo need an app password."
    )
    expect(getField("Address")).toHaveValue("ada@fastmail.com")
    expect(getField("Display name")).toHaveValue("Ada Fixture")
    expect(getField("User name")).toHaveValue("ada@fastmail.com")
    expect(getPasswordField()).toHaveValue("")
    expect(getPasswordField()).toHaveAttribute("type", "password")
    expect(getPasswordField()).toHaveAttribute("placeholder", "••••••••")
    expect(getPasswordField()).toHaveAccessibleDescription(
      "Leave empty to keep the saved password."
    )
    expect(getServerField("IMAP server", "Host")).toHaveValue(
      "imap.fastmail.com"
    )
    expect(getServerField("IMAP server", "Port")).toHaveValue("993")
    expect(getSecurityChoice("IMAP server", "TLS")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(getServerField("SMTP server", "Host")).toHaveValue(
      "smtp.fastmail.com"
    )
    expect(getServerField("SMTP server", "Port")).toHaveValue("465")
    expect(
      screen.getByRole("switch", { name: "Server keeps a copy of sent mail" })
    ).toBeChecked()
    expect(getStatusLine()).toHaveTextContent("Saved · ada@fastmail.com")
    expect(getStatusLine()).toHaveAttribute("aria-live", "polite")
    expect(getSaveButton()).toBeDisabled()
    expect(
      within(getCard()).getByRole("button", { name: "Remove account" })
    ).toBeEnabled()
    expect(getCard()).not.toHaveTextContent(STORED_EMAIL_PASSWORD)
  })

  it("starts empty without an account, with TLS on both servers and no Remove account", () => {
    startEmptyEmailAccountCard()

    expect(getField("Address")).toHaveValue("")
    expect(getPasswordField()).not.toHaveAttribute("placeholder")
    expect(getPasswordField()).not.toHaveAccessibleDescription()
    expect(getServerField("IMAP server", "Host")).toHaveValue("")
    expect(getSecurityChoice("SMTP server", "TLS")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(
      screen.getByRole("switch", { name: "Server keeps a copy of sent mail" })
    ).not.toBeChecked()
    expect(getStatusLine()).toHaveTextContent(
      "No account yet. The email server stays off until you save one."
    )
    expect(
      within(getCard()).queryByRole("button", { name: "Remove account" })
    ).toBeNull()
    expect(getSaveButton()).toBeEnabled()
  })

  it("marks the required fields and states the port range before entry", () => {
    startEmptyEmailAccountCard()

    expect(getField("Address")).toBeRequired()
    expect(getField("Display name")).not.toBeRequired()
    expect(getField("User name")).toBeRequired()
    expect(getPasswordField()).toBeRequired()
    expect(getServerField("IMAP server", "Host")).toBeRequired()
    expect(getServerField("IMAP server", "Port")).toBeRequired()
    expect(getServerField("IMAP server", "Port")).toHaveAccessibleDescription(
      "1–65535"
    )
    expect(getServerField("SMTP server", "Host")).toBeRequired()
    expect(getServerField("SMTP server", "Port")).toBeRequired()
    expect(getServerField("SMTP server", "Port")).toHaveAccessibleDescription(
      "1–65535"
    )
    expect(within(getCard()).getAllByText("required")).toHaveLength(7)
  })

  it("does not mark the password required while an empty field keeps the saved one", () => {
    startEmailAccountCard()

    expect(getPasswordField()).not.toBeRequired()
    expect(within(getCard()).getAllByText("required")).toHaveLength(6)
  })

  it("fills the servers from the address's preset and says which preset applies", async () => {
    startEmptyEmailAccountCard()
    const user = userEvent.setup()

    await user.type(getField("Address"), "ada@gmail.com")

    expect(getServerField("IMAP server", "Host")).toHaveValue("imap.gmail.com")
    expect(getServerField("IMAP server", "Port")).toHaveValue("993")
    expect(getServerField("SMTP server", "Host")).toHaveValue("smtp.gmail.com")
    expect(getServerField("SMTP server", "Port")).toHaveValue("465")
    expect(
      screen.getByRole("switch", { name: "Server keeps a copy of sent mail" })
    ).toBeChecked()
    expect(getField("Address")).toHaveAccessibleDescription("Preset: Gmail")

    await user.clear(getServerField("SMTP server", "Port"))
    await user.type(getServerField("SMTP server", "Port"), "587")

    expect(getField("Address")).toHaveAccessibleDescription(
      "Preset: Gmail · servers changed"
    )
  })

  it("asks for the servers of a provider without a preset", async () => {
    startEmptyEmailAccountCard()
    const user = userEvent.setup()

    await user.type(getField("Address"), "ada@example.test")

    expect(getField("Address")).toHaveAccessibleDescription(
      "No preset for this address. Enter the servers."
    )
    expect(getServerField("IMAP server", "Host")).toHaveValue("")
  })

  it("shows the typed password on request", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()
    const show = screen.getByRole("button", { name: "Show password" })

    await user.type(getPasswordField(), "new-app-password")
    expect(show).toHaveAttribute("aria-pressed", "false")
    await user.click(show)

    expect(getPasswordField()).toHaveAttribute("type", "text")
    expect(getPasswordField()).toHaveValue("new-app-password")
    expect(show).toHaveAttribute("aria-pressed", "true")
  })

  it("offers Save once a field differs, and says the save signs in first", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()

    await user.type(getField("Display name"), " Lovelace")

    expect(getSaveButton()).toBeEnabled()
    expect(getStatusLine()).toHaveTextContent(
      "Unsaved · Save signs in to both servers first."
    )
    expect(
      within(getCard()).queryByRole("button", { name: "Remove account" })
    ).toBeNull()
  })

  it("offers no Save while the backend is not running, and says what to start", async () => {
    const { requests } = startEmailAccountCard({ isBackendRunning: false })
    const user = userEvent.setup()

    await user.type(getField("Display name"), " Lovelace{Enter}")

    expect(getSaveButton()).toBeDisabled()
    expect(getStatusLine()).toHaveTextContent(
      "Unsaved · start the backend in Settings → Runtime to sign in and save."
    )
    expect(requests.onSaveEmailAccount).not.toHaveBeenCalled()
  })

  it("says what to start once an empty card is typed in, before it holds a whole account, while the backend is not running", async () => {
    const { requests } = startEmptyEmailAccountCard({ isBackendRunning: false })
    const user = userEvent.setup()

    expect(getStatusLine()).toHaveTextContent(
      "No account yet. The email server stays off until you save one."
    )

    await user.type(getField("Address"), "ada@fastmail.com")
    await user.type(getField("User name"), "ada@fastmail.com{Enter}")

    expect(getSaveButton()).toBeDisabled()
    expect(getStatusLine()).toHaveTextContent(
      "Unsaved · start the backend in Settings → Runtime to sign in and save."
    )
    expect(requests.onSaveEmailAccount).not.toHaveBeenCalled()
  })

  it("marks the fields that break a rule on Save, moves focus to the first, and asks for no save", async () => {
    const { requests } = startEmptyEmailAccountCard()
    const user = userEvent.setup()

    await user.type(getField("Address"), "ada")
    await user.type(getField("User name"), "ada{Enter}")

    expect(getField("Address")).toHaveAttribute("aria-invalid", "true")
    expect(getField("Address")).toHaveAccessibleDescription(ADDRESS_PROBLEM)
    expect(getField("Address")).toHaveFocus()
    expect(getServerField("IMAP server", "Host")).toHaveAttribute(
      "aria-invalid",
      "true"
    )
    expect(getServerField("IMAP server", "Port")).toHaveAccessibleDescription(
      "1–65535 A port is a whole number from 1 to 65535."
    )
    expect(getPasswordField()).toHaveAccessibleDescription(
      "Enter the password."
    )
    expect(getField("User name")).not.toHaveAttribute("aria-invalid")
    expect(getStatusLine()).toHaveTextContent("Fix the marked fields to save.")
    expect(requests.onSaveEmailAccount).not.toHaveBeenCalled()

    await user.type(getField("Address"), "@gmail.com")

    expect(getField("Address")).not.toHaveAttribute("aria-invalid")
    expect(getField("Address")).toHaveAccessibleDescription("Preset: Gmail")
    expect(getPasswordField()).toHaveAccessibleDescription(
      "Enter the password."
    )
  })

  it("signs in and saves on Enter with the typed account and password, then clears the edit", async () => {
    const { requests } = startEmptyEmailAccountCard()
    const user = userEvent.setup()

    await updateGmailAccountFields(user)
    await user.keyboard("{Enter}")
    await waitForMicrotasks()

    expect(requests.onSaveEmailAccount).toHaveBeenCalledExactlyOnceWith(
      {
        address: "ada@gmail.com",
        displayName: "Ada",
        userName: "ada@gmail.com",
        imap: { host: "imap.gmail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
        serverKeepsSentCopy: true
      },
      "app-password"
    )
    expect(getField("Address")).toHaveValue("")
    expect(getPasswordField()).toHaveValue("")
  })

  it("saves a new password for the saved account with the Save button, then hides the field again", async () => {
    const { requests } = startEmailAccountCard()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Show password" }))

    await user.type(getPasswordField(), "new-app-password")
    await user.click(getSaveButton())
    await waitForMicrotasks()

    expect(requests.onSaveEmailAccount).toHaveBeenCalledExactlyOnceWith(
      STORED_EMAIL_ACCOUNT,
      "new-app-password"
    )
    expect(getPasswordField()).toHaveValue("")
    expect(getPasswordField()).toHaveAttribute("type", "password")
  })

  it.each<EmailAccountSaveOutcome>(["refused", "failed", "busy"])(
    "keeps the edit when the save is %s",
    async (outcome) => {
      const onSaveEmailAccount = vi.fn(() => Promise.resolve(outcome))
      startEmailAccountCard({ onSaveEmailAccount })
      const user = userEvent.setup()

      await user.type(getPasswordField(), "new-app-password{Enter}")
      await waitForMicrotasks()

      expect(onSaveEmailAccount).toHaveBeenCalledOnce()
      expect(getPasswordField()).toHaveValue("new-app-password")
    }
  )

  it("keeps an edit made while the save ran", async () => {
    const save = createControlledPromise<EmailAccountSaveOutcome>()
    const onSaveEmailAccount = vi.fn(() => save.promise)
    startEmailAccountCard({ onSaveEmailAccount })
    const user = userEvent.setup()

    await user.type(getPasswordField(), "new-app-password{Enter}")
    await user.type(getField("Display name"), " Lovelace")
    save.resolve("saved")
    await waitForMicrotasks()

    expect(onSaveEmailAccount).toHaveBeenCalledOnce()
    expect(getField("Display name")).toHaveValue("Ada Fixture Lovelace")
    expect(getSaveButton()).toBeEnabled()
  })

  it.each<[string, Partial<EmailAccountCardProps>, string]>([
    ["Lys signs in", { checkState: { status: "checking" } }, "Signing in…"],
    ["the account is written", { saveState: { status: "saving" } }, "Saving…"]
  ])(
    "disables the fields and the actions while %s, and says so",
    async (_label, props, text) => {
      const { requests } = startEmailAccountCard(props)
      const user = userEvent.setup()

      await user.type(getPasswordField(), "new-app-password{Enter}")

      expect(getPasswordField()).toBeDisabled()
      expect(getPasswordField()).toHaveValue("")
      const sentCopy = screen.getByRole("switch", {
        name: "Server keeps a copy of sent mail"
      })
      expect(sentCopy).toHaveAttribute("aria-disabled", "true")
      expect(sentCopy).toHaveAttribute("tabindex", "-1")
      expect(getSaveButton()).toBeDisabled()
      expect(
        within(getCard()).getByRole("button", { name: "Remove account" })
      ).toBeDisabled()
      expect(getStatusLine()).toHaveTextContent(text)
      expect(requests.onSaveEmailAccount).not.toHaveBeenCalled()
    }
  )

  it("discards the edit on Escape", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()

    await user.type(getField("Display name"), " Lovelace")
    await user.type(getPasswordField(), "new-app-password")
    await user.keyboard("{Escape}")

    expect(getField("Display name")).toHaveValue("Ada Fixture")
    expect(getPasswordField()).toHaveValue("")
    expect(getSaveButton()).toBeDisabled()
    expect(getStatusLine()).toHaveTextContent("Saved · ada@fastmail.com")
  })

  it("keeps the edit on an Escape that ends text composition", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()

    await user.clear(getField("Display name"))
    await user.type(getField("Display name"), "エイダ")
    const isNotPrevented = fireEvent.keyDown(getField("Display name"), {
      key: "Escape",
      isComposing: true
    })

    expect(isNotPrevented).toBe(true)
    expect(getField("Display name")).toHaveValue("エイダ")
    expect(getSaveButton()).toBeEnabled()
  })

  it.each<[string, () => HTMLElement, string]>([
    ["the address", () => getField("Address"), "ada@fastmail.com"],
    ["the display name", () => getField("Display name"), "Ada Fixture"],
    ["the user name", () => getField("User name"), "ada@fastmail.com"],
    ["the password", getPasswordField, ""],
    [
      "the IMAP host",
      () => getServerField("IMAP server", "Host"),
      "imap.fastmail.com"
    ],
    ["the IMAP port", () => getServerField("IMAP server", "Port"), "993"],
    [
      "the SMTP host",
      () => getServerField("SMTP server", "Host"),
      "smtp.fastmail.com"
    ],
    ["the SMTP port", () => getServerField("SMTP server", "Port"), "465"]
  ])(
    "discards the edit on Escape in %s",
    async (_label, getInput, savedText) => {
      startEmailAccountCard()
      const user = userEvent.setup()

      await user.type(getInput(), "7")
      const isNotPrevented = fireEvent.keyDown(getInput(), { key: "Escape" })

      expect(isNotPrevented).toBe(false)
      expect(getInput()).toHaveValue(savedText)
      expect(getSaveButton()).toBeDisabled()
    }
  )

  it("leaves Escape its native action while nothing is edited", () => {
    startEmailAccountCard()

    const isNotPrevented = fireEvent.keyDown(getField("Display name"), {
      key: "Escape"
    })

    expect(isNotPrevented).toBe(true)
    expect(getField("Display name")).toHaveValue("Ada Fixture")
    expect(getSaveButton()).toBeDisabled()
  })

  it("changes how a server is reached with its security choices, and proposes nothing when the chosen way is pressed again", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()

    await user.click(getSecurityChoice("IMAP server", "STARTTLS"))

    expect(getSecurityChoice("IMAP server", "STARTTLS")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(getSecurityChoice("IMAP server", "TLS")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(getSecurityChoice("SMTP server", "TLS")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(getSaveButton()).toBeEnabled()

    await user.click(getSecurityChoice("IMAP server", "STARTTLS"))

    expect(getSecurityChoice("IMAP server", "STARTTLS")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("places the rule about connections without TLS on the host, after Save", async () => {
    const { requests } = startEmailAccountCard()
    const user = userEvent.setup()

    await user.click(getSecurityChoice("SMTP server", "None"))
    await user.click(getSaveButton())

    expect(getServerField("SMTP server", "Host")).toHaveAccessibleDescription(
      "A connection without TLS is allowed only to localhost, 127.0.0.1, or [::1]."
    )
    expect(getServerField("SMTP server", "Host")).toHaveFocus()
    expect(requests.onSaveEmailAccount).not.toHaveBeenCalled()
  })

  it("lets the person say whether the server keeps a copy of sent mail", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()
    const sentCopy = screen.getByRole("switch", {
      name: "Server keeps a copy of sent mail"
    })

    expect(sentCopy).toHaveAccessibleDescription(
      "Gmail and Yahoo file sent mail themselves. Off makes Lys file the copy in Sent."
    )
    await user.click(sentCopy)

    expect(sentCopy).not.toBeChecked()
    expect(getSaveButton()).toBeEnabled()
  })

  it("asks before removing, starting on Keep, and keeps the account on Escape or Keep", async () => {
    const { requests } = startEmailAccountCard()
    const user = userEvent.setup()

    await user.click(
      within(getCard()).getByRole("button", { name: "Remove account" })
    )

    const question = within(getCard()).getByRole("group", {
      name: "Remove the email account and its password? The email server is switched off."
    })
    expect(
      within(question).getByRole("button", { name: "Keep the email account" })
    ).toHaveFocus()
    expect(
      within(getCard()).queryByRole("button", { name: "Remove account" })
    ).toBeNull()

    await user.keyboard("{Escape}")

    expect(question).not.toBeInTheDocument()
    expect(
      within(getCard()).getByRole("button", { name: "Remove account" })
    ).toHaveFocus()
    expect(getField("Display name")).toHaveValue("Ada Fixture")

    await user.click(
      within(getCard()).getByRole("button", { name: "Remove account" })
    )
    await user.click(
      within(getCard()).getByRole("button", { name: "Keep the email account" })
    )

    expect(
      within(getCard()).getByRole("button", { name: "Remove account" })
    ).toHaveFocus()
    expect(requests.onRemoveEmailAccount).not.toHaveBeenCalled()
  })

  it("leaves focus where it is when Remove account returns after an edit was discarded", async () => {
    startEmailAccountCard()
    const user = userEvent.setup()
    await user.click(
      within(getCard()).getByRole("button", { name: "Remove account" })
    )
    await user.keyboard("{Escape}")

    await user.type(getField("Display name"), " Lovelace")
    await user.keyboard("{Escape}")

    expect(getField("Display name")).toHaveFocus()
    expect(
      within(getCard()).getByRole("button", { name: "Remove account" })
    ).toBeEnabled()
  })

  it("removes the account once confirmed, then moves focus to the address", async () => {
    const removal = createControlledPromise<EmailAccountRemovalOutcome>()
    const onRemoveEmailAccount = vi.fn(() => removal.promise)
    const { rendered } = startEmailAccountCard({ onRemoveEmailAccount })
    const user = userEvent.setup()

    await user.click(
      within(getCard()).getByRole("button", { name: "Remove account" })
    )
    await user.click(
      within(getCard()).getByRole("button", {
        name: "Remove the email account"
      })
    )
    // The store drops the account before it answers the removal.
    rendered.rerender(
      <EmailAccountCard
        checkState={{ status: "idle" }}
        isBackendRunning
        onRemoveEmailAccount={onRemoveEmailAccount}
        onSaveEmailAccount={vi.fn()}
        savedAccount={null}
        savedPassword={null}
        saveState={{ status: "saved" }}
      />
    )
    removal.resolve("saved")
    await waitForMicrotasks()

    expect(onRemoveEmailAccount).toHaveBeenCalledOnce()
    expect(getField("Address")).toHaveValue("")
    expect(getField("Address")).toHaveFocus()
    expect(getStatusLine()).toHaveTextContent(
      "No account yet. The email server stays off until you save one."
    )
  })

  it("closes the question and moves focus back to Remove account when the removal fails", async () => {
    startEmailAccountCard({
      onRemoveEmailAccount: vi.fn(() =>
        Promise.resolve<EmailAccountRemovalOutcome>("failed")
      )
    })
    const user = userEvent.setup()

    await user.click(
      within(getCard()).getByRole("button", { name: "Remove account" })
    )
    await user.click(
      within(getCard()).getByRole("button", {
        name: "Remove the email account"
      })
    )
    await waitForMicrotasks()

    expect(
      within(getCard()).getByRole("button", { name: "Remove account" })
    ).toHaveFocus()
    expect(getField("Address")).toHaveValue("ada@fastmail.com")
  })

  it("shows the account as saved once the parent reports the save", () => {
    startEmailAccountCard({
      saveState: { status: "saved" },
      checkState: {
        status: "checked",
        outcome: {
          status: "checked",
          imap: { status: "accepted" },
          smtp: { status: "accepted" }
        }
      }
    })

    expect(getStatusLine()).toHaveTextContent("Account saved.")
    expect(getStatusLine()).toHaveAttribute("data-tone", "success")
  })

  it("says which server refused the sign-in after a tried save, until the fields change", async () => {
    const onSaveEmailAccount = vi.fn(() =>
      Promise.resolve<EmailAccountSaveOutcome>("refused")
    )
    const { rendered, requests } = startEmailAccountCard({ onSaveEmailAccount })
    const user = userEvent.setup()

    await user.type(getPasswordField(), "wrong{Enter}")
    await waitForMicrotasks()
    rendered.rerender(
      <EmailAccountCard
        checkState={{
          status: "checked",
          outcome: {
            status: "checked",
            imap: { status: "failed", reason: "wrong-password" },
            smtp: { status: "accepted" }
          }
        }}
        isBackendRunning
        onRemoveEmailAccount={requests.onRemoveEmailAccount}
        onSaveEmailAccount={onSaveEmailAccount}
        savedAccount={STORED_EMAIL_ACCOUNT}
        savedPassword={STORED_EMAIL_PASSWORD}
        saveState={{ status: "idle" }}
      />
    )

    expect(getStatusLine()).toHaveTextContent(
      "IMAP: the user name or password was refused · SMTP: accepted"
    )
    expect(getStatusLine()).toHaveAttribute("data-tone", "danger")

    await user.type(getPasswordField(), "er")

    expect(getStatusLine()).toHaveTextContent(
      "Unsaved · Save signs in to both servers first."
    )
  })
})
