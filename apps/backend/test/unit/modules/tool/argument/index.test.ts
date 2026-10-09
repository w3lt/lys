import type { ToolArgumentDefinitionCandidate } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"

import ToolArgument from "../../../../../src/modules/tool/argument"

describe("ToolArgument", () => {
  it("reports its name", () => {
    const argument = new ToolArgument({
      type: "string",
      name: "path",
      description: "Absolute path."
    })

    expect(argument.name).toBe("path")
  })

  it.each<{
    label: string
    definition: ToolArgumentDefinitionCandidate
    acceptedValue: unknown
    rejectedValue: unknown
  }>([
    {
      label: "a string",
      definition: { type: "string", name: "path", description: "Path." },
      acceptedValue: "/notes",
      rejectedValue: 1
    },
    {
      label: "a number",
      definition: { type: "number", name: "ratio", description: "Ratio." },
      acceptedValue: 1.5,
      rejectedValue: "1.5"
    },
    {
      label: "an integer",
      definition: { type: "integer", name: "limit", description: "Limit." },
      acceptedValue: 2,
      rejectedValue: 2.5
    },
    {
      label: "a Boolean",
      definition: { type: "boolean", name: "deep", description: "Deep." },
      acceptedValue: true,
      rejectedValue: "true"
    },
    {
      label: "an enum",
      definition: {
        type: "enum",
        name: "target",
        description: "Target.",
        values: ["name", "content"]
      },
      acceptedValue: "name",
      rejectedValue: "path"
    }
  ])(
    "accepts $label value of its type and rejects another",
    ({ definition, acceptedValue, rejectedValue }) => {
      const schema = new ToolArgument(definition).buildValueSchema()

      expect(schema.safeParse(acceptedValue)).toMatchObject({
        success: true,
        data: acceptedValue
      })
      expect(schema.safeParse(rejectedValue).success).toBe(false)
    }
  )

  it("rejects an absent value of an argument that omits required", () => {
    const schema = new ToolArgument({
      type: "integer",
      name: "maxResults",
      description: "Most matching files to return."
    }).buildValueSchema()

    expect(schema.safeParse(undefined).success).toBe(false)
  })

  it("accepts an absent value of an optional argument", () => {
    const schema = new ToolArgument({
      type: "integer",
      name: "maxResults",
      description: "Most matching files to return.",
      required: false
    }).buildValueSchema()

    expect(schema.safeParse(undefined).success).toBe(true)
  })

  it("rejects an enum argument without values", () => {
    expect(
      () =>
        new ToolArgument({
          type: "enum",
          name: "target",
          description: "What is compared.",
          values: []
        })
    ).toThrow(z.ZodError)
  })
})
