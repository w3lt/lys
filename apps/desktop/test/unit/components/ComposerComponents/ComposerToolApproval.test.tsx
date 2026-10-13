import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerToolApproval from "@/components/ComposerComponents/ComposerToolApproval"
import type { ShownToolCall } from "@/lib/store/tool-calls"
import {
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import {
  buildBackendToolDefinition,
  buildToolCall,
  buildToolDefinition
} from "../../support/toolFixtures"

/** Search the model asked for; the card lists its arguments in this order. */
const SEARCH_CALL = buildToolCall(10, "search_files", {
  root: "/Users/fixture/project",
  query: "TODO",
  target: "content",
  maxResults: 20
})

/** Call to the backend's page reader. */
const PAGE_CALL = buildToolCall(11, "read_page", {
  url: "https://example.com/docs"
})

/**
 * Builds the address of one call's answer in the fixture conversation.
 *
 * @param callId - Identifier of the call.
 * @returns The address.
 */
function buildCallTarget(callId: string): ShownToolCall["target"] {
  return {
    conversationId: FIXTURE_CONVERSATION_ID,
    assistantMessageId: createFixtureUuidV7(3),
    callId
  }
}

/** Search that waits for the person. */
const WAITING_SEARCH: ShownToolCall = Object.freeze({
  target: buildCallTarget(SEARCH_CALL.id),
  call: SEARCH_CALL,
  answer: {
    status: "awaiting-person",
    definition: buildToolDefinition("search_files"),
    input: {
      runner: "client",
      toolName: "search_files",
      filter: {
        root: "/Users/fixture/project",
        query: "TODO",
        target: "content",
        maxResults: 20
      }
    }
  }
})

/** Page read that waits for the person. */
const WAITING_PAGE_READ: ShownToolCall = Object.freeze({
  target: buildCallTarget(PAGE_CALL.id),
  call: PAGE_CALL,
  answer: {
    status: "awaiting-person",
    definition: buildBackendToolDefinition("read_page"),
    input: {
      runner: "backend",
      toolName: "read_page",
      url: "https://example.com/docs",
      host: "example.com"
    }
  }
})

/** Search whose result could not be sent to the backend. */
const UNSENT_SEARCH: ShownToolCall = Object.freeze({
  target: buildCallTarget(SEARCH_CALL.id),
  call: SEARCH_CALL,
  answer: {
    status: "send-failed",
    toolAnswer: { status: "succeeded", content: "{}" },
    error: "Couldn't send the answer to Lys: The backend could not be reached."
  }
})

/**
 * Renders the card for one shown call.
 *
 * @param props - Shown call and whether the composer holds a draft; the
 * answers default to recorders.
 * @returns The recorders of the three answers.
 */
function startToolApproval(
  props: Pick<
    ComponentProps<typeof ComposerToolApproval>,
    "toolCall" | "hasDraft"
  >
) {
  const answers = {
    onAllowToolCall: vi.fn(),
    onRejectToolCall: vi.fn(),
    onRetryToolResult: vi.fn()
  }
  render(<ComposerToolApproval {...props} {...answers} />)
  return answers
}

describe("ComposerToolApproval", () => {
  describe("a call that waits for the person", () => {
    it("says which desktop tool was called, what it does with the machine, and what this call will do", () => {
      startToolApproval({ toolCall: WAITING_SEARCH, hasDraft: false })

      const card = screen.getByRole("group", {
        name: "Tool call waiting for your answer"
      })
      expect(within(card).getByText("search_files")).toBeInTheDocument()
      expect(within(card).getByText("reads")).toBeInTheDocument()
      expect(within(card).getByText("in Lys")).toHaveAttribute(
        "title",
        "Runs inside the Lys app"
      )
      expect(
        within(card).getByText(
          "Search file contents under /Users/fixture/project for “TODO”. Nothing is changed."
        )
      ).toBeInTheDocument()
    })

    it("says that a backend tool sends a request, and to which host", () => {
      startToolApproval({ toolCall: WAITING_PAGE_READ, hasDraft: false })

      const card = screen.getByRole("group", {
        name: "Tool call waiting for your answer"
      })
      expect(within(card).getByText("network")).toBeInTheDocument()
      expect(within(card).getByText("in backend")).toHaveAttribute(
        "title",
        "Runs in Lys’s backend"
      )
      expect(
        within(card).getByText(
          "Read https://example.com/docs. Sends a request to example.com."
        )
      ).toBeInTheDocument()
    })

    it("keeps the arguments hidden until asked, then lists each by name in the call's order", async () => {
      const user = userEvent.setup()
      startToolApproval({ toolCall: WAITING_SEARCH, hasDraft: false })
      const toggle = screen.getByRole("button", { name: "Arguments" })
      const whileHidden = {
        isExpanded: toggle.getAttribute("aria-expanded"),
        terms: screen.queryAllByRole("term").length
      }

      await user.click(toggle)

      expect(whileHidden).toEqual({ isExpanded: "false", terms: 0 })
      expect(toggle).toHaveAttribute("aria-expanded", "true")
      expect(
        screen.getAllByRole("term").map((term) => term.textContent)
      ).toEqual(["root", "query", "target", "maxResults"])
      expect(
        screen
          .getAllByRole("definition")
          .map((definition) => definition.textContent)
      ).toEqual(["/Users/fixture/project", "TODO", "content", "20"])
      expect(toggle.getAttribute("aria-controls")).toBe(
        screen.getAllByRole("term")[0]?.closest("dl")?.id
      )
    })

    it("hides the arguments again on a second press", async () => {
      const user = userEvent.setup()
      startToolApproval({ toolCall: WAITING_SEARCH, hasDraft: false })
      const toggle = screen.getByRole("button", { name: "Arguments" })

      await user.click(toggle)
      await user.click(toggle)

      expect(toggle).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByRole("term")).not.toBeInTheDocument()
    })

    it("offers Allow once on Enter and Reject on Escape while the composer is empty", async () => {
      const user = userEvent.setup()
      const answers = startToolApproval({
        toolCall: WAITING_SEARCH,
        hasDraft: false
      })
      const allow = screen.getByRole("button", { name: "Allow once" })
      const reject = screen.getByRole("button", { name: "Reject" })

      await user.click(allow)
      await user.click(reject)

      expect(allow).toHaveAttribute("aria-keyshortcuts", "Enter")
      expect(reject).toHaveAttribute("aria-keyshortcuts", "Escape")
      expect(
        screen.getByText("Or type below to say no, with a reason")
      ).toBeInTheDocument()
      expect(answers.onAllowToolCall).toHaveBeenCalledOnce()
      expect(answers.onRejectToolCall).toHaveBeenCalledOnce()
      expect(answers.onRetryToolResult).not.toHaveBeenCalled()
    })

    it("offers Allow anyway, without the Enter shortcut, while the composer holds a draft that Enter would send as the answer", async () => {
      const user = userEvent.setup()
      const answers = startToolApproval({
        toolCall: WAITING_SEARCH,
        hasDraft: true
      })
      const allow = screen.getByRole("button", { name: "Allow anyway" })

      await user.click(allow)

      expect(allow).not.toHaveAttribute("aria-keyshortcuts")
      expect(
        screen.queryByRole("button", { name: "Allow once" })
      ).not.toBeInTheDocument()
      expect(
        screen.getByText("↵ sends your message as her answer")
      ).toBeInTheDocument()
      expect(answers.onAllowToolCall).toHaveBeenCalledOnce()
      expect(answers.onRejectToolCall).not.toHaveBeenCalled()
    })
  })

  describe("an answer that failed to send", () => {
    it("announces the reason as an alert and offers only to try again", async () => {
      const user = userEvent.setup()
      const answers = startToolApproval({
        toolCall: UNSENT_SEARCH,
        hasDraft: false
      })
      const card = screen.getByRole("group", { name: "Tool answer not sent" })

      await user.click(within(card).getByRole("button", { name: "Try again" }))

      expect(within(card).getByText("search_files")).toBeInTheDocument()
      expect(within(card).getByRole("alert")).toHaveTextContent(
        "Couldn't send the answer to Lys: The backend could not be reached."
      )
      expect(within(card).getAllByRole("button")).toHaveLength(1)
      expect(answers.onRetryToolResult).toHaveBeenCalledOnce()
      expect(answers.onAllowToolCall).not.toHaveBeenCalled()
      expect(answers.onRejectToolCall).not.toHaveBeenCalled()
    })
  })
})
