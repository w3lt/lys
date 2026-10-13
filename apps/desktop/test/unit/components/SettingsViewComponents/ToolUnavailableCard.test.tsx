import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ToolUnavailableCard } from "@/components/SettingsViewComponents/ToolUnavailableCard"

describe("ToolUnavailableCard", () => {
  it("explains, in a region named by its heading, that the loaded model is offered no tools", () => {
    render(<ToolUnavailableCard modelKey="gemma-3" />)

    const card = screen.getByRole("region", {
      name: "The current model isn't trained for tool calls"
    })
    expect(card).toHaveTextContent("tool calls unavailable")
    expect(card).toHaveTextContent(
      "gemma-3 wasn't trained to call tools, so Lys doesn't offer it any."
    )
    expect(screen.queryByRole("img")).toBeNull()
  })
})
