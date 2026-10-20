import { describe, expect, it } from "vitest"
import SourceCatalog from "../../../../src/modules/agent/sourceCatalog"

/** Source the conversation stored before the turn. */
const STORED_SOURCE = Object.freeze({
  number: 3,
  url: "https://moths.example/",
  title: "Moths"
})

describe("SourceCatalog", () => {
  it("numbers new URLs from 1 in a conversation without sources", () => {
    const catalog = new SourceCatalog([])

    expect(
      catalog.addWebSources([
        { url: "https://a.example/", title: "A" },
        { url: "https://b.example/", title: "B" }
      ])
    ).toEqual([
      { number: 1, url: "https://a.example/", title: "A" },
      { number: 2, url: "https://b.example/", title: "B" }
    ])
  })

  it("numbers new URLs after the highest stored number and keeps a stored URL's source, title included", () => {
    const catalog = new SourceCatalog([
      { number: 1, url: "https://first.example/", title: "First" },
      STORED_SOURCE
    ])

    expect(
      catalog.addWebSources([
        { url: "https://new.example/", title: "New" },
        { url: STORED_SOURCE.url, title: "Moths, retitled" }
      ])
    ).toEqual([
      { number: 4, url: "https://new.example/", title: "New" },
      STORED_SOURCE
    ])
  })

  it("gives a URL one number across calls and within one call", () => {
    const catalog = new SourceCatalog([])
    const first = catalog.addWebSources([
      { url: "https://a.example/", title: "A" }
    ])

    expect(
      catalog.addWebSources([
        { url: "https://b.example/", title: "B" },
        { url: "https://a.example/", title: "A again" },
        { url: "https://b.example/", title: "B again" }
      ])
    ).toEqual([
      { number: 2, url: "https://b.example/", title: "B" },
      ...first,
      { number: 2, url: "https://b.example/", title: "B" }
    ])
  })

  it("returns nothing for a result that shows no source and numbers nothing", () => {
    const catalog = new SourceCatalog([STORED_SOURCE])

    expect(catalog.addWebSources([])).toEqual([])
    expect(
      catalog.addWebSources([{ url: "https://next.example/", title: "Next" }])
    ).toEqual([{ number: 4, url: "https://next.example/", title: "Next" }])
  })

  it("returns frozen sources and does not change with the list it was given", () => {
    const storedSources = [{ ...STORED_SOURCE }]
    const catalog = new SourceCatalog(storedSources)
    storedSources.pop()

    const sources = catalog.addWebSources([
      { url: STORED_SOURCE.url, title: "Moths" },
      { url: "https://new.example/", title: "New" }
    ])

    expect(sources).toEqual([
      STORED_SOURCE,
      { number: 4, url: "https://new.example/", title: "New" }
    ])
    expect(Object.isFrozen(sources)).toBe(true)
    expect(Object.isFrozen(sources[0])).toBe(true)
    expect(Object.isFrozen(sources[1])).toBe(true)
  })

  it("keeps a stored source as it was given, though the caller changes its object later", () => {
    const storedSource: { number: number; url: string; title: string } = {
      ...STORED_SOURCE
    }
    const catalog = new SourceCatalog([storedSource])
    storedSource.number = 99
    storedSource.title = "Changed"

    expect(
      catalog.addWebSources([{ url: STORED_SOURCE.url, title: "Moths" }])
    ).toEqual([STORED_SOURCE])
  })
})
