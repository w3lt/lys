import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Avatar, AvatarImage } from "@/components/ui/avatar"

describe("Avatar", () => {
  it("forwards its attributes and ref, so a decorative avatar stays out of the accessibility tree", () => {
    const ref = createRef<HTMLSpanElement>()
    const { container } = render(
      <Avatar aria-hidden="true" ref={ref}>
        <AvatarImage alt="" src="portrait.png" />
      </Avatar>
    )

    expect(container.firstElementChild).toBe(ref.current)
    expect(ref.current).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByRole("img")).toBeNull()
  })
})
