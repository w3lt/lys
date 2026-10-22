import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerContextMeter from "@/components/ComposerComponents/ComposerContextMeter"
import {
  buildContextMeterState,
  type ContextMeterState
} from "@/components/ComposerComponents/composer-context"

/**
 * Statements that turns were, are, or will be compacted into a recap sent in
 * their place: the claims #29 removes.
 *
 * @remarks The oracle is the claim, not the words: corrected copy may still
 * say that no recap is made or that older turns are left out.
 */
const COMPACTION_CLAIM =
  /compacted into a recap|sent in their place|(?:are|were|will be) compacted|\d+ compacted/i

/** Measurement of a conversation with four earlier messages and tools. */
const MEASUREMENT = Object.freeze({
  contextLength: 8192,
  systemPromptTokens: 2260,
  toolTokens: 410,
  historyTokens: 1000,
  historyMessageCount: 4,
  messageMarkupTokens: 8
})

/**
 * A window that fits: 3,688 measured and estimated tokens and a 1,024-token
 * reserve of 8,192; the 37-character draft estimates to 10 tokens, plus 8 for
 * the markup around it.
 */
const FITTING_METER = buildContextMeterState(
  { status: "measured", measurement: MEASUREMENT },
  { draft: "x".repeat(37), attachmentTokens: 0, reserve: 1024 }
)

/** A window the conversation and the reserve overflow by 512 tokens. */
const OVERFLOWING_METER = buildContextMeterState(
  {
    status: "measured",
    measurement: { ...MEASUREMENT, historyTokens: 4992 }
  },
  { draft: "x".repeat(37), attachmentTokens: 0, reserve: 1024 }
)

/**
 * Renders the meter on its own.
 *
 * @param meter - What is known about the window.
 * @param hasAttachedTextFiles - Whether text files are attached; none by
 * default.
 */
function renderMeter(
  meter: ContextMeterState,
  hasAttachedTextFiles = false
): void {
  render(
    <ComposerContextMeter
      hasAttachedTextFiles={hasAttachedTextFiles}
      meter={meter}
      onChangeWindow={vi.fn()}
    />
  )
}

/**
 * Opens the meter's panel by pressing its trigger.
 *
 * @param user - User-event session of the case.
 * @returns The trigger and the panel it controls.
 */
async function openMeterPanel(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: /^Context window · / })
  await user.click(trigger)
  const panelId = trigger.getAttribute("aria-controls") ?? ""
  const panel = document.getElementById(panelId)
  if (panel === null) throw new Error("The meter panel is not shown")
  return { trigger, panel }
}

/**
 * Lists the breakdown rows of an open panel.
 *
 * @param panel - Open meter panel.
 * @returns Each row as `label: value`.
 */
function listBreakdownRows(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByRole("term")
    .map(
      (term) =>
        `${term.textContent}: ${term.nextElementSibling?.textContent ?? ""}`
    )
}

