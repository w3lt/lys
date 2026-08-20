import { describe, expect, it } from "vitest"
import {
  buildRecordIndex,
  countByStatus,
  selectMostRecent,
  type HandbookRecordSource
} from "./records"

const acceptedDecision: HandbookRecordSource = {
  href: "/decisions/adr-0005/",
  title: "The backend is the sole writer of session state",
  identifier: "ADR-0005",
  status: "accepted",
  date: "2026-05-12",
  areas: ["backend"]
}

const supersededDecision: HandbookRecordSource = {
  href: "/decisions/adr-0003/",
  title: "Providers read credentials directly from the keychain",
  identifier: "ADR-0003",
  status: "superseded",
  date: "2026-03-02"
}

describe("buildRecordIndex", () => {
  it("orders rows by ascending identifier regardless of input order", () => {
    const index = buildRecordIndex("decision", [
      acceptedDecision,
      supersededDecision
    ])

    expect(index.map((record) => record.identifier)).toEqual([
      "ADR-0003",
      "ADR-0005"
    ])
  })

  it("defaults a record with no declared areas to an empty list", () => {
    const [record] = buildRecordIndex("decision", [supersededDecision])

    expect(record?.areas).toEqual([])
  })

  it("returns an empty index for an empty register", () => {
    expect(buildRecordIndex("decision", [])).toEqual([])
  })

  it("rejects a record that is missing its identifier", () => {
    expect(() =>
      buildRecordIndex("decision", [
        { ...acceptedDecision, identifier: undefined }
      ])
    ).toThrow(/missing required index metadata/)
  })

  it("rejects a record that is missing its status", () => {
    expect(() =>
      buildRecordIndex("proposal", [{ ...acceptedDecision, status: undefined }])
    ).toThrow(/A proposal requires an identifier, a status, and a date/)
  })

  it("rejects a record that is missing its date", () => {
    expect(() =>
      buildRecordIndex("decision", [{ ...acceptedDecision, date: undefined }])
    ).toThrow(/missing required index metadata/)
  })

  it("names both documents when two records claim one identifier", () => {
    expect(() =>
      buildRecordIndex("decision", [
        acceptedDecision,
        { ...supersededDecision, identifier: "ADR-0005" }
      ])
    ).toThrow(
      'Duplicate decision identifier "ADR-0005" is claimed by both "/decisions/adr-0005/" and "/decisions/adr-0003/".'
    )
  })
})

describe("selectMostRecent", () => {
  const index = buildRecordIndex("decision", [
    acceptedDecision,
    supersededDecision
  ])

  it("orders by descending date rather than by identifier", () => {
    expect(
      selectMostRecent(index, 2).map((record) => record.identifier)
    ).toEqual(["ADR-0005", "ADR-0003"])
  })

  it("truncates to the requested length", () => {
    expect(selectMostRecent(index, 1)).toHaveLength(1)
  })

  it("returns every record when fewer exist than requested", () => {
    expect(selectMostRecent(index, 10)).toHaveLength(2)
  })

  it("rejects a non-positive length", () => {
    expect(() => selectMostRecent(index, 0)).toThrow(/positive integer/)
  })

  it("rejects a fractional length", () => {
    expect(() => selectMostRecent(index, 1.5)).toThrow(/positive integer/)
  })
})

describe("countByStatus", () => {
  it("tallies each status present", () => {
    const counts = countByStatus(
      buildRecordIndex("decision", [
        acceptedDecision,
        supersededDecision,
        {
          ...acceptedDecision,
          href: "/decisions/adr-0009/",
          identifier: "ADR-0009"
        }
      ])
    )

    expect(counts.get("accepted")).toBe(2)
    expect(counts.get("superseded")).toBe(1)
  })

  it("omits a status that no record carries", () => {
    const counts = countByStatus(
      buildRecordIndex("decision", [acceptedDecision])
    )

    expect(counts.has("deprecated")).toBe(false)
  })
})
