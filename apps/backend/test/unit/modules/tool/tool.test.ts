import { toolDefinitionSchema, type ToolDefinitionCandidate } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"

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

    const format = tool.buildAgentFormat()

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

    expect(tool.buildAgentFormat().function.parameters.required).toEqual([
      "path"
    ])
  })

  it("offers a tool without arguments an empty parameters object", () => {
    const tool = new AgentTool({
      name: "get_time",
      description: "Return the current time.",
      group: "files",
      access: "reads",
      arguments: []
    })

    expect(tool.buildAgentFormat().function.parameters).toEqual({
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
    }).buildAgentFormat()
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

describe("toolDefinitionSchema", () => {
  /** Valid string argument that a case may change in one field. */
  const rootArgument = {
    type: "string",
    name: "root",
    description: "Directory whose tree is searched."
  }

  /** Valid enum argument with two values. */
  const targetArgument = {
    type: "enum",
    name: "target",
    description: "What is compared with the query.",
    values: ["name", "content"]
  }

  /** Valid definition that each rejection case changes in one field. */
  const searchFilesDefinition = {
    name: "search_files",
    description: "Find files under a directory.",
    group: "files",
    access: "reads",
    arguments: [rootArgument]
  }

  it("returns a definition that cannot be changed through any of its parts", () => {
    const definition = toolDefinitionSchema.parse({
      ...searchFilesDefinition,
      arguments: [rootArgument, targetArgument]
    })
    const [root, target] = definition.arguments

    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.arguments)).toBe(true)
    expect(Object.isFrozen(root)).toBe(true)
    expect(Object.isFrozen(target)).toBe(true)
    expect(target?.type === "enum" && Object.isFrozen(target.values)).toBe(true)
  })

  it("accepts tool and argument names of 64 characters", () => {
    const name = "a".repeat(64)

    const definition = toolDefinitionSchema.parse({
      ...searchFilesDefinition,
      name,
      arguments: [{ ...rootArgument, name }]
    })

    expect(definition.name).toBe(name)
    expect(definition.arguments[0]?.name).toBe(name)
  })

  it.each<{
    readonly problem: string
    readonly input: unknown
    readonly issue: {
      readonly code: string
      readonly path: readonly (string | number)[]
    }
  }>([
    {
      problem: "a field the definition lacks",
      input: { ...searchFilesDefinition, version: 1 },
      issue: { code: "unrecognized_keys", path: [] }
    },
    {
      problem: "an argument field the definition lacks",
      input: {
        ...searchFilesDefinition,
        arguments: [{ ...rootArgument, default: "/" }]
      },
      issue: { code: "unrecognized_keys", path: ["arguments", 0] }
    },
    {
      problem: "a group Settings does not list",
      input: { ...searchFilesDefinition, group: "network" },
      issue: { code: "invalid_value", path: ["group"] }
    },
    {
      problem: "an access level no tool has",
      input: { ...searchFilesDefinition, access: "writes" },
      issue: { code: "invalid_value", path: ["access"] }
    },
    {
      problem: "an empty enum value",
      input: {
        ...searchFilesDefinition,
        arguments: [{ ...targetArgument, values: ["name", ""] }]
      },
      issue: { code: "too_small", path: ["arguments", 0, "values", 1] }
    },
    {
      problem: "an argument name that starts with a digit",
      input: {
        ...searchFilesDefinition,
        arguments: [{ ...rootArgument, name: "1" }]
      },
      issue: { code: "invalid_format", path: ["arguments", 0, "name"] }
    },
    {
      problem: "a tool name longer than 64 characters",
      input: { ...searchFilesDefinition, name: "a".repeat(65) },
      issue: { code: "invalid_format", path: ["name"] }
    },
    {
      problem: "an argument name longer than 64 characters",
      input: {
        ...searchFilesDefinition,
        arguments: [{ ...rootArgument, name: "a".repeat(65) }]
      },
      issue: { code: "invalid_format", path: ["arguments", 0, "name"] }
    },
    {
      problem: "an argument with an empty description",
      input: {
        ...searchFilesDefinition,
        arguments: [{ ...rootArgument, description: "" }]
      },
      issue: { code: "too_small", path: ["arguments", 0, "description"] }
    }
  ])("rejects $problem", ({ input, issue }) => {
    const result = toolDefinitionSchema.safeParse(input)

    expect(
      result.error?.issues.map(({ code, path }) => ({ code, path }))
    ).toEqual([issue])
  })
})
