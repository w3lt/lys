import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MarkdownMessage } from "../components/MarkdownMessage"

const writeText = vi.fn()

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText }
})

afterEach(() => {
  writeText.mockReset()
  vi.useRealTimers()
})

describe("MarkdownMessage", () => {
  it("renders Markdown without rendering raw HTML", () => {
    render(
      <MarkdownMessage
        text={"**strong**\n\n<script>window.bad = true</script>"}
        streaming={false}
      />
    )

    expect(screen.getByText("strong").tagName).toBe("STRONG")
    expect(document.querySelector("script")).not.toBeInTheDocument()
    expect(screen.getByText(/<script>/)).toBeInTheDocument()
  })

  it("opens Markdown links in a separate, non-referring tab", () => {
    render(
      <MarkdownMessage text="[Lys](https://example.com)" streaming={false} />
    )

    const link = screen.getByRole("link", { name: "Lys" })
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer")
  })

  it("copies fenced code and reports copied feedback", async () => {
    writeText.mockResolvedValue(undefined)
    render(
      <MarkdownMessage
        text={"```ts\nconst answer = 42\n```"}
        streaming={false}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }))

    expect(writeText).toHaveBeenCalledWith("const answer = 42")
    expect(await screen.findByText("copied")).toBeInTheDocument()
  })

  it("keeps copied feedback scoped to the selected code block", async () => {
    writeText.mockResolvedValue(undefined)
    render(
      <MarkdownMessage
        text={"```ts\nconst first = 1\n```\n\n```ts\nconst second = 2\n```"}
        streaming={false}
      />
    )

    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[1])

    expect(await screen.findByText("copied")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1)
    expect(writeText).toHaveBeenCalledWith("const second = 2")
  })

  it("clears copied feedback after 1400 milliseconds", async () => {
    vi.useFakeTimers()
    writeText.mockResolvedValue(undefined)
    render(
      <MarkdownMessage
        text={"```ts\nconst answer = 42\n```"}
        streaming={false}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
    })
    expect(screen.getByText("copied")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1_400))

    expect(screen.queryByText("copied")).not.toBeInTheDocument()
  })

  it("shows a streaming caret for partial output", () => {
    render(<MarkdownMessage text="Partial" streaming />)

    expect(screen.getByTestId("streaming-caret")).toHaveAttribute(
      "aria-label",
      "Lys is generating"
    )
  })
})
