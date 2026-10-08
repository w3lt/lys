import { describe, expect, it } from "vitest"
import * as z from "zod"

import ToolArgument from "../../../../../src/modules/tool/argument"

describe("ToolArgument", () => {
  it("offers an enum argument to the model as a string limited to its values", () => {
    const argument = new ToolArgument({
      type: "enum",
      name: "target",
      description: "What is compared with the query.",
      values: ["name", "content"]
    })

    expect(argument.buildAgentFormat()).toEqual({
      type: "string",
      description: "What is compared with the query.",
      enum: ["name", "content"]
    })
  })

  it("exposes the validated definition, with required defaulting to true", () => {
    const argument = new ToolArgument({
      type: "integer",
      name: "maxResults",
      description: "Most matching files to return."
    })

    expect({
      name: argument.name,
      description: argument.description,
      type: argument.type,
      required: argument.required
    }).toEqual({
      name: "maxResults",
      description: "Most matching files to return.",
      type: "integer",
      required: true
    })
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
