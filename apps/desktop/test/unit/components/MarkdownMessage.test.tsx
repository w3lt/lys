import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { MarkdownMessage } from "@/components/MarkdownMessage"
import { waitForMicrotasks } from "../support/settlement"

/** Fenced TypeScript block whose copyable text is two lines. */
const TYPESCRIPT_BLOCK = "```ts\nconst a = 1\nconst b = 2\n```\n"

/**
 * Installs a clipboard on the navigator for one case.
 *
 * @param writeText - Clipboard write the case observes or fails.
 * @returns The write function the copy button calls.
 * @remarks jsdom has no clipboard, as a host that denies access has none
 * either; the property is removed when the case finishes.
 */
function installClipboard(
  writeText: (text: string) => Promise<void> = () => Promise.resolve()
) {
  const write = vi.fn(writeText)
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: write }
  })
  onTestFinished(() => {
    Reflect.deleteProperty(window.navigator, "clipboard")
  })
  return write
}

/**
 * Renders a message and waits until its highlighted code block is shown.
 *
 * @param text - Markdown containing one fenced code block.
 * @returns The copy button of that block and the tree's unmount function.
 */
async function renderCodeBlock(text: string) {
  const { unmount } = render(<MarkdownMessage streaming={false} text={text} />)
  const copyButton = await screen.findByRole("button", { name: "Copy code" })
  return { copyButton, unmount }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("MarkdownMessage", () => {
  it("renders Markdown structure", async () => {
    render(
      <MarkdownMessage
        streaming={false}
        text={"# Plan\n\n- one\n- **two**\n\nDone."}
      />
    )

    expect(
      await screen.findByRole("heading", { level: 1, name: "Plan" })
    ).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByText("two").tagName).toBe("STRONG")
    expect(screen.getByText("Done.")).toBeInTheDocument()
  })

  it("opens links in a new tab without sending the referrer", async () => {
    render(
      <MarkdownMessage
        streaming={false}
        text={'See [the docs](https://example.com/docs "Lys docs").'}
      />
    )

    // The first pass renders plain Markdown; links are handled once the
    // asynchronous pass resolves.
    await vi.waitFor(() => {
      expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
        "target",
        "_blank"
      )
    })
    const link = screen.getByRole("link", { name: "the docs" })

    expect(link).toHaveAttribute("href", "https://example.com/docs")
    expect(link).toHaveAttribute("rel", "noreferrer")
    expect(link).toHaveAttribute("title", "Lys docs")
    expect(link.getAttributeNames().sort()).toEqual([
      "href",
      "rel",
      "target",
      "title"
    ])
  })

  it("renders inline and display math", async () => {
    const { container } = render(
      <MarkdownMessage
        streaming={false}
        text={"Area $a^2$ and\n\n$$\nE = mc^2\n$$\n"}
      />
    )

    await vi.waitFor(() => {
      expect(container.querySelectorAll("math")).toHaveLength(2)
    })
    expect(container.querySelector("code")).toBeNull()
  })

  it("labels a code block with its language and copies its plain text", async () => {
    const writeText = installClipboard()
    const { copyButton } = await renderCodeBlock(TYPESCRIPT_BLOCK)

    expect(screen.getByText("Ts")).toBeInTheDocument()

    fireEvent.click(copyButton)
    await waitForMicrotasks()

    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "const a = 1\nconst b = 2"
    )
    expect(screen.getByRole("button", { name: "copied" })).toBe(copyButton)
  })

  it("labels a code block without a language as Text and copies it without the final newline", async () => {
    const writeText = installClipboard()
    const { copyButton } = await renderCodeBlock("```\nplain words\n```\n")

    expect(screen.getByText("Text")).toBeInTheDocument()
    expect(screen.getByText("plain words")).toBeInTheDocument()

    fireEvent.click(copyButton)
    await waitForMicrotasks()

    expect(writeText).toHaveBeenCalledExactlyOnceWith("plain words")
  })

  it("shows code in a language it cannot highlight as plain text", async () => {
    await renderCodeBlock("```notalanguage\nkeep me\n```\n")

    expect(screen.getByText("keep me")).toBeInTheDocument()
  })

  it("returns the copy label 1.4 seconds after the latest copy", async () => {
    installClipboard()
    const { copyButton } = await renderCodeBlock(TYPESCRIPT_BLOCK)
    vi.useFakeTimers()

    fireEvent.click(copyButton)
    await vi.advanceTimersByTimeAsync(1000)
    fireEvent.click(copyButton)
    await vi.advanceTimersByTimeAsync(1399)

    expect(copyButton).toHaveAccessibleName("copied")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(copyButton).toHaveAccessibleName("Copy code")
  })

  it("leaves no reset pending once the message is removed", async () => {
    installClipboard()
    const { copyButton, unmount } = await renderCodeBlock(TYPESCRIPT_BLOCK)
    vi.useFakeTimers()
    fireEvent.click(copyButton)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps the copy label when the clipboard refuses the write", async () => {
    const writeText = installClipboard(() =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"))
    )
    const { copyButton } = await renderCodeBlock(TYPESCRIPT_BLOCK)

    fireEvent.click(copyButton)
    await waitForMicrotasks()

    expect(writeText).toHaveBeenCalledOnce()
    expect(copyButton).toHaveAccessibleName("Copy code")
  })

  it("announces generation only while the reply streams", () => {
    const { rerender } = render(<MarkdownMessage streaming text="Partial" />)

    expect(
      screen.getByRole("status", { name: "Lys is generating" })
    ).toHaveAttribute("aria-live", "polite")

    rerender(<MarkdownMessage streaming={false} text="Partial answer" />)

    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows the newest text after an update", async () => {
    const { rerender } = render(<MarkdownMessage streaming text="First" />)
    await screen.findByText("First")

    rerender(<MarkdownMessage streaming text="First and second" />)

    expect(await screen.findByText("First and second")).toBeInTheDocument()
  })
})
