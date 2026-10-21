import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import UserMessage from "@/components/ChatViewComponents/UserMessage"
import { buildUserMessage } from "../../support/conversationFixtures"
import { startDecodedImageHost } from "../../support/imageHostFake"

describe("UserMessage", () => {
  it("shows the message as written under the you label", () => {
    render(
      <UserMessage message={buildUserMessage(1, "Is **this** markdown?")} />
    )

    const message = screen.getByRole("article")
    expect(message).toHaveTextContent(/^you/)
    expect(message).toHaveTextContent("Is **this** markdown?")
    expect(screen.queryByRole("strong")).not.toBeInTheDocument()
  })

  it("lists the files sent with the message by kind and name, in sending order", () => {
    render(
      <UserMessage
        message={buildUserMessage(1, "Summarize these", [
          { kind: "text", number: 1, name: "notes.md", sizeBytes: 12 },
          {
            kind: "image",
            number: 2,
            name: "photo.png",
            sizeBytes: 33,
            mediaType: "image/png",
            width: 64,
            height: 32
          }
        ])}
      />
    )

    const files = screen.getByRole("list", { name: "Attached files" })
    expect(
      within(files)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["mdnotes.md", "pngphoto.png"])
  })

  it("lists no files for a message sent without any", () => {
    render(<UserMessage message={buildUserMessage(1, "Hello")} />)

    expect(
      screen.queryByRole("list", { name: "Attached files" })
    ).not.toBeInTheDocument()
  })

  it("keeps the decorative portrait out of the accessibility tree", () => {
    startDecodedImageHost()
    const { container } = render(
      <UserMessage message={buildUserMessage(1, "Hello")} />
    )

    // The portrait is rendered, so its absence below is meaningful.
    expect(container.querySelectorAll("img")).toHaveLength(1)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })
})
