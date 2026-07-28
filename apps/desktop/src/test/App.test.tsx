import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import App from "../App"

const originalScrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo"
)

type TestUser = ReturnType<typeof userEvent.setup>

async function selectReferenceScenario(user: TestUser, name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "Reference states" }))
  act(() => vi.advanceTimersByTime(50))
  await user.click(await screen.findByRole("menuitem", { name }))
  act(() => vi.advanceTimersByTime(50))
}

describe("Lys chat", () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  )
  afterEach(() => {
    vi.useRealTimers()
    if (originalScrollToDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollTo",
        originalScrollToDescriptor
      )
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
    }
  })

  it("sends with Enter, streams a reply, and stops with partial text intact", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    const composer = screen.getByRole("textbox", { name: "Message Lys" })

    await user.type(composer, "What are you?{Enter}")
    expect(screen.getByText("What are you?")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(120))
    await user.click(screen.getByRole("button", { name: "Stop generating" }))

    expect(screen.getByText("Stopped")).toBeInTheDocument()
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()
  })

  it("keeps Shift+Enter as a newline", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    const composer = screen.getByRole("textbox", { name: "Message Lys" })

    await user.type(composer, "first{Shift>}{Enter}{/Shift}second")

    expect(composer).toHaveValue("first\nsecond")
    expect(screen.queryByText("you")).not.toBeInTheDocument()
  })

  it("new chat clears messages and keeps configuration", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(screen.getByRole("button", { name: "What are you?" }))
    act(() => vi.runAllTimers())

    await user.click(screen.getByRole("button", { name: "New conversation" }))

    expect(screen.getByText("Lysiptera Caliginia")).toBeInTheDocument()
    expect(screen.queryByText("What are you?")).toBeInTheDocument()
    expect(screen.queryByText("A voice running")).not.toBeInTheDocument()
  })

  it("retries the preserved draft from the inline-error scenario", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Reference states" }))
    act(() => vi.advanceTimersByTime(50))
    await user.click(
      await screen.findByRole("menuitem", { name: /Inline error/ })
    )
    act(() => vi.advanceTimersByTime(50))
    expect(screen.getByRole("textbox", { name: "Message Lys" })).toHaveValue(
      "Now trim the context window without lying to me about it."
    )

    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(screen.queryByText("stream failed")).not.toBeInTheDocument()
    expect(
      screen.getByText(
        "Now trim the context window without lying to me about it."
      )
    ).toBeInTheDocument()
  })

  it("jumps to the latest message from the jump scenario", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Reference states" }))
    act(() => vi.advanceTimersByTime(50))
    await user.click(
      await screen.findByRole("menuitem", { name: /Jump to latest/ })
    )
    act(() => vi.advanceTimersByTime(50))
    await user.click(screen.getByRole("button", { name: "Jump to latest" }))

    expect(scrollTo).toHaveBeenCalled()
    expect(
      screen.queryByRole("button", { name: "Jump to latest" })
    ).not.toBeInTheDocument()
  })

  it("keeps typing available while Send is locked during generation", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "What are you?" }))
    const composer = screen.getByRole("textbox", { name: "Message Lys" })
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    expect(composer).toBeEnabled()
    await user.type(composer, "Follow-up draft")
    expect(composer).toHaveValue("Follow-up draft")
  })

  it("shows Jump to latest when the reader scrolls away", () => {
    render(<App />)
    const transcript = screen.getByTestId("transcript")
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 600 },
    })

    fireEvent.scroll(transcript)

    expect(
      screen.getByRole("button", { name: "Jump to latest" })
    ).toBeInTheDocument()
  })

  it("navigates settings and updates generation controls", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Open model settings" }))
    expect(
      screen.getByRole("tablist", { name: "Settings sections" })
    ).toHaveAttribute("aria-orientation", "vertical")
    await user.click(screen.getByRole("tab", { name: "Generation" }))
    await user.click(screen.getByRole("button", { name: "16k" }))
    await user.click(screen.getByRole("switch", { name: "Stream tokens" }))

    expect(screen.getByRole("button", { name: "16k" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByRole("switch", { name: "Stream tokens" })).toHaveAttribute(
      "aria-checked",
      "false"
    )
  })

  it("starts the backend and loads a model deterministically", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    fireEvent.click(screen.getByRole("button", { name: "Reference states" }))
    act(() => vi.advanceTimersByTime(50))
    await user.click(
      await screen.findByRole("menuitem", { name: /Backend stopped/ })
    )
    await user.click(screen.getByRole("button", { name: "Open model settings" }))
    await user.click(screen.getByRole("button", { name: "Start backend" }))
    act(() => vi.advanceTimersByTime(1500))
    await user.click(screen.getByRole("button", { name: "Load model" }))
    act(() => vi.runAllTimers())

    expect(screen.getByText("Model loaded")).toBeInTheDocument()
  })

  it("updates model and conversation configuration in memory", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    await user.click(screen.getByRole("tab", { name: "Model" }))
    const endpoint = screen.getByRole("textbox", { name: "Server address" })
    await user.clear(endpoint)
    await user.type(endpoint, "127.0.0.1:4321")
    await user.click(screen.getByRole("button", { name: /phi-4-mini/ }))
    await user.click(screen.getByRole("button", { name: "Test connection" }))
    expect(endpoint).toHaveValue("127.0.0.1:4321")
    expect(screen.getByText(/probe ok/)).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Conversation" }))
    const dropOldest = screen.getByRole("button", {
      name: "Drop oldest turns"
    })
    const stopAndSaySo = screen.getByRole("button", {
      name: "Stop and say so"
    })
    dropOldest.focus()
    await user.keyboard("{ArrowDown}")
    expect(stopAndSaySo).toHaveFocus()
    await user.click(stopAndSaySo)
    const systemPrompt = screen.getByRole("textbox", { name: "System prompt" })
    await user.clear(systemPrompt)
    await user.type(systemPrompt, "Answer plainly.")
    expect(stopAndSaySo).toHaveAttribute("aria-pressed", "true")
    expect(systemPrompt).toHaveValue("Answer plainly.")
  })

  it("updates ranges, autostart, and runtime unload controls", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    const autostart = screen.getByRole("switch", {
      name: "Start it when Lys opens"
    })
    await user.click(autostart)
    expect(autostart).toHaveAttribute("aria-checked", "false")
    await user.click(screen.getByRole("button", { name: "Unload model" }))
    act(() => vi.advanceTimersByTime(700))
    expect(screen.getByText("No model loaded")).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Generation" }))
    fireEvent.change(screen.getByRole("slider", { name: "Temperature" }), {
      target: { value: "0.95" }
    })
    fireEvent.change(screen.getByRole("slider", { name: "Reply ceiling" }), {
      target: { value: "2048" }
    })
    expect(screen.getByText("0.95")).toBeInTheDocument()
    expect(screen.getByText("2048")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(
      screen.getByRole("textbox", { name: "Message Lys" })
    ).toBeInTheDocument()
  })

  it("stops active generation before unloading the model", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "What are you?" }))
    act(() => vi.advanceTimersByTime(60))
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open model settings" }))
    await user.click(screen.getByRole("button", { name: "Unload model" }))

    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(700))
    act(() => vi.runAllTimers())
    expect(screen.getByText("No model loaded")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText("Stopped")).toBeInTheDocument()
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing more/)).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops active generation before selecting replacement weights", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "What are you?" }))
    act(() => vi.advanceTimersByTime(60))
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open model settings" }))
    await user.click(screen.getByRole("tab", { name: "Model" }))
    await user.click(screen.getByRole("button", { name: /phi-4-mini/ }))

    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.runAllTimers())
    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText("Stopped")).toBeInTheDocument()
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing more/)).not.toBeInTheDocument()
  })

  it("keeps model unload disabled while the backend is stopping", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    await user.click(screen.getByRole("button", { name: "Stop backend" }))
    const unload = screen.getByRole("button", { name: "Unload model" })

    expect(unload).toBeDisabled()
    fireEvent.click(unload)
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(900))
    expect(screen.getByText("Backend stopped")).toBeInTheDocument()
    expect(screen.getByText("No model loaded")).toBeInTheDocument()
  })

  it("cancels active text work when a scenario replaces state", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "What are you?" }))
    act(() => vi.advanceTimersByTime(60))
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()

    await selectReferenceScenario(user, /^Empty/)

    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.runAllTimers())
    expect(screen.getAllByText("What are you?")).toHaveLength(1)
    expect(screen.queryByText(/A voice running/)).not.toBeInTheDocument()
  })

  it("cancels model loading when a different model is selected", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await selectReferenceScenario(user, /No model loaded/)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    await user.click(screen.getByRole("button", { name: "Load model" }))
    act(() => vi.advanceTimersByTime(220))
    expect(screen.getByText("20%")).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Model" }))
    await user.click(screen.getByRole("button", { name: /phi-4-mini/ }))

    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.runAllTimers())
    await user.click(screen.getByRole("tab", { name: "Runtime" }))
    expect(screen.getByText("No model loaded")).toBeInTheDocument()
    expect(screen.queryByText("Model loaded")).not.toBeInTheDocument()
    expect(
      screen.queryByText("qwen3-8b-instruct loaded")
    ).not.toBeInTheDocument()
  })

  it("stops active generation and releases the model with the backend", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "What are you?" }))
    act(() => vi.advanceTimersByTime(60))
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open model settings" }))
    await user.click(screen.getByRole("button", { name: "Stop backend" }))
    act(() => vi.advanceTimersByTime(900))
    act(() => vi.runAllTimers())

    expect(screen.getByText("Backend stopped")).toBeInTheDocument()
    expect(screen.getByText("No model loaded")).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)

    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText("Stopped")).toBeInTheDocument()
    expect(screen.getByText(/A voice running/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing more/)).not.toBeInTheDocument()
  })

  it("cancels model progress when the backend stops during loading", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await selectReferenceScenario(user, /No model loaded/)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    await user.click(screen.getByRole("button", { name: "Load model" }))
    act(() => vi.advanceTimersByTime(220))
    expect(screen.getByText("20%")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Stop backend" }))
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(440))
    expect(screen.getByText("20%")).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(460))
    act(() => vi.runAllTimers())

    expect(screen.getByText("Backend stopped")).toBeInTheDocument()
    expect(screen.getByText("No model loaded")).toBeInTheDocument()
    expect(screen.queryByText("Model loaded")).not.toBeInTheDocument()
    expect(
      screen.queryByText("qwen3-8b-instruct loaded")
    ).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears active text work on unmount", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { unmount } = render(<App />)

    await user.click(screen.getByRole("button", { name: "What are you?" }))
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.runAllTimers())
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears an active backend transition on unmount", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { unmount } = render(<App />)
    await selectReferenceScenario(user, /Backend stopped/)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    await user.click(screen.getByRole("button", { name: "Start backend" }))
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.runAllTimers())
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears active model loading on unmount", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { unmount } = render(<App />)
    await selectReferenceScenario(user, /No model loaded/)
    await user.click(screen.getByRole("button", { name: "Open model settings" }))

    await user.click(screen.getByRole("button", { name: "Load model" }))
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.runAllTimers())
    expect(vi.getTimerCount()).toBe(0)
  })
})
