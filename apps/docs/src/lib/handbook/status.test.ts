import { describe, expect, it } from "vitest"
import {
  DOCUMENT_STATUS_PRESENTATION,
  resolveDocumentNotice,
  resolveStatusPresentation,
  type DocumentStatus
} from "./status"

const everyStatus = Object.keys(
  DOCUMENT_STATUS_PRESENTATION
) as readonly DocumentStatus[]

describe("resolveStatusPresentation", () => {
  it.each(everyStatus)(
    "gives %s a non-empty label and glyph so colour is never the only cue",
    (status) => {
      const presentation = resolveStatusPresentation(status)

      expect(presentation.label.length).toBeGreaterThan(0)
      expect(presentation.icon.length).toBeGreaterThan(0)
    }
  )

  it("reports an unregistered status instead of rendering a blank pill", () => {
    expect(() =>
      resolveStatusPresentation("archived" as DocumentStatus)
    ).toThrow(/has no registered presentation/)
  })
})

describe("resolveDocumentNotice", () => {
  it("gives a superseded decision a historical notice", () => {
    expect(resolveDocumentNotice("decision", "superseded")?.title).toBe(
      "Historical document"
    )
  })

  it("gives an accepted decision no notice, because it is current", () => {
    expect(resolveDocumentNotice("decision", "accepted")).toBeUndefined()
  })

  it("warns that an accepted proposal is not yet current architecture", () => {
    const notice = resolveDocumentNotice("proposal", "accepted")

    expect(notice?.title).toBe("Approved future change")
    expect(notice?.body).toContain("not describe current architecture")
  })

  it("gives an implemented proposal no notice, because it is current", () => {
    expect(resolveDocumentNotice("proposal", "implemented")).toBeUndefined()
  })

  it.each(["draft", "discussion", "rejected", "withdrawn"] as const)(
    "gives a %s proposal a notice",
    (status) => {
      expect(resolveDocumentNotice("proposal", status)).toBeDefined()
    }
  )
})
