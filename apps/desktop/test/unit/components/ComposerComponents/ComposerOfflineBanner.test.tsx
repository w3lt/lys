import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerOfflineBanner from "@/components/ComposerComponents/ComposerOfflineBanner"

describe("ComposerOfflineBanner", () => {
  it("announces why generation is unavailable politely", () => {
    render(
      <ComposerOfflineBanner
        action={{ label: "Start backend", isEnabled: true }}
        message="The backend is not running on http://127.0.0.1:12345."
        onReconnect={vi.fn()}
      />
    )

    const banner = screen.getByRole("status")
    expect(banner).toHaveAttribute("aria-live", "polite")
    expect(banner).toHaveTextContent(
      "The backend is not running on http://127.0.0.1:12345."
    )
  })

  it("runs the recovery action once per press", async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerOfflineBanner
        action={{ label: "Start backend", isEnabled: true }}
        message="The backend is not running."
        onReconnect={onReconnect}
      />
    )

    await user.click(screen.getByRole("button", { name: "Start backend" }))

    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it("keeps a disabled action in place while the runtime is already changing", async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerOfflineBanner
        action={{ label: "Working", isEnabled: false }}
        message="Starting the backend…"
        onReconnect={onReconnect}
      />
    )

    const action = screen.getByRole("button", { name: "Working" })
    await user.click(action)

    expect(action).toBeDisabled()
    expect(onReconnect).not.toHaveBeenCalled()
  })
})
