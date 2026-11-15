import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import UserMessage from "@/components/ChatViewComponents/UserMessage"
import {
  buildDelegatorMessage,
  buildJob,
  buildJobCard,
  buildJobReport,
  buildUserMessage,
  buildUserMessageWithReports,
  buildWakeUpMessage,
  createFixtureUuidV7
} from "../../support/conversationFixtures"
import { startDecodedImageHost } from "../../support/imageHostFake"

/**
 * What the first message of a main conversation that names no job is shown
 * with.
 */
const MAIN_CONVERSATION = Object.freeze({
  jobCards: [],
  delegatorName: undefined,
  messageNumber: 1
})

/** Card of job 1, which names its agent `Nyx`. */
const CARD = buildJobCard(buildJob())

describe("UserMessage", () => {
  it("shows the message as written under the you label", () => {
    render(
      <UserMessage
        {...MAIN_CONVERSATION}
        message={buildUserMessage(1, "Is **this** markdown?")}
      />
    )

    const message = screen.getByRole("article")
    expect(message).toHaveTextContent(/^you/)
    expect(message).toHaveTextContent("Is **this** markdown?")
    expect(screen.queryByRole("strong")).not.toBeInTheDocument()
  })

  it("lists the files sent with the message by kind and name, in sending order", () => {
    render(
      <UserMessage
        {...MAIN_CONVERSATION}
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
    render(
      <UserMessage
        {...MAIN_CONVERSATION}
        message={buildUserMessage(1, "Hello")}
      />
    )

    expect(
      screen.queryByRole("list", { name: "Attached files" })
    ).not.toBeInTheDocument()
  })

  it("keeps the decorative portrait out of the accessibility tree", () => {
    startDecodedImageHost()
    const { container } = render(
      <UserMessage
        {...MAIN_CONVERSATION}
        message={buildUserMessage(1, "Hello")}
      />
    )

    // The portrait is rendered, so its absence below is meaningful.
    expect(container.querySelectorAll("img")).toHaveLength(1)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("shows a line under a person's message that delivered reports, which opens to them", async () => {
    const user = userEvent.setup()
    render(
      <UserMessage
        delegatorName={undefined}
        jobCards={[CARD]}
        message={buildUserMessageWithReports(buildUserMessage(14, "Go on"), [
          buildJobReport({ kind: "note", content: "Reading three feeds" }),
          buildJobReport({ id: createFixtureUuidV7(69) })
        ])}
        messageNumber={4}
      />
    )
    const note = screen.getByText("Reading three feeds")

    expect(screen.getByRole("article")).toHaveTextContent(/^youGo on/)
    expect(note).not.toBeVisible()
    await user.click(
      screen.getByLabelText("2 reports delivered with this message, message 4")
    )

    expect(note).toBeVisible()
    expect(screen.getByText("Nyx · News · Result")).toBeVisible()
  })

  it("shows no report line under a message that delivered none", () => {
    render(
      <UserMessage
        {...MAIN_CONVERSATION}
        message={buildUserMessage(1, "Hello")}
      />
    )

    expect(
      screen.queryByText(/delivered with this message/)
    ).not.toBeInTheDocument()
  })

  it("shows a wake-up message as a Reports row, not as the person's message", async () => {
    const user = userEvent.setup()
    const message = buildWakeUpMessage(20, [buildJobReport()])
    render(
      <UserMessage
        delegatorName={undefined}
        jobCards={[CARD]}
        message={message}
        messageNumber={5}
      />
    )

    expect(screen.queryByText("you")).not.toBeInTheDocument()
    expect(screen.getByRole("article")).not.toHaveTextContent(message.content)
    await user.click(screen.getByLabelText("Reports · 1, message 5"))

    expect(screen.getByText("Nyx · News · Result")).toBeVisible()
    expect(screen.getByText("Done.")).toBeVisible()
  })

  it("labels a delegator's message with the delegator's name and an agent's portraits", () => {
    startDecodedImageHost()
    const { container } = render(
      <UserMessage
        delegatorName="Caliginia"
        jobCards={[]}
        message={buildDelegatorMessage(68, "Find the news.")}
        messageNumber={1}
      />
    )

    expect(screen.getByRole("article")).toHaveTextContent(
      /^CaliginiaFind the news\.$/
    )
    expect(screen.queryByText("you")).not.toBeInTheDocument()
    // An agent's two theme portraits, where the person has one.
    expect(container.querySelectorAll("img")).toHaveLength(2)
  })
})
