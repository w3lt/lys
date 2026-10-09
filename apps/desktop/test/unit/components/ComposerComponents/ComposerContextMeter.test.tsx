import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerContextMeter from "@/components/ComposerComponents/ComposerContextMeter"
import {
  calculateContextUsage,
  type ComposerAttachment
} from "@/components/ComposerComponents/composer-context"

/**
 * Builds turns whose text estimates to the given token counts.
 *
 * @param lengths - Text lengths, oldest first; 37 characters estimate to 10
 * tokens.
 * @returns The turns.
 */
function buildTurns(...lengths: number[]) {
  return lengths.map((length, index) => ({
    id: `turn-${index}`,
    text: "x".repeat(length)
  }))
}

/**
 * Builds one staged attachment.
 *
 * @param name - File name.
 * @param estimatedTokens - Estimated tokens it occupies.
 * @returns The attachment.
 */
function buildAttachment(
  name: string,
  estimatedTokens: number
): ComposerAttachment {
  return { id: `attachment-${name}`, name, kind: "txt", estimatedTokens }
}

/** A window that still fits a two-turn conversation (126 of 8,192 tokens). */
const FITTING_USAGE = calculateContextUsage({
  budget: 8192,
  reserve: 1024,
  turns: buildTurns(37, 74),
  attachments: []
})

/** A window whose oldest turn no longer fits (944 of 1,000 tokens). */
const COMPACTED_USAGE = calculateContextUsage({
  budget: 1000,
  reserve: 0,
  turns: buildTurns(740, 1110, 1850),
  attachments: []
})

/** Attachments that overflow the window by 196 tokens. */
const OVERFLOW_ATTACHMENTS = [
  buildAttachment("small.txt", 100),
  buildAttachment("large.txt", 800)
]

/** A window the staged attachments overflow. */
const OVERFLOW_USAGE = calculateContextUsage({
  budget: 1000,
  reserve: 200,
  turns: [],
  attachments: OVERFLOW_ATTACHMENTS
})

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
    render(
      <ComposerContextMeter
        attachments={[]}
        onChangeWindow={vi.fn()}
        usage={FITTING_USAGE}
      />
    )

    const trigger = screen.getByRole("button", {
      name: "Context window · 126 / 8.2k"
    })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("window")).not.toBeInTheDocument()
  })

  it("breaks a fitting window down into estimates", async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        attachments={[]}
        onChangeWindow={vi.fn()}
        usage={FITTING_USAGE}
      />
    )

    const { trigger, panel } = await openMeterPanel(user)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(panel).toHaveTextContent("8.2k tokens")
    expect(listBreakdownRows(panel)).toEqual([
      "Backend preamble: ~96",
      "Attached files: none",
      "2 turns in the window: ~30",
      "Room left: ~7.0k",
      "Reserved for the reply: ~1.0k"
    ])
  })

  it("counts one kept turn in the singular", async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        attachments={[]}
        onChangeWindow={vi.fn()}
        usage={calculateContextUsage({
          budget: 8192,
          reserve: 0,
          turns: buildTurns(37),
          attachments: []
        })}
      />
    )

    const { panel } = await openMeterPanel(user)

    expect(listBreakdownRows(panel)).toContain("1 turn in the window: ~10")
  })

  it("names the overflow and the largest attachment causing it", async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        attachments={OVERFLOW_ATTACHMENTS}
        largestAttachment={OVERFLOW_ATTACHMENTS[1]}
        onChangeWindow={vi.fn()}
        usage={OVERFLOW_USAGE}
      />
    )

    const { trigger, panel } = await openMeterPanel(user)

    expect(trigger).toHaveAccessibleName("Context window · over by ~196")
    expect(listBreakdownRows(panel)).toEqual([
      "Backend preamble: ~96",
      "Attached files: ~900",
      "0 turns in the window: ~0",
      "Over the window: ~196",
      "Reserved for the reply: ~200"
    ])
    expect(panel).toHaveTextContent(
      "“large.txt” is ~800 on its own — remove it, or raise the window past 1.2k."
    )
  })

  it("asks to remove an attachment or raise the window when no attachment is named", async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        attachments={OVERFLOW_ATTACHMENTS}
        onChangeWindow={vi.fn()}
        usage={OVERFLOW_USAGE}
      />
    )

    const { panel } = await openMeterPanel(user)

    expect(panel).toHaveTextContent("Remove an attachment or raise the window.")
  })

  // Known defect, tracked by #29: the meter promises that the oldest turns
  // will be compacted into a recap, which Lys does not do.
  it.fails(
    "describes a fitting window without promising compaction (#29)",
    async () => {
      const user = userEvent.setup()
      render(
        <ComposerContextMeter
          attachments={[]}
          onChangeWindow={vi.fn()}
          usage={FITTING_USAGE}
        />
      )

      const { panel } = await openMeterPanel(user)

      expect(panel).not.toHaveTextContent(/compact|recap/i)
    }
  )

  // Known defect, tracked by #29: the meter says turns were compacted into a
  // recap that is sent in their place; no recap is made or sent.
  it.fails(
    "describes turns beyond the window without claiming a recap is sent (#29)",
    async () => {
      const user = userEvent.setup()
      render(
        <ComposerContextMeter
          attachments={[]}
          onChangeWindow={vi.fn()}
          usage={COMPACTED_USAGE}
        />
      )

      const { trigger, panel } = await openMeterPanel(user)

      expect(trigger).not.toHaveAccessibleName(/compact/i)
      expect(panel).not.toHaveTextContent(/compact|recap/i)
    }
  )

  it("asks to change the window once per press", async () => {
    const onChangeWindow = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        attachments={[]}
        onChangeWindow={onChangeWindow}
        usage={FITTING_USAGE}
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
        attachments={[]}
        onChangeWindow={vi.fn()}
        usage={FITTING_USAGE}
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
          attachments={[]}
          onChangeWindow={vi.fn()}
          usage={FITTING_USAGE}
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
          attachments={[]}
          onChangeWindow={vi.fn()}
          usage={FITTING_USAGE}
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
        attachments={[]}
        onChangeWindow={vi.fn()}
        usage={FITTING_USAGE}
      />
    )
    const { trigger } = await openMeterPanel(user)

    await user.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
})
