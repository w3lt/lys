import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { STARTER_PROMPTS } from "@/app/content"
import StarterView from "@/components/ChatViewComponents/StarterView"

describe("StarterView", () => {
  it("introduces Lys under a level-one heading", () => {
    render(<StarterView onSendStarterPrompt={vi.fn()} />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Lys" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "One model, one conversation at a time. The transcripts stay on this machine."
      )
    ).toBeInTheDocument()
  })

  it("groups every starter prompt as a button, in order", () => {
    render(<StarterView onSendStarterPrompt={vi.fn()} />)

    const group = screen.getByRole("group", { name: "Starter prompts" })
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual([...STARTER_PROMPTS])
  })

  it("sends the pressed prompt once", async () => {
    const onSendStarterPrompt = vi.fn()
    const user = userEvent.setup()
    render(<StarterView onSendStarterPrompt={onSendStarterPrompt} />)

    await user.click(screen.getByRole("button", { name: STARTER_PROMPTS[1] }))

    expect(onSendStarterPrompt).toHaveBeenCalledOnce()
    expect(onSendStarterPrompt).toHaveBeenCalledWith(STARTER_PROMPTS[1])
  })

  it("sends a prompt chosen with the keyboard", async () => {
    const onSendStarterPrompt = vi.fn()
    const user = userEvent.setup()
    render(<StarterView onSendStarterPrompt={onSendStarterPrompt} />)

    await user.tab()
    await user.keyboard("{Enter}")

    expect(onSendStarterPrompt).toHaveBeenCalledExactlyOnceWith(
      STARTER_PROMPTS[0]
    )
  })

  it("keeps the decorative portrait out of the accessibility tree", () => {
    render(<StarterView onSendStarterPrompt={vi.fn()} />)

    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })
})
