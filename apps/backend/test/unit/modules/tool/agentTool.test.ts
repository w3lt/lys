import type { ToolDefinitionCandidate } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"

import ToolArgument from "../../../../src/modules/tool/argument"
import AgentTool from "../../../../src/modules/tool/tool"

describe("AgentTool", () => {
  it("offers the model each argument in declaration order, with an enum as a limited string", () => {
    const tool = new AgentTool({
      name: "search_files",
      description: "Find files under a directory.",
      group: "files",
      access: "reads",
      arguments: [
        {
          type: "string",
          name: "root",
          description: "Directory whose tree is searched.",
          required: true
        },
        {
          type: "enum",
          name: "target",
          description: "What is compared with the query.",
          required: true,
          values: ["name", "content", "nameAndContent"]
        },
        {
          type: "integer",
          name: "maxResults",
          description: "Most matching files to return.",
          required: false
        }
      ]
    })

    const format = tool.toAgentFormat()

    expect(format).toEqual({
      type: "function",
      function: {
        name: "search_files",
        description: "Find files under a directory.",
        parameters: {
          type: "object",
          properties: {
            root: {
              type: "string",
              description: "Directory whose tree is searched."
            },
            target: {
              type: "string",
              description: "What is compared with the query.",
              enum: ["name", "content", "nameAndContent"]
            },
            maxResults: {
              type: "integer",
              description: "Most matching files to return."
            }
          },
          required: ["root", "target"],
          additionalProperties: false
        }
      }
    })
    expect(Object.keys(format.function.parameters.properties)).toEqual([
      "root",
      "target",
      "maxResults"
    ])
  })

  it("treats an argument that omits required as required", () => {
    const tool = new AgentTool({
      name: "read_text_file",
      description: "Read one text file.",
      group: "files",
      access: "reads",
      arguments: [
        { type: "string", name: "path", description: "Absolute path." }
      ]
    })

    expect(tool.toAgentFormat().function.parameters.required).toEqual(["path"])
  })

  it("offers a tool without arguments an empty parameters object", () => {
    const tool = new AgentTool({
      name: "get_time",
      description: "Return the current time.",
      group: "files",
      access: "reads",
      arguments: []
    })

    expect(tool.toAgentFormat().function.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    })
  })

  it("returns a format that cannot be changed through any of its parts", () => {
    const format = new AgentTool({
      name: "search_files",
      description: "Find files.",
      group: "files",
      access: "reads",
      arguments: [
        {
          type: "enum",
          name: "target",
          description: "What is compared.",
          values: ["name", "content"]
        }
      ]
    }).toAgentFormat()
    const parameters = format.function.parameters

    expect(Object.isFrozen(format)).toBe(true)
    expect(Object.isFrozen(format.function)).toBe(true)
    expect(Object.isFrozen(parameters)).toBe(true)
    expect(Object.isFrozen(parameters.properties)).toBe(true)
    expect(Object.isFrozen(parameters.required)).toBe(true)
    expect(Object.isFrozen(parameters.properties.target)).toBe(true)
    expect(Object.isFrozen(parameters.properties.target?.enum)).toBe(true)
  })

  it.each<{
    readonly problem: string
    readonly definition: ToolDefinitionCandidate
  }>([
    {
      problem: "an enum argument without values",
      definition: {
        name: "search_files",
        description: "Find files.",
        group: "files",
        access: "reads",
        arguments: [
          {
            type: "enum",
            name: "target",
            description: "What is compared.",
            values: []
          }
        ]
      }
    },
    {
      problem: "an enum argument that lists a value twice",
      definition: {
        name: "search_files",
        description: "Find files.",
        group: "files",
        access: "reads",
        arguments: [
          {
            type: "enum",
            name: "target",
            description: "What is compared.",
            values: ["name", "name"]
          }
        ]
      }
    },
    {
      problem: "two arguments with the same name",
      definition: {
        name: "search_files",
        description: "Find files.",
        group: "files",
        access: "reads",
        arguments: [
          { type: "string", name: "root", description: "Directory." },
          { type: "string", name: "root", description: "Another directory." }
        ]
      }
    },
    {
      problem: "a name the model cannot call",
      definition: {
        name: "search files",
        description: "Find files.",
        group: "files",
        access: "reads",
        arguments: []
      }
    },
    {
      problem: "an empty description",
      definition: {
        name: "search_files",
        description: "",
        group: "files",
        access: "reads",
        arguments: []
      }
    },
    {
      problem: "an argument named __proto__",
      definition: {
        name: "search_files",
        description: "Find files.",
        group: "files",
        access: "reads",
        arguments: [
          { type: "string", name: "__proto__", description: "Prototype." }
        ]
      }
    }
  ])("rejects $problem", ({ definition }) => {
    expect(() => new AgentTool(definition)).toThrow(z.ZodError)
  })
})

describe("ToolArgument", () => {
  it("offers an enum argument to the model as a string limited to its values", () => {
    const argument = new ToolArgument({
      type: "enum",
      name: "target",
      description: "What is compared with the query.",
      values: ["name", "content"]
    })

    expect(argument.toAgentFormat()).toEqual({
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
