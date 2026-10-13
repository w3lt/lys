import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
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
 * Renders the card with a spy for its proposal.
 *
 * @param props - Card facts the case varies.
 * @returns The proposal spy.
 */
function startToolCallsCard(
  props: Partial<ComponentProps<typeof ToolCallsCard>> = {}
) {
  const proposals = { onAreToolCallsOnChange: vi.fn() }
  render(
    <ToolCallsCard
      isLocked={false}
      summary={OFFERING}
      {...proposals}
      {...props}
    />
  )
  return proposals
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

  it("disables the switch while locked", async () => {
    const proposals = startToolCallsCard({
      isLocked: true,
      summary: {
        ...OFFERING,
        support: { status: "untrained", modelKey: "gemma-3" }
      }
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("switch", { name: "Tool calls" }))

    expect(screen.getByRole("switch", { name: "Tool calls" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(proposals.onAreToolCallsOnChange).not.toHaveBeenCalled()
  })
})
