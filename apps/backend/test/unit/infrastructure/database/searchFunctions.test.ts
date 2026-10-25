import { describe, expect, it } from "vitest"
import {
  calculateSearchMatch,
  registerSearchFunctions
} from "../../../../src/infrastructure/database/searchFunctions"
import SqliteDatabase from "../../../../src/infrastructure/database/sqliteDatabase"
import { openTestDatabase } from "../../support/conversationDatabase"

describe("calculateSearchMatch", () => {
  it.each([
    ["an exact substring", "Plan the trip", "trip", 1],
    ["a different ASCII case", "Plan the TRIP", "trip", 1],
    ["a different non-ASCII case", "ΣΟΦΙΑ", "σοφια", 1],
    ["absent text", "Plan the trip", "budget", 0],
    ["regular-expression syntax taken literally", "abc", "a.c", 0],
    [
      "regular-expression syntax present literally",
      "cost (total)",
      "(total)",
      1
    ],
    ["SQL wildcard characters taken literally", "50 percent", "%", 0]
  ])("matches %s", (_label, content, query, expected) => {
    expect(calculateSearchMatch(content, query)).toBe(expected)
  })

  it.each([
    ["a null column", null, "trip"],
    ["numeric content", 42, "4"],
    ["a non-text query", "Plan the trip", null]
  ])("never matches %s", (_label, content, query) => {
    expect(calculateSearchMatch(content, query)).toBe(0)
  })
})

describe("registerSearchFunctions", () => {
  it("registers case-insensitive containment on the shared connection", () => {
    const database = openTestDatabase()

    registerSearchFunctions(database)

    expect(
      database.handleDatabaseReadRequest((statements) =>
        statements
          .getStatement(
            "SELECT contains_search('Plan the TRIP', 'trip') AS match"
          )
          .get()
      )
    ).toEqual({ match: 1 })
  })

  it("refuses a closed database", () => {
    const database = SqliteDatabase.open(":memory:")
    database[Symbol.dispose]()

    expect(() => {
      registerSearchFunctions(database)
    }).toThrow("Database is closed")
  })
})
