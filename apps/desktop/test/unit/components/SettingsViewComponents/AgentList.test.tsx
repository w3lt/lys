import { useState } from "react"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  AgentListStatus,
  BuiltInAgentSection,
  CustomAgentSection,
  type AgentListFocusTarget
} from "@/components/SettingsViewComponents/AgentList"
import {
  buildAgent,
  buildAgentSummary,
  buildBuiltInAgent,
  buildBuiltInAgentSummary
} from "../../support/agentFixtures"

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
function startAgentSection(
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
    startAgentSection()

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
    startAgentSection({ savedAgentCode: "writer" })

    expect(
      screen.getByRole("button", { name: "Writer writer" })
    ).toHaveAccessibleDescription("Drafts prose. saved")
    expect(
      screen.getByRole("button", { name: "Researcher researcher" })
    ).toHaveAccessibleDescription("Finds sources.")
  })

  it("opens the pressed agent and starts a new one", async () => {
    const { onOpenAgent, onOpenNewAgent } = startAgentSection()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Writer writer" }))
    await user.click(screen.getByRole("button", { name: "New agent" }))

    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith("writer")
    expect(onOpenNewAgent).toHaveBeenCalledOnce()
  })

  it("says there are none yet instead of an empty list", () => {
    startAgentSection({ agents: [] })

    expect(
      screen.getByText(
        "None of your own yet. Start blank, or duplicate a built-in and change what you need."
      )
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
    startAgentSection({ focusTarget })

    expect(screen.getByRole("button", { name: focusedName })).toHaveFocus()
  })

  it("leaves focus alone without a target", () => {
    startAgentSection()

    expect(document.body).toHaveFocus()
  })
})

/** Listed built-in agents, in shipped order. */
const BUILT_IN_AGENTS = [
  buildBuiltInAgentSummary(
    buildBuiltInAgent("caliginia", {
      name: "Caliginia",
      bio: "Lys's dark side."
    })
  ),
  buildBuiltInAgentSummary(
    buildBuiltInAgent("lysiptera", {
      name: "Lysiptera",
      bio: "Lys's light side."
    })
  )
]

/**
 * Renders the section of the built-in agents with a spy for opening one.
 *
 * @param focusTarget - Control that takes focus when the section appears.
 * @returns The open-agent spy.
 */
function startBuiltInAgentSection(
  focusTarget: AgentListFocusTarget = { kind: "none" }
) {
  const onOpenAgent = vi.fn()
  render(
    <BuiltInAgentSection
      agents={BUILT_IN_AGENTS}
      focusTarget={focusTarget}
      onOpenAgent={onOpenAgent}
    />
  )
  return onOpenAgent
}

describe("BuiltInAgentSection", () => {
  it("lists the agents in shipped order as not editable, each named by name and code and described by its bio", () => {
    startBuiltInAgentSection()

    const section = screen.getByRole("region", { name: "built-in" })
    expect(section).toHaveTextContent("ship with Lys · not editable")
    const rows = within(
      within(section).getByRole("list", { name: "Built-in agents" })
    ).getAllByRole("button")
    expect(rows.map((row) => row.textContent)).toEqual([
      "CaliginiacaliginiaLys's dark side.",
      "LysipteralysipteraLys's light side."
    ])
    expect(rows[1]).toHaveAccessibleName("Lysiptera lysiptera")
    expect(rows[1]).toHaveAccessibleDescription("Lys's light side.")
    expect(
      within(section).queryByRole("button", { name: "New agent" })
    ).toBeNull()
  })

  it("opens the pressed agent", async () => {
    const onOpenAgent = startBuiltInAgentSection()
    const user = userEvent.setup()

    await user.click(
      screen.getByRole("button", { name: "Lysiptera lysiptera" })
    )

    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith("lysiptera")
  })

  it("focuses its targeted agent's row when it appears", () => {
    startBuiltInAgentSection({ kind: "agent", agentCode: "lysiptera" })

    expect(
      screen.getByRole("button", { name: "Lysiptera lysiptera" })
    ).toHaveFocus()
  })

  it.each<AgentListFocusTarget>([
    { kind: "none" },
    { kind: "new-agent" },
    { kind: "agent", agentCode: "writer" }
  ])("leaves focus alone for the target %o it does not show", (target) => {
    startBuiltInAgentSection(target)

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
function startStatusBesideRemovableControl(onRetryAgents?: () => void) {
  let updateFailureMessage: () => void = () => undefined

  /**
   * Shows the status and a control until a failure replaces the control.
   *
   * @returns The status and, before the failure, the control.
   */
  function PaneWithStatus() {
    const [message, setMessage] = useState("")
    updateFailureMessage = () => setMessage("Lys couldn't read the agents.")
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
      updateFailureMessage()
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
    const updateFailureMessage = startStatusBesideRemovableControl(vi.fn())
    screen.getByRole("button", { name: "Agent row" }).focus()

    updateFailureMessage()

    expect(screen.getByRole("status")).toHaveTextContent(
      "Lys couldn't read the agents."
    )
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus()
  })

  it("moves focus to the message when no retry is offered", () => {
    const updateFailureMessage = startStatusBesideRemovableControl()
    screen.getByRole("button", { name: "Agent row" }).focus()

    updateFailureMessage()

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
