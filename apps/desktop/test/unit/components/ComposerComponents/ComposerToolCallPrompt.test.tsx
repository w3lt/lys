import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import type { HeldToolCall } from "@/lib/store/tool-calls"
import {
  FIXTURE_BACKEND_URL,
  startBackendFake
} from "../../support/backendFake"
import {
  buildConversation,
  buildStreamingAssistantMessage,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import { startNativeHostFake } from "../../support/nativeHostFake"
import { waitForRenderedWork } from "../../support/rendering"
import { buildToolCall, buildToolDefinition } from "../../support/toolFixtures"

/** Reply of the shown conversation that makes the calls. */
const REPLY = buildStreamingAssistantMessage(3, "")

/** Shown conversation: one turn whose reply still generates. */
const SHOWN_CONVERSATION = createStoredChatViewConversation(
  buildConversation(FIXTURE_CONVERSATION_ID, null, [
    buildUserMessage(2, "Read my notes"),
    REPLY
  ])
)

/** First call of {@link REPLY}. */
const FIRST_CALL = buildToolCall(10, "read_text_file")

/** Second call of {@link REPLY}, for another file. */
const SECOND_CALL = buildToolCall(11, "read_text_file", {
  path: "/notes/done.md"
})

/** Call of a reply in a conversation that is not shown. */
const OTHER_CONVERSATION_CALL = buildToolCall(12, "read_text_file", {
  path: "/notes/elsewhere.md"
})

/**
 * Builds a held read that waits for the person.
 *
 * @param call - Call the backend sent.
 * @param conversationId - Conversation whose reply made the call.
 * @returns The held call, with the input the call's `path` argument gives.
 */
function buildWaitingRead(
  call: typeof FIRST_CALL,
  conversationId: string = FIXTURE_CONVERSATION_ID
): HeldToolCall {
  return {
    target: { conversationId, assistantMessageId: REPLY.id, callId: call.id },
    call,
    step: "approval",
    answer: {
      status: "awaiting-person",
      definition: buildToolDefinition("read_text_file"),
      input: {
        runner: "client",
        toolName: "read_text_file",
        input: { path: String(call.arguments.path) }
      }
    }
  }
}

/** Route key of the tool-result endpoint for {@link FIRST_CALL}. */
const FIRST_RESULT_ROUTE = `POST /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY.id}/tool-results/${FIRST_CALL.id}`

/** Route key of the tool-approval endpoint for {@link FIRST_CALL}. */
const FIRST_APPROVAL_ROUTE = `POST /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY.id}/tool-approvals/${FIRST_CALL.id}`

/**
 * Loads fresh application, chat-view, and tool-call stores with the prompt
 * that reads them: the fixture conversation is shown with an empty draft,
 * and the tool-call store holds the given calls.
 *
 * @param heldCalls - Calls the tool-call store holds, in arrival order.
 * @returns The chat-view and tool-call store hooks and the component.
 */
async function loadFreshToolCallPrompt(heldCalls: readonly HeldToolCall[]) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useToolCallStore } = await import("@/lib/store/tool-calls")
  const { default: ComposerToolCallPrompt } =
    await import("@/components/ComposerComponents/ComposerToolCallPrompt")
  useLysStore.setState({ backendUrl: FIXTURE_BACKEND_URL })
  useChatViewStore.setState({ conversation: SHOWN_CONVERSATION })
  useToolCallStore.setState({ heldCalls })
  return { useChatViewStore, useToolCallStore, ComposerToolCallPrompt }
}

