import type { ComponentProps } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ToolCallsCard } from "@/components/SettingsViewComponents/ToolCallsCard"
import type { ToolCallsSummary } from "@/components/SettingsViewComponents/tool-presentation"

/** Two tools offered to a model trained for tools. */
const OFFERING: ToolCallsSummary = {
  areToolCallsOn: true,
  support: { status: "trained", modelKey: "qwen3-8b" },
  offeredToolCount: 2,
  offeredTokenCount: 216
}

/**
 * Renders the card with spies for both proposals.
 *
 * @param props - Card facts the case varies.
 * @returns The proposal spies.
 */
function startToolCallsCard(
  props: Partial<ComponentProps<typeof ToolCallsCard>> = {}
) {
  const proposals = {
    onAreToolCallsOnChange: vi.fn(),
    onCallsPerReplyChange: vi.fn()
  }
  render(
    <ToolCallsCard
      callsPerReply={8}
      isLocked={false}
      summary={OFFERING}
      {...proposals}
      {...props}
    />
  )
  return proposals
}

/**
 * Gets the calls-per-reply choices.
 *
 * @returns The labelled group of choices.
 */
function getCallsPerReplyGroup(): HTMLElement {
  return screen.getByRole("group", { name: "Calls per reply" })
}

describe("ToolCallsCard", () => {
  it("names the switch Tool calls and describes it with what agents are offered", () => {
    startToolCallsCard()

    expect(
      screen.getByRole("region", { name: "Tool calls on" })
    ).toBeInTheDocument()
    const toolCalls = screen.getByRole("switch", { name: "Tool calls" })
    expect(toolCalls).toBeChecked()
    expect(toolCalls).toHaveAccessibleDescription(
      "qwen3-8b · 2 offered · ~216 tok per request"
    )
  })

  it("names the card after the switch when tool calls are off", () => {
    startToolCallsCard({ summary: { ...OFFERING, areToolCallsOn: false } })

    expect(
      screen.getByRole("region", { name: "Tool calls off" })
    ).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Tool calls" })).not.toBeChecked()
  })

  it("proposes switching tool calls off", async () => {
    const { onAreToolCallsOnChange } = startToolCallsCard()
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Tool calls" }))

    expect(onAreToolCallsOnChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("offers 4, 8, or 16 calls per reply, pressing the current number", () => {
    startToolCallsCard({ callsPerReply: 16 })

    const group = getCallsPerReplyGroup()
    expect(group).toHaveAccessibleDescription(
      "How many tools she may call before she has to answer. Stops a loop from running on."
    )
    expect(
      within(group)
        .getAllByRole("button")
        .map((choice) => [
          choice.textContent,
          choice.getAttribute("aria-pressed")
        ])
    ).toEqual([
      ["4", "false"],
      ["8", "false"],
      ["16", "true"]
    ])
  })

  it("proposes another number, and nothing when the current one is pressed again", async () => {
    const { onCallsPerReplyChange } = startToolCallsCard()
    const user = userEvent.setup()
    const group = getCallsPerReplyGroup()

    await user.click(within(group).getByRole("button", { name: "8" }))
    await user.click(within(group).getByRole("button", { name: "4" }))

    expect(onCallsPerReplyChange).toHaveBeenCalledExactlyOnceWith(4)
  })

  it("keeps calls per reply operable while tool calls are off", async () => {
    const { onCallsPerReplyChange } = startToolCallsCard({
      summary: { ...OFFERING, areToolCallsOn: false }
    })
    const user = userEvent.setup()

    await user.click(
      within(getCallsPerReplyGroup()).getByRole("button", { name: "16" })
    )

    expect(onCallsPerReplyChange).toHaveBeenCalledExactlyOnceWith(16)
  })

  it("disables both controls while locked", async () => {
    const proposals = startToolCallsCard({
      isLocked: true,
      summary: {
        ...OFFERING,
        support: { status: "untrained", modelKey: "gemma-3" }
      }
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Tool calls" }))
    await user.click(
      within(getCallsPerReplyGroup()).getByRole("button", { name: "4" })
    )

    expect(screen.getByRole("switch", { name: "Tool calls" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(proposals.onAreToolCallsOnChange).not.toHaveBeenCalled()
    expect(proposals.onCallsPerReplyChange).not.toHaveBeenCalled()
  })
})
