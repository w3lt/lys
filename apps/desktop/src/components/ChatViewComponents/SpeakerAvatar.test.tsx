import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import SpeakerAvatar from "./SpeakerAvatar"

describe("SpeakerAvatar", () => {
  it("marks the person with the initial of their speaker label", () => {
    const { container } = render(<SpeakerAvatar speaker="you" />)

    expect(container).toHaveTextContent("Y")
  })

  it("marks Lys with a wordless core instead of an initial", () => {
    const { container } = render(<SpeakerAvatar speaker="lys" />)

    expect(container.textContent).toBe("")
    expect(container.querySelector(".chat-view__avatar-core")).not.toBeNull()
  })

  it.each(["you", "lys"] as const)(
    "keeps the %s mark out of the accessibility tree",
    (speaker) => {
      const { container } = render(<SpeakerAvatar speaker={speaker} />)

      expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true")
    }
  )
})