describe("ComposerToolCallPrompt", () => {
  it("keeps an empty status line and shows no card while no call needs the person", async () => {
    const { ComposerToolCallPrompt } = await loadFreshToolCallPrompt([])

    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={vi.fn()}
      />
    )

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.queryByRole("group")).not.toBeInTheDocument()
  })

  it("shows the first call of the shown conversation that waits, and announces it under the agent's name", async () => {
    const { ComposerToolCallPrompt } = await loadFreshToolCallPrompt([
      buildWaitingRead(OTHER_CONVERSATION_CALL, createFixtureUuidV7(90)),
      buildWaitingRead(FIRST_CALL),
      buildWaitingRead(SECOND_CALL)
    ])

    render(
      <ComposerToolCallPrompt agentName="Poet" onRejectToolCall={vi.fn()} />
    )

    expect(
      screen.getByRole("group", { name: "Tool call waiting for your answer" })
    ).toHaveTextContent("Read /notes/todo.md. Nothing is changed.")
    expect(screen.getByRole("status")).toHaveTextContent(
      "Poet is waiting for you to allow or reject read_text_file: Read /notes/todo.md. Nothing is changed."
    )
  })

  it("shows nothing for a call of a conversation that is not shown", async () => {
    const { ComposerToolCallPrompt } = await loadFreshToolCallPrompt([
      buildWaitingRead(OTHER_CONVERSATION_CALL, createFixtureUuidV7(90))
    ])

    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={vi.fn()}
      />
    )

    expect(screen.queryByRole("group")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toBeEmptyDOMElement()
  })

  it("sends the person's allowing answer, running nothing itself, then shows the next call that waits", async () => {
    const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
    const backend = startBackendFake({
      [FIRST_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
    })
    const { ComposerToolCallPrompt } = await loadFreshToolCallPrompt([
      buildWaitingRead(FIRST_CALL),
      buildWaitingRead(SECOND_CALL)
    ])
    const user = userEvent.setup()
    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={vi.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: "Allow once" }))
    await waitForRenderedWork()

    expect(host.commands).toEqual([])
    expect(backend.requests.map((request) => request.body)).toEqual([
      { status: "allowed" }
    ])
    expect(screen.getByRole("group")).toHaveTextContent(
      "Read /notes/done.md. Nothing is changed."
    )
    expect(screen.getByRole("status")).toHaveTextContent(/\/notes\/done\.md/)
  })

  it("hands a rejection to the parent with the call it rejects, and answers nothing itself", async () => {
    startNativeHostFake({})
    const backend = startBackendFake({})
    const onRejectToolCall = vi.fn()
    const { ComposerToolCallPrompt } = await loadFreshToolCallPrompt([
      buildWaitingRead(FIRST_CALL)
    ])
    const user = userEvent.setup()
    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={onRejectToolCall}
      />
    )

    await user.click(screen.getByRole("button", { name: "Reject" }))
    await waitForRenderedWork()

    expect(onRejectToolCall.mock.calls).toEqual([[FIRST_CALL.id]])
    expect(backend.requests).toEqual([])
    expect(screen.getByRole("group")).toBeInTheDocument()
  })

  it("offers Allow anyway while the chat view's draft holds text, and Allow once while it is blank", async () => {
    const { useChatViewStore, ComposerToolCallPrompt } =
      await loadFreshToolCallPrompt([buildWaitingRead(FIRST_CALL)])
    useChatViewStore.setState({ inputDraft: "  \n" })
    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={vi.fn()}
      />
    )
    const allowWithBlankDraft = screen.getByRole("button", {
      name: /^Allow/
    }).textContent

    act(() => useChatViewStore.setState({ inputDraft: "not that file" }))

    expect(allowWithBlankDraft).toMatch(/^Allow once/)
    expect(
      screen.getByRole("button", { name: "Allow anyway" })
    ).toBeInTheDocument()
  })

  it("sends an unsent answer again on Try again, without running the tool again", async () => {
    startNativeHostFake({})
    const backend = startBackendFake({
      [FIRST_RESULT_ROUTE]: () => new Response(null, { status: 204 })
    })
    const unsentAnswer = { status: "succeeded", content: "Buy milk." } as const
    const { ComposerToolCallPrompt } = await loadFreshToolCallPrompt([
      {
        target: buildWaitingRead(FIRST_CALL).target,
        call: FIRST_CALL,
        step: "run",
        answer: {
          status: "send-failed",
          toolAnswer: unsentAnswer,
          error: "Couldn't send the answer to Lys."
        }
      }
    ])
    const user = userEvent.setup()
    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={vi.fn()}
      />
    )
    const statusWhileUnsent = screen.getByRole("status").textContent

    await user.click(screen.getByRole("button", { name: "Try again" }))
    await waitForRenderedWork()

    expect(statusWhileUnsent).toBe("")
    expect(backend.requests.map((request) => request.body)).toEqual([
      unsentAnswer
    ])
    expect(screen.queryByRole("group")).not.toBeInTheDocument()
  })

  it("starts each call's card with its arguments hidden", async () => {
    const { useToolCallStore, ComposerToolCallPrompt } =
      await loadFreshToolCallPrompt([buildWaitingRead(FIRST_CALL)])
    const user = userEvent.setup()
    render(
      <ComposerToolCallPrompt
        agentName="Caliginia"
        onRejectToolCall={vi.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "Arguments" }))
    const expandedForFirstCall = screen
      .getByRole("button", { name: "Arguments" })
      .getAttribute("aria-expanded")

    act(() =>
      useToolCallStore.setState({ heldCalls: [buildWaitingRead(SECOND_CALL)] })
    )

    expect(expandedForFirstCall).toBe("true")
    expect(screen.getByRole("button", { name: "Arguments" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    expect(screen.getByRole("group")).toHaveTextContent("/notes/done.md")
  })
})
