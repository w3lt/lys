import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerAgentMenu from "@/components/ComposerComponents/ComposerAgentMenu"
import type {
  AgentChoice,
  ConversationAgent
} from "@/lib/store/agents/conversation-agent"
import {
  openMenuWithKeyboard,
  waitForRenderedWork
} from "../../support/rendering"

/** Built-in agent as the composer lists it. */
const CALIGINIA: AgentChoice = Object.freeze({
  code: "caliginia",
  name: "Caliginia",
  bio: "Plain answers.",
  kind: "built-in"
})

/** Second built-in agent, not selected in the choice cases. */
const LYSIPTERA: AgentChoice = Object.freeze({
  code: "lysiptera",
  name: "Lysiptera",
  bio: "Long-form writing.",
  kind: "built-in"
})

/** Agent of the user's own, selected in the choice cases. */
const POET: AgentChoice = Object.freeze({
  code: "poet",
  name: "Poet",
  bio: "Answers in verse.",
  kind: "custom"
})

/** Another agent of the user's own. */
const CRITIC: AgentChoice = Object.freeze({
  code: "critic",
  name: "Critic",
  bio: "Finds the flaw.",
  kind: "custom"
})

/** Choices of a displayed list: the built-in agents, then the user's own. */
const CHOICES = Object.freeze([CALIGINIA, LYSIPTERA, POET, CRITIC])

/** The selected agent, listed. */
const LISTED_POET: ConversationAgent = Object.freeze({
  status: "listed",
  agent: POET
})

/**
 * Renders the agent menu.
 *
 * @param props - Answering agent, whether a conversation is shown, and the
 * choices; the callbacks default to recorders.
 * @returns The recorders of the three callbacks.
 */
function startAgentMenu(
  props: Pick<
    ComponentProps<typeof ComposerAgentMenu>,
    "agent" | "isConversationStarted" | "choices"
  >
) {
  const callbacks = {
    onSelectAgent: vi.fn(),
    onOpenAgentSettings: vi.fn(),
    onStartConversation: vi.fn()
  }
  render(<ComposerAgentMenu {...props} {...callbacks} />)
  return callbacks
}

describe("ComposerAgentMenu", () => {
  describe("before a conversation starts", () => {
    it("names its button after the answering agent and says pressing it chooses who answers", () => {
      startAgentMenu({
        agent: LISTED_POET,
        isConversationStarted: false,
        choices: CHOICES
      })

      const trigger = screen.getByRole("button", { name: "Poet" })
      expect(trigger).toHaveAttribute("title", "Choose who answers")
      expect(trigger).toHaveAttribute("aria-haspopup", "menu")
    })

    it("lists every agent with its bio and condition in words, checking the selected one", async () => {
      const user = userEvent.setup()
      startAgentMenu({
        agent: LISTED_POET,
        isConversationStarted: false,
        choices: CHOICES
      })

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "Poet" })
      )

      const options = screen.getAllByRole("menuitemradio")
      expect(options.map((option) => option.textContent)).toEqual([
        "CCaliginiaPlain answers.built-in",
        "LLysipteraLong-form writing.built-in",
        "PPoetAnswers in verse.selected",
        "CCriticFinds the flaw."
      ])
      expect(
        options.map((option) => option.getAttribute("aria-checked"))
      ).toEqual(["false", "false", "true", "false"])
      expect(screen.getByText("fixed once you send")).toBeInTheDocument()
    })

    it("chooses the agent the user picks and closes", async () => {
      const user = userEvent.setup()
      const callbacks = startAgentMenu({
        agent: LISTED_POET,
        isConversationStarted: false,
        choices: CHOICES
      })
      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "Poet" })
      )

      await user.click(screen.getByRole("menuitemradio", { name: /Lysiptera/ }))

      expect(callbacks.onSelectAgent).toHaveBeenCalledOnce()
      expect(callbacks.onSelectAgent.mock.calls[0]?.[0]).toBe("lysiptera")
      await waitFor(() => {
        expect(screen.queryByRole("menu")).not.toBeInTheDocument()
      })
    })

    it("asks the parent for the Agents settings from Edit agents", async () => {
      const user = userEvent.setup()
      const callbacks = startAgentMenu({
        agent: LISTED_POET,
        isConversationStarted: false,
        choices: CHOICES
      })
      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "Poet" })
      )

      await user.click(screen.getByRole("menuitem", { name: /Edit agents/ }))

      expect(callbacks.onOpenAgentSettings).toHaveBeenCalledOnce()
      expect(callbacks.onSelectAgent).not.toHaveBeenCalled()
    })

    it("says that no agent was read, and still offers the Agents settings, without choices", async () => {
      const user = userEvent.setup()
      startAgentMenu({
        agent: { status: "unread", code: "caliginia" },
        isConversationStarted: false,
        choices: []
      })

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "caliginia" })
      )

      expect(
        screen.getByText("No agents read · open Agents")
      ).toBeInTheDocument()
      expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument()
      expect(
        screen.getByRole("menuitem", { name: /Edit agents/ })
      ).toBeInTheDocument()
    })
  })

  describe("once a conversation is shown", () => {
    it("says its agent is fixed, explains why, and offers no other agent", async () => {
      const user = userEvent.setup()
      startAgentMenu({
        agent: LISTED_POET,
        isConversationStarted: true,
        choices: CHOICES
      })
      const trigger = screen.getByRole("button", { name: "Poet" })

      await openMenuWithKeyboard(user, trigger)

      const menu = screen.getByRole("menu")
      expect(trigger).toHaveAttribute(
        "title",
        "Poet is fixed for this conversation"
      )
      expect(within(menu).getByText("Poet")).toBeInTheDocument()
      expect(within(menu).getByText("Answers in verse.")).toBeInTheDocument()
      expect(
        within(menu).getByText(/stays for the whole conversation/)
      ).toBeInTheDocument()
      expect(within(menu).queryByRole("menuitemradio")).not.toBeInTheDocument()
      expect(
        within(menu).queryByRole("menuitem", { name: /Edit agents/ })
      ).not.toBeInTheDocument()
    })

    it("names a deleted agent by its code and says it can no longer answer", async () => {
      const user = userEvent.setup()
      startAgentMenu({
        agent: { status: "deleted", code: "historian" },
        isConversationStarted: true,
        choices: CHOICES
      })

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "historian" })
      )

      const menu = screen.getByRole("menu")
      expect(within(menu).getByText("historian")).toBeInTheDocument()
      expect(within(menu).getByText("Deleted since.")).toBeInTheDocument()
      expect(
        within(menu).getByText(/It can no longer answer here/)
      ).toBeInTheDocument()
    })

    it("asks the parent for a new conversation and stays open, so its agent can be chosen at once", async () => {
      const user = userEvent.setup()
      const callbacks = startAgentMenu({
        agent: LISTED_POET,
        isConversationStarted: true,
        choices: CHOICES
      })
      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "Poet" })
      )

      await user.click(
        screen.getByRole("menuitem", { name: "Start a new one" })
      )
      await waitForRenderedWork()

      expect(callbacks.onStartConversation).toHaveBeenCalledOnce()
      expect(screen.getByRole("menu")).toBeInTheDocument()
    })
  })
})
