import { describe, expect, it } from "vitest"
import { toBreadcrumbTrail } from "./breadcrumbs"

describe("toBreadcrumbTrail", () => {
  it("returns no trail for the homepage", () => {
    expect(toBreadcrumbTrail("", "Home")).toEqual([])
    expect(toBreadcrumbTrail("index", "Home")).toEqual([])
  })

  it("returns no trail for the not-found page", () => {
    expect(toBreadcrumbTrail("404", "Not found")).toEqual([])
  })

  it("links a section that has its own index", () => {
    expect(toBreadcrumbTrail("decisions/adr-0007-handles", "ADR-0007")).toEqual(
      [
        { label: "Handbook", href: "/" },
        { label: "Decisions", href: "/decisions/" },
        { label: "ADR-0007" }
      ]
    )
  })

  it("leaves a section without an index unlinked, so no broken link is emitted", () => {
    expect(toBreadcrumbTrail("architecture/backend", "Backend")).toEqual([
      { label: "Handbook", href: "/" },
      { label: "Architecture", href: undefined },
      { label: "Backend" }
    ])
  })

  it("labels a nested directory that is not a registered section", () => {
    expect(
      toBreadcrumbTrail("operate/runbooks/recover-session-database", "Recover")
    ).toEqual([
      { label: "Handbook", href: "/" },
      { label: "Operate", href: undefined },
      { label: "Runbooks" },
      { label: "Recover" }
    ])
  })

  it("never links the current page, which is always the final step", () => {
    const trail = toBreadcrumbTrail("reference/sse-events", "SSE events")

    expect(trail.at(-1)).toEqual({ label: "SSE events" })
  })
})