describe("ComposerContextMeter", () => {
  it("names the window's use and keeps its panel closed until asked", () => {
    renderMeter(FITTING_METER)

    const trigger = screen.getByRole("button", {
      name: "Context window · 3.7k / 8.2k"
    })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("window")).not.toBeInTheDocument()
  })

  it("breaks a measured window down in send order, with the window the model is loaded with", async () => {
    const user = userEvent.setup()
    renderMeter(FITTING_METER)

    const { trigger, panel } = await openMeterPanel(user)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(panel).toHaveTextContent("8.2k tokens")
    expect(listBreakdownRows(panel)).toEqual([
      "Agent instructions: ~2.3k",
      "Tool definitions: ~410",
      "4 earlier messages: ~1.0k",
      "Your message: ~18",
      "Room left: ~3.5k",
      "Reserved for the reply: ~1.0k"
    ])
    expect(panel).toHaveTextContent(
      "Counted with the model's tokenizer; your message is estimated. Lys sends every earlier message with each new one and never shortens them."
    )
  })

  it("shows no tools and no earlier messages for a new conversation without tools", async () => {
    const user = userEvent.setup()
    renderMeter(
      buildContextMeterState(
        {
          status: "measured",
          measurement: {
            ...MEASUREMENT,
            toolTokens: 0,
            historyTokens: 0,
            historyMessageCount: 0
          }
        },
        { draft: "", attachmentTokens: 0, reserve: 0 }
      )
    )

    const { panel } = await openMeterPanel(user)

    expect(listBreakdownRows(panel)).toEqual([
      "Agent instructions: ~2.3k",
      "Tool definitions: none",
      "Earlier messages: none",
      "Your message: ~8",
      "Room left: ~5.9k",
      "Reserved for the reply: ~0"
    ])
  })

  it("counts one earlier message in the singular", async () => {
    const user = userEvent.setup()
    renderMeter(
      buildContextMeterState(
        {
          status: "measured",
          measurement: { ...MEASUREMENT, historyMessageCount: 1 }
        },
        { draft: "", attachmentTokens: 0, reserve: 0 }
      )
    )

    const { panel } = await openMeterPanel(user)

    expect(listBreakdownRows(panel)).toContain("1 earlier message: ~1.0k")
  })

  it("names the overflow and what to do about it", async () => {
    const user = userEvent.setup()
    renderMeter(OVERFLOWING_METER)

    const { trigger, panel } = await openMeterPanel(user)

    expect(trigger).toHaveAccessibleName("Context window · over by ~512")
    expect(listBreakdownRows(panel)).toContain("Over the window: ~512")
    expect(panel).toHaveTextContent(
      "This message would not fit. Lys sends every earlier message with each new one and never shortens them, so start a new conversation, shorten your message, or load the model with a longer context."
    )
  })

  it.each([
    ["a window that fits", FITTING_METER],
    ["a window that overflows", OVERFLOWING_METER]
  ])(
    "describes %s without claiming or promising compaction (#29)",
    async (_scenario, meter) => {
      const user = userEvent.setup()
      renderMeter(meter)

      const { trigger, panel } = await openMeterPanel(user)

      expect(trigger).not.toHaveAccessibleName(COMPACTION_CLAIM)
      expect(panel).not.toHaveTextContent(COMPACTION_CLAIM)
    }
  )

  it("says attached files are read on request while text files are attached", async () => {
    const user = userEvent.setup()
    renderMeter(FITTING_METER, true)

    const { panel } = await openMeterPanel(user)

    expect(panel).toHaveTextContent(
      "Attached files are read on request, so they are not counted."
    )
  })

  it("names the bar's striped part while the reply reserve takes room", async () => {
    const user = userEvent.setup()
    renderMeter(FITTING_METER)

    const { panel } = await openMeterPanel(user)

    expect(panel).toHaveTextContent(
      "The striped part of the bar is held back for the reply."
    )
  })

  it.each([
    [
      "no reply reserve is set",
      buildContextMeterState(
        { status: "measured", measurement: MEASUREMENT },
        { draft: "", attachmentTokens: 0, reserve: 0 }
      )
    ],
    [
      "the request alone fills the window",
      buildContextMeterState(
        {
          status: "measured",
          measurement: { ...MEASUREMENT, historyTokens: 8000 }
        },
        { draft: "", attachmentTokens: 0, reserve: 1024 }
      )
    ]
  ])("names no striped part when %s", async (_scenario, meter) => {
    const user = userEvent.setup()
    renderMeter(meter)

    const { panel } = await openMeterPanel(user)

    expect(panel).not.toHaveTextContent(/striped part/)
  })

  it("says it is measuring before the first measurement settles", async () => {
    const user = userEvent.setup()
    renderMeter({ status: "measuring" })

    const { panel } = await openMeterPanel(user)

    expect(
      screen.getByRole("button", { name: "Context window · measuring…" })
    ).toBeInTheDocument()
    expect(within(panel).queryAllByRole("term")).toEqual([])
    expect(panel).toHaveTextContent(
      "Measuring what your next message would be sent with."
    )
  })

  it("says why the window is unknown and that sending still checks it", async () => {
    const user = userEvent.setup()
    renderMeter({
      status: "unknown",
      reason: "The backend could not be reached."
    })

    const { panel } = await openMeterPanel(user)

    expect(
      screen.getByRole("button", { name: "Context window · window unknown" })
    ).toBeInTheDocument()
    expect(panel).toHaveTextContent(
      "The backend could not be reached. Sending still checks that the conversation fits the model."
    )
  })

  it("asks to change the window once per press", async () => {
    const onChangeWindow = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        hasAttachedTextFiles={false}
        meter={FITTING_METER}
        onChangeWindow={onChangeWindow}
      />
    )
    await openMeterPanel(user)

    await user.click(screen.getByRole("button", { name: "Change the window" }))

    expect(onChangeWindow).toHaveBeenCalledOnce()
  })

  it("closes on Escape and returns focus to its trigger", async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        hasAttachedTextFiles={false}
        meter={FITTING_METER}
        onChangeWindow={vi.fn()}
      />
    )
    const { trigger } = await openMeterPanel(user)
    screen.getByRole("button", { name: "Change the window" }).focus()

    await user.keyboard("{Escape}")

    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(trigger).toHaveFocus()
    expect(
      screen.queryByRole("button", { name: "Change the window" })
    ).not.toBeInTheDocument()
  })

  it("closes on a press outside it but not on a press inside", async () => {
    const user = userEvent.setup()
    render(
      <>
        <ComposerContextMeter
          hasAttachedTextFiles={false}
          meter={FITTING_METER}
          onChangeWindow={vi.fn()}
        />
        <p>Elsewhere</p>
      </>
    )
    const { trigger, panel } = await openMeterPanel(user)

    fireEvent.pointerDown(panel)
    expect(trigger).toHaveAttribute("aria-expanded", "true")

    fireEvent.pointerDown(screen.getByText("Elsewhere"))
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })

  it("stops listening for Escape once its panel is closed", async () => {
    const user = userEvent.setup()
    render(
      <>
        <ComposerContextMeter
          hasAttachedTextFiles={false}
          meter={FITTING_METER}
          onChangeWindow={vi.fn()}
        />
        <button type="button">Elsewhere</button>
      </>
    )
    const { trigger } = await openMeterPanel(user)
    await user.click(trigger)
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" })
    elsewhere.focus()

    await user.keyboard("{Escape}")

    expect(elsewhere).toHaveFocus()
  })

  it("closes when its trigger is pressed again", async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        hasAttachedTextFiles={false}
        meter={FITTING_METER}
        onChangeWindow={vi.fn()}
      />
    )
    const { trigger } = await openMeterPanel(user)

    await user.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
})
