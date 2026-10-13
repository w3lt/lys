import { createRef } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Slider } from "@/components/ui/slider"

/**
 * Lists the slider inputs rendered for the thumbs.
 *
 * @returns Every thumb's range input.
 * @remarks Base UI keeps a thumb hidden until it has measured the track,
 * which jsdom never lays out, so hidden inputs are included.
 */
function listThumbs(): HTMLElement[] {
  return screen.getAllByRole("slider", { hidden: true })
}

describe("Slider", () => {
  it("names its single thumb after the slider and forwards the description and value text", () => {
    render(
      <>
        <h2 id="ceiling-label">Ceiling</h2>
        <p id="ceiling-note">A hard stop.</p>
        <Slider
          aria-describedby="ceiling-note"
          aria-labelledby="ceiling-label"
          aria-valuetext="2048 tokens"
          max={4096}
          min={64}
          step={64}
          value={[2048]}
        />
      </>
    )

    const [thumb] = listThumbs()
    expect(listThumbs()).toHaveLength(1)
    expect(thumb).toHaveAttribute("aria-labelledby", "ceiling-label")
    expect(thumb).toHaveAttribute("aria-describedby", "ceiling-note")
    expect(thumb).toHaveAttribute("aria-valuetext", "2048 tokens")
    expect(thumb).toHaveValue("2048")
    expect(thumb).toHaveAttribute("min", "64")
    expect(thumb).toHaveAttribute("max", "4096")
  })

  it("renders one thumb per value, naming none of them after the whole slider", () => {
    render(<Slider aria-label="Range" defaultValue={[20, 80]} />)

    const thumbs = listThumbs()
    expect(thumbs.map((thumb) => thumb.getAttribute("value"))).toEqual([
      "20",
      "80"
    ])
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-label"))).toEqual([
      null,
      null
    ])
  })

  it("ranges from 0 to 100 by default", () => {
    render(<Slider aria-label="Level" value={[50]} />)

    const [thumb] = listThumbs()
    expect(thumb).toHaveAttribute("min", "0")
    expect(thumb).toHaveAttribute("max", "100")
  })

  it("proposes the next step from the keyboard", () => {
    const onValueChange = vi.fn()
    render(
      <Slider
        aria-label="Temperature"
        max={2}
        min={0}
        onValueChange={onValueChange}
        step={0.05}
        value={[0.7]}
      />
    )

    fireEvent.keyDown(listThumbs()[0], { key: "ArrowRight" })

    expect(onValueChange.mock.calls[0]?.[0]).toEqual([0.75])
  })

  it("attaches its ref to the slider root, not a thumb", () => {
    const ref = createRef<HTMLDivElement>()
    render(<Slider aria-label="Level" ref={ref} value={[50]} />)

    expect(ref.current).toContainElement(listThumbs()[0])
    expect(ref.current).not.toBe(listThumbs()[0])
  })
})
