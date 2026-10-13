import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TitleBar } from "@/components/TitleBar"

/** Local-storage key that holds the appearance preference. */
const THEME_STORAGE_KEY = "lys.theme"

/**
 * Reads whether the document is in its dark appearance.
 *
 * @returns Whether the root element carries the `dark` class.
 */
function isDocumentDark(): boolean {
  return document.documentElement.classList.contains("dark")
}

describe("TitleBar", () => {
  it("names the application in the window's drag region", () => {
    render(<TitleBar />)

    const titleBar = screen.getByRole("banner")
    expect(titleBar).toHaveTextContent("Lys")
    expect(titleBar).toHaveAttribute("data-tauri-drag-region")
  })

  it("starts dark without a stored preference and offers the light theme", () => {
    render(<TitleBar />)

    expect(
      screen.getByRole("button", { name: "Switch to light theme" })
    ).toBeInTheDocument()
    expect(isDocumentDark()).toBe(true)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
  })

  it("starts from a stored light preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light")

    render(<TitleBar />)

    expect(
      screen.getByRole("button", { name: "Switch to dark theme" })
    ).toBeInTheDocument()
    expect(isDocumentDark()).toBe(false)
  })

  it("starts dark when the stored preference is not a theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia")

    render(<TitleBar />)

    expect(isDocumentDark()).toBe(true)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
  })

  it("starts dark when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError")
    })

    render(<TitleBar />)

    expect(
      screen.getByRole("button", { name: "Switch to light theme" })
    ).toBeInTheDocument()
    expect(isDocumentDark()).toBe(true)
  })

  it("switches the theme once per press and remembers it", async () => {
    const user = userEvent.setup()
    render(<TitleBar />)

    await user.click(
      screen.getByRole("button", { name: "Switch to light theme" })
    )

    expect(isDocumentDark()).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")

    await user.click(
      screen.getByRole("button", { name: "Switch to dark theme" })
    )

    expect(isDocumentDark()).toBe(true)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
  })

  it("switches with the keyboard", async () => {
    const user = userEvent.setup()
    render(<TitleBar />)

    await user.tab()
    await user.keyboard("{Enter}")

    expect(
      screen.getByRole("button", { name: "Switch to dark theme" })
    ).toHaveFocus()
    expect(isDocumentDark()).toBe(false)
  })

  it("still changes the appearance when storage refuses the preference", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError")
    })
    const user = userEvent.setup()
    render(<TitleBar />)

    await user.click(
      screen.getByRole("button", { name: "Switch to light theme" })
    )

    expect(isDocumentDark()).toBe(false)
    expect(
      screen.getByRole("button", { name: "Switch to dark theme" })
    ).toBeInTheDocument()
  })
})
