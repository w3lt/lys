import { useState } from "react"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  AgentListStatus,
  CustomAgentSection,
  type AgentListFocusTarget
} from "@/components/SettingsViewComponents/AgentList"
import { buildAgent, buildAgentSummary } from "../../support/agentFixtures"

/** Listed agents, oldest first. */
const AGENTS = [
  buildAgentSummary(
    buildAgent("researcher", { name: "Researcher", bio: "Finds sources." })
  ),
  buildAgentSummary(
    buildAgent("writer", { name: "Writer", bio: "Drafts prose." })
  )
]

/**
 * Renders the section of the user's agents with spies for both actions.
 *
 * @param options - Agents, saved marker, and focus target the case varies.
 * @returns The action spies.
 */
function renderAgentSection(
  options: {
    readonly agents?: typeof AGENTS
    readonly savedAgentCode?: string | null
    readonly focusTarget?: AgentListFocusTarget
  } = {}
) {
  const onOpenAgent = vi.fn()
  const onOpenNewAgent = vi.fn()
  render(
    <CustomAgentSection
      agents={options.agents ?? AGENTS}
      focusTarget={options.focusTarget ?? { kind: "none" }}
      onOpenAgent={onOpenAgent}
      onOpenNewAgent={onOpenNewAgent}
      savedAgentCode={options.savedAgentCode ?? null}
    />
  )
  return { onOpenAgent, onOpenNewAgent }
}

describe("CustomAgentSection", () => {
  it("lists the agents in order, each named by name and code and described by its bio", () => {
    renderAgentSection()

    const section = screen.getByRole("region", { name: "yours" })
    expect(section).toHaveTextContent("2 saved · deletable")
    const rows = within(
      within(section).getByRole("list", { name: "Your agents" })
    ).getAllByRole("button")
    expect(rows.map((row) => row.textContent)).toEqual([
      "ResearcherresearcherFinds sources.",
      "WriterwriterDrafts prose."
    ])
    expect(rows[0]).toHaveAccessibleName("Researcher researcher")
    expect(rows[0]).toHaveAccessibleDescription("Finds sources.")
  })

  it("marks the agent saved most recently in its description", () => {
    renderAgentSection({ savedAgentCode: "writer" })

    expect(
      screen.getByRole("button", { name: "Writer writer" })
    ).toHaveAccessibleDescription("Drafts prose. saved")
    expect(
      screen.getByRole("button", { name: "Researcher researcher" })
    ).toHaveAccessibleDescription("Finds sources.")
  })

  it("opens the pressed agent and starts a new one", async () => {
    const { onOpenAgent, onOpenNewAgent } = renderAgentSection()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Writer writer" }))
    await user.click(screen.getByRole("button", { name: "New agent" }))

    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith("writer")
    expect(onOpenNewAgent).toHaveBeenCalledOnce()
  })

  it("says there are none yet instead of an empty list", () => {
    renderAgentSection({ agents: [] })

    expect(
      screen.getByText("None of your own yet. Start one with New agent.")
    ).toBeInTheDocument()
    expect(screen.queryByRole("list")).toBeNull()
    expect(screen.getByRole("region", { name: "yours" })).toHaveTextContent(
      /^yoursdeletable/
    )
  })

  it.each<[AgentListFocusTarget, string]>([
    [{ kind: "agent", agentCode: "writer" }, "Writer writer"],
    [{ kind: "new-agent" }, "New agent"]
  ])("focuses the target %o when it appears", (focusTarget, focusedName) => {
    renderAgentSection({ focusTarget })

    expect(screen.getByRole("button", { name: focusedName })).toHaveFocus()
  })

  it("leaves focus alone without a target", () => {
    renderAgentSection()

    expect(document.body).toHaveFocus()
  })
})

/**
 * Renders the status beside a button the case can remove, as the pane
 * removes the list or editor that held focus.
 *
 * @param onRetryAgents - Retry the status offers, if any.
 * @returns A function that removes the focused button and shows a message.
 */
function renderStatusBesideRemovableControl(onRetryAgents?: () => void) {
  let showFailure: () => void = () => undefined

  /**
   * Shows the status and a control until a failure replaces the control.
   *
   * @returns The status and, before the failure, the control.
   */
  function PaneWithStatus() {
    const [message, setMessage] = useState("")
    showFailure = () => setMessage("Lys couldn't read the agents.")
    return (
      <>
        <AgentListStatus message={message} onRetryAgents={onRetryAgents} />
        {message === "" ? <button type="button">Agent row</button> : null}
      </>
    )
  }

  render(<PaneWithStatus />)
  return () => {
    act(() => {
      showFailure()
    })
  }
}

describe("AgentListStatus", () => {
  it("keeps an empty polite status while the agents can be shown", () => {
    render(<AgentListStatus message="" />)

    const status = screen.getByRole("status")
    expect(status).toBeEmptyDOMElement()
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("moves focus to Retry when a failure replaces the focused control", () => {
    const showFailure = renderStatusBesideRemovableControl(vi.fn())
    screen.getByRole("button", { name: "Agent row" }).focus()

    showFailure()

    expect(screen.getByRole("status")).toHaveTextContent(
      "Lys couldn't read the agents."
    )
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus()
  })

  it("moves focus to the message when no retry is offered", () => {
    const showFailure = renderStatusBesideRemovableControl()
    screen.getByRole("button", { name: "Agent row" }).focus()

    showFailure()

    expect(screen.getByRole("status")).toHaveFocus()
  })

  it("leaves focus on a control that is still shown", () => {
    const { rerender } = render(
      <>
        <AgentListStatus message="" />
        <button type="button">Elsewhere</button>
      </>
    )
    screen.getByRole("button", { name: "Elsewhere" }).focus()

    rerender(
      <>
        <AgentListStatus message="Start the backend to manage agents." />
        <button type="button">Elsewhere</button>
      </>
    )

    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus()
  })

  it("retries on request, keeping focus in the status while Retry leaves", async () => {
    const onRetryAgents = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentListStatus
        message="Lys couldn't read the agents."
        onRetryAgents={onRetryAgents}
      />
    )

    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(onRetryAgents).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveFocus()
  })
})
