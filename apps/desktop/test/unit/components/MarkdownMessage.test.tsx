import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { MarkdownMessage } from "@/components/MarkdownMessage"
import { formatSourceSite } from "@/components/markdown-citations"
import { startHover } from "../support/rendering"
import { waitForMicrotasks } from "../support/settlement"

/** Fenced TypeScript block whose copyable text is two lines. */
const TYPESCRIPT_BLOCK = "```ts\nconst a = 1\nconst b = 2\n```\n"

/**
 * Status the parent words for the caret, naming the agent that answers; the
 * message announces it only while the reply streams.
 */
const GENERATING_LABEL = "Caliginia is generating"

/** GFM table whose second column is right-aligned and whose body has a link. */
const MODEL_TABLE =
  "| Model | Context |\n| --- | ---: |\n| [qwen3-8b](https://example.com/qwen) | 32,768 |\n"

/**
 * Waits until a message's asynchronous pass has resolved.
 *
 * @param linkName - Accessible name of an external link in the message.
 * @returns Settlement once that link opens in a new tab, which only the
 * resolved pass renders.
 */
async function waitForProcessedPass(linkName: string) {
  await vi.waitFor(() => {
    expect(screen.getByRole("link", { name: linkName })).toHaveAttribute(
      "target",
      "_blank"
    )
  })
}

/**
 * Finds the element a fragment link points to.
 *
 * @param link - Link whose destination is a fragment of the document.
 * @returns The element with the fragment's id, when one exists.
 */
function findFragmentTarget(link: HTMLElement) {
  const fragmentId = link.getAttribute("href")?.slice(1) ?? ""
  return document.getElementById(fragmentId)
}

/**
 * Installs a clipboard on the navigator for one case.
 *
 * @param writeText - Clipboard write the case observes or fails.
 * @returns The write function the copy button calls.
 * @remarks jsdom has no clipboard, as a host that denies access has none
 * either; the property is removed when the case finishes.
 */
function startClipboardFake(
  writeText: (text: string) => Promise<void> = () => Promise.resolve()
) {
  const write = vi.fn(writeText)
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: write }
  })
  onTestFinished(() => {
    Reflect.deleteProperty(window.navigator, "clipboard")
  })
  return write
}

/**
 * Renders a message and waits until its highlighted code block is shown.
 *
 * @param text - Markdown containing one fenced code block.
 * @returns The copy button of that block and the tree's unmount function.
 */
async function startCodeBlock(text: string) {
  const { unmount } = render(
    <MarkdownMessage
      generatingLabel={GENERATING_LABEL}
      sources={NO_SOURCES}
      streaming={false}
      text={text}
    />
  )
  const copyButton = await screen.findByRole("button", { name: "Copy code" })
  return { copyButton, unmount }
}

afterEach(() => {
  vi.useRealTimers()
})

/** Sources of a conversation that has none. */
const NO_SOURCES = Object.freeze([])

