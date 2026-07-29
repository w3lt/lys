import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ChatView } from "../components/ChatView"

const callbacks = {
  onRetry: vi.fn(),
  onScrollPositionChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn()
}

describe("ChatView outcome announcements", () => {
  it("announces an inline error politely without alert semantics", () => {
    render(
      <ChatView
        {...callbacks}
        atBottom
        messages={[
          {
            id: "error-1",
            role: "error",
            title: "stream failed",
            text: "The connection dropped."
          }
        ]}
        streaming={false}
      />
    )

    const outcome = screen.getByRole("status")
    expect(outcome).toHaveAttribute("aria-live", "polite")
    expect(outcome).toHaveTextContent("stream failed")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("announces a stopped reply politely", () => {
    render(
      <ChatView
        {...callbacks}
        atBottom
        messages={[
          {
            id: "lys-1",
            role: "lys",
            text: "A partial answer.",
            status: "stopped"
          }
        ]}
        streaming={false}
      />
    )

    const outcome = screen.getByRole("status")
    expect(outcome).toHaveAttribute("aria-live", "polite")
    expect(outcome).toHaveTextContent("Stopped")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
