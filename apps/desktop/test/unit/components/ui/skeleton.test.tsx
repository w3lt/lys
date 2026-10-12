import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Skeleton } from "@/components/ui/skeleton"

describe("Skeleton", () => {
  it("renders a placeholder that forwards its attributes and ref, adding no semantics", () => {
    const ref = createRef<HTMLDivElement>()
    const { container } = render(
      <Skeleton aria-hidden="true" data-tone="muted" ref={ref} />
    )

    const placeholder = container.firstElementChild
    expect(placeholder).toBe(ref.current)
    expect(placeholder).toHaveAttribute("aria-hidden", "true")
    expect(placeholder).toHaveAttribute("data-tone", "muted")
    expect(screen.queryByRole("status")).toBeNull()
  })
})
