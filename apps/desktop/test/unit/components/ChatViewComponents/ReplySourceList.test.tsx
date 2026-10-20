import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import ReplySourceList from "@/components/ChatViewComponents/ReplySourceList"

/** Sources of the fixture reply. */
const MOTHS = Object.freeze({
  number: 2,
  url: "https://www.moths.example/night",
  title: "Night moths"
})
const LAMPS = Object.freeze({
  number: 1,
  url: "https://lamps.example/",
  title: "Lamps"
})
const BARK = Object.freeze({
  number: 3,
  url: "https://bark.example/",
  title: "Bark"
})

describe("ReplySourceList", () => {
  it("lists the cited sources in citation order as links to them, each with its number, title, and site", () => {
    render(
      <ReplySourceList
        replyNumber={1}
        sources={{ cited: [MOTHS, LAMPS], found: [] }}
      />
    )

    const list = screen.getByRole("list", { name: "Sources · 2 cited" })
    const links = within(list).getAllByRole("link")
    expect(links.map((link) => link.textContent)).toEqual([
      "2Night mothsmoths.example",
      "1Lampslamps.example"
    ])
    expect(links[0]).toHaveAttribute("href", MOTHS.url)
    expect(links[0]).toHaveAttribute("target", "_blank")
    expect(links[0]).toHaveAttribute("rel", "noreferrer")
    expect(screen.queryByText(/more$/)).toBeNull()
    expect(screen.queryByRole("region")).toBeNull()
  })

  it("keeps the sources the reply found without citing under a collapsed count, each with the tool that found it", async () => {
    const user = userEvent.setup()
    render(
      <ReplySourceList
        replyNumber={2}
        sources={{
          cited: [MOTHS],
          found: [{ source: BARK, toolName: "web_search" }]
        }}
      />
    )
    const found = screen.getByRole("link", { name: /Bark/ })
    const whileCollapsed = found

    expect(whileCollapsed).not.toBeVisible()
    await user.click(screen.getByLabelText("1 more, reply 2"))

    expect(found).toBeVisible()
    expect(screen.getByText("via web_search")).toBeVisible()
  })

  it("shows only the found sources, under their count, when the reply cites none", async () => {
    const user = userEvent.setup()
    render(
      <ReplySourceList
        replyNumber={1}
        sources={{
          cited: [],
          found: [
            { source: BARK, toolName: "web_search" },
            { source: LAMPS, toolName: "read_page" }
          ]
        }}
      />
    )

    expect(screen.queryByText(/cited$/)).toBeNull()
    await user.click(screen.getByText("Sources · 2 found"))

    expect(screen.getAllByRole("list")).toHaveLength(1)
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["3Barkbark.example", "1Lampslamps.example"]
    )
  })
})