describe("MarkdownMessage", () => {
  it("renders Markdown structure", async () => {
    render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text={"# Plan\n\n- one\n- **two**\n\nDone."}
      />
    )

    expect(
      await screen.findByRole("heading", { level: 1, name: "Plan" })
    ).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByText("two").tagName).toBe("STRONG")
    expect(screen.getByText("Done.")).toBeInTheDocument()
  })

  describe("citations", () => {
    /** Sources the cited message may link to. */
    const CITED_SOURCES = Object.freeze([
      {
        number: 1,
        url: "https://www.moths.example/night",
        title: "Night moths"
      },
      { number: 3, url: "https://lamps.example/", title: "Lamps" }
    ])

    /**
     * Renders cited Markdown and waits until its citations are links.
     *
     * @param text - Markdown citing {@link CITED_SOURCES}.
     * @param linkName - Accessible name of a link the resolved pass renders.
     */
    async function startCitedMessage(text: string, linkName: string) {
      render(
        <MarkdownMessage
          generatingLabel={GENERATING_LABEL}
          sources={CITED_SOURCES}
          streaming={false}
          text={text}
        />
      )
      await waitForProcessedPass(linkName)
    }

    it("links each marker of a known source to it, showing its number and named by it", async () => {
      await startCitedMessage(
        "Moths fly at night [1][3], not by day [2].",
        "1, source: Night moths"
      )

      const first = screen.getByRole("link", { name: "1, source: Night moths" })
      expect(first).toHaveTextContent(/^1$/)
      expect(first).toHaveAttribute("href", "https://www.moths.example/night")
      expect(first).toHaveAttribute("rel", "noreferrer")
      expect(first).not.toHaveAttribute("title")
      expect(
        screen.getByRole("link", { name: "3, source: Lamps" })
      ).toHaveTextContent(/^3$/)
      expect(screen.getByText(/not by day \[2\]\./)).toBeInTheDocument()
    })

    it("links markers inside emphasis and list items", async () => {
      await startCitedMessage(
        "- Moths **fly [1]**\n- Lamps *glow [3]*",
        "1, source: Night moths"
      )

      const items = screen.getAllByRole("listitem")
      expect(
        within(items[0] ?? document.body).getByRole("link", {
          name: "1, source: Night moths"
        })
      ).toBeVisible()
      expect(
        within(items[1] ?? document.body).getByRole("link", {
          name: "3, source: Lamps"
        })
      ).toBeVisible()
    })

    it("leaves markers in code and inside links as written", async () => {
      await startCitedMessage(
        "Code `[1]` and [the [1] page](https://x.example/).",
        "the [1] page"
      )

      expect(screen.queryByRole("link", { name: /, source: / })).toBeNull()
      expect(screen.getByText("[1]").tagName).toBe("CODE")
    })

    it("links no marker inside math, in either pass", async () => {
      render(
        <MarkdownMessage
          generatingLabel={GENERATING_LABEL}
          sources={CITED_SOURCES}
          streaming={false}
          text="Take $x[1]$ under lamps [3]."
        />
      )
      const firstPassLinks = screen.queryAllByRole("link")

      await waitForProcessedPass("3, source: Lamps")

      expect(firstPassLinks).toEqual([])
      expect(screen.getAllByRole("link")).toEqual([
        screen.getByRole("link", { name: "3, source: Lamps" })
      ])
    })

    it("shows the cited source's title and site while the pointer rests on it", async () => {
      await startCitedMessage("Moths [1].", "1, source: Night moths")
      const link = screen.getByRole("link", { name: "1, source: Night moths" })
      vi.useFakeTimers()

      startHover(link)
      act(() => {
        vi.advanceTimersByTime(600)
      })

      expect(
        screen.getByText("Night moths · moths.example")
      ).toBeInTheDocument()
    })
  })

  it("opens links in a new tab without sending the referrer", async () => {
    render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text={'See [the docs](https://example.com/docs "Lys docs").'}
      />
    )

    // The first pass renders plain Markdown; links are handled once the
    // asynchronous pass resolves.
    await vi.waitFor(() => {
      expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
        "target",
        "_blank"
      )
    })
    const link = screen.getByRole("link", { name: "the docs" })

    expect(link).toHaveAttribute("href", "https://example.com/docs")
    expect(link).toHaveAttribute("rel", "noreferrer")
    expect(link).toHaveAttribute("title", "Lys docs")
    expect(link.getAttributeNames().sort()).toEqual([
      "href",
      "rel",
      "target",
      "title"
    ])
  })

  it("renders inline and display math", async () => {
    render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text={"Area $a^2$ and\n\n$$\nE = mc^2\n$$\n"}
      />
    )

    await vi.waitFor(() => {
      expect(screen.getAllByRole("math")).toHaveLength(2)
    })
    expect(screen.queryByRole("code")).not.toBeInTheDocument()
  })

  it("renders a GFM table with its header, body, and column alignment", async () => {
    render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text={MODEL_TABLE}
      />
    )
    await waitForProcessedPass("qwen3-8b")

    const table = screen.getByRole("table")
    const headers = within(table).getAllByRole("columnheader")

    expect(headers.map((header) => header.textContent)).toEqual([
      "Model",
      "Context"
    ])
    expect(within(table).getByRole("cell", { name: "32,768" })).toHaveStyle({
      textAlign: "right"
    })
  })

  it("shows a table before the first pass resolves", async () => {
    render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text={MODEL_TABLE}
      />
    )

    // Only the resolved pass opens links in a new tab, so this is the
    // output shown before it.
    expect(screen.getByRole("link", { name: "qwen3-8b" })).not.toHaveAttribute(
      "target"
    )
    expect(screen.getByRole("table")).toBeInTheDocument()

    await waitForProcessedPass("qwen3-8b")
  })

  it("keeps footnote links in each message and points them at its own notes", async () => {
    render(
      <>
        <MarkdownMessage
          generatingLabel={GENERATING_LABEL}
          sources={NO_SOURCES}
          streaming={false}
          text={
            "First claim.[^1]\n\n[^1]: [First source](https://example.com/1)"
          }
        />
        <MarkdownMessage
          generatingLabel={GENERATING_LABEL}
          sources={NO_SOURCES}
          streaming={false}
          text={
            "Second claim.[^1]\n\n[^1]: [Second source](https://example.com/2)"
          }
        />
      </>
    )
    await waitForProcessedPass("First source")
    await waitForProcessedPass("Second source")

    const references = screen.getAllByRole("link", { name: "1" })
    const backReferences = screen.getAllByRole("link", {
      name: "Back to reference 1"
    })

    expect(references).toHaveLength(2)
    expect(references[0]).not.toHaveAttribute("target")
    expect(findFragmentTarget(references[0])).toHaveTextContent("First source")
    expect(findFragmentTarget(references[1])).toHaveTextContent("Second source")
    expect(backReferences[0]).not.toHaveAttribute("target")
    expect(findFragmentTarget(backReferences[0])).toBe(references[0])
    expect(findFragmentTarget(backReferences[1])).toBe(references[1])
  })

  it("shows task items as checkboxes that report their state", async () => {
    render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text={
          "- [x] Installed [LM Studio](https://example.com/lms)\n- [ ] Configured the context\n"
        }
      />
    )
    await waitForProcessedPass("LM Studio")

    const [installed, configured] = screen.getAllByRole("checkbox")

    expect(installed).toBeChecked()
    expect(installed).toBeDisabled()
    expect(configured).not.toBeChecked()
    expect(configured).toBeDisabled()
  })

  it("labels a code block with its language and copies its plain text", async () => {
    const writeText = startClipboardFake()
    const { copyButton } = await startCodeBlock(TYPESCRIPT_BLOCK)

    expect(screen.getByText("Ts")).toBeInTheDocument()

    fireEvent.click(copyButton)
    await waitForMicrotasks()

    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "const a = 1\nconst b = 2"
    )
    expect(screen.getByRole("button", { name: "copied" })).toBe(copyButton)
  })

  it("labels a code block without a language as Text and copies it without the final newline", async () => {
    const writeText = startClipboardFake()
    const { copyButton } = await startCodeBlock("```\nplain words\n```\n")

    expect(screen.getByText("Text")).toBeInTheDocument()
    expect(screen.getByText("plain words")).toBeInTheDocument()

    fireEvent.click(copyButton)
    await waitForMicrotasks()

    expect(writeText).toHaveBeenCalledExactlyOnceWith("plain words")
  })

  it("shows code in a language it cannot highlight as plain text", async () => {
    await startCodeBlock("```notalanguage\nkeep me\n```\n")

    expect(screen.getByText("keep me")).toBeInTheDocument()
  })

  it("returns the copy label 1.4 seconds after the latest copy", async () => {
    startClipboardFake()
    const { copyButton } = await startCodeBlock(TYPESCRIPT_BLOCK)
    vi.useFakeTimers()

    fireEvent.click(copyButton)
    await vi.advanceTimersByTimeAsync(1000)
    fireEvent.click(copyButton)
    await vi.advanceTimersByTimeAsync(1399)

    expect(copyButton).toHaveAccessibleName("copied")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(copyButton).toHaveAccessibleName("Copy code")
  })

  it("leaves no reset pending once the message is removed", async () => {
    startClipboardFake()
    const { copyButton, unmount } = await startCodeBlock(TYPESCRIPT_BLOCK)
    vi.useFakeTimers()
    fireEvent.click(copyButton)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps the copy label when the clipboard refuses the write", async () => {
    const writeText = startClipboardFake(() =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"))
    )
    const { copyButton } = await startCodeBlock(TYPESCRIPT_BLOCK)

    fireEvent.click(copyButton)
    await waitForMicrotasks()

    expect(writeText).toHaveBeenCalledOnce()
    expect(copyButton).toHaveAccessibleName("Copy code")
  })

  it("announces the parent's generating status only while the reply streams", () => {
    const { rerender } = render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming
        text="Partial"
      />
    )

    expect(
      screen.getByRole("status", { name: GENERATING_LABEL })
    ).toHaveAttribute("aria-live", "polite")

    rerender(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming={false}
        text="Partial answer"
      />
    )

    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows the newest text after an update", async () => {
    const { rerender } = render(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming
        text="First"
      />
    )
    await screen.findByText("First")

    rerender(
      <MarkdownMessage
        generatingLabel={GENERATING_LABEL}
        sources={NO_SOURCES}
        streaming
        text="First and second"
      />
    )

    expect(await screen.findByText("First and second")).toBeInTheDocument()
  })
})

describe("formatSourceSite", () => {
  it.each([
    ["https://www.moths.example/night", "moths.example"],
    ["https://lamps.example:8443/a?b", "lamps.example:8443"],
    ["http://wwwmoths.example/", "wwwmoths.example"]
  ])("shows %s as %s", (url, site) => {
    expect(formatSourceSite(url)).toBe(site)
  })
})
