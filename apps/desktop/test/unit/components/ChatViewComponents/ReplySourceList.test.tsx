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
    render(<ReplySourceList sources={{ cited: [MOTHS, LAMPS], found: [] }} />)

    const list = screen.getByRole("region", { name: "Sources" })
    expect(within(list).getByText("Sources · 2 cited")).toBeInTheDocument()
    const links = within(list).getAllByRole("link")
    expect(links.map((link) => link.textContent)).toEqual([
      "2Night mothsmoths.example",
      "1Lampslamps.example"
    ])
    expect(links[0]).toHaveAttribute("href", MOTHS.url)
    expect(links[0]).toHaveAttribute("target", "_blank")
    expect(links[0]).toHaveAttribute("rel", "noreferrer")
    expect(within(list).queryByText(/more$/)).toBeNull()
  })

  it("keeps the sources the reply found without citing under a collapsed count, each with the tool that found it", async () => {
    const user = userEvent.setup()
    render(
      <ReplySourceList
        sources={{
          cited: [MOTHS],
          found: [{ source: BARK, toolName: "web_search" }]
        }}
      />
    )
    const found = screen.getByRole("link", { name: /Bark/ })
    const whileCollapsed = found

    expect(whileCollapsed).not.toBeVisible()
    await user.click(screen.getByText("1 more"))

    expect(found).toBeVisible()
    expect(screen.getByText("via web_search")).toBeVisible()
  })
})
