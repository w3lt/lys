import {
  isEveryToolRunBy,
  toolDefinitionSchema,
  type ToolDefinitionCandidate
} from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"

import AgentTool from "../../../../src/modules/tool/tool"

describe("AgentTool", () => {
  it.each(["reads", "network"] as const)(
    "reports that a tool with %s access has that access",
    (access) => {
      const tool = new AgentTool({
        name: "look_up_word",
        description: "Look up one word.",
        group: "network",
        access,
        runner: "backend",
        arguments: []
      })

      expect(tool.access).toBe(access)
    }
  )

  it("offers the model each argument in declaration order, with an enum as a limited string", () => {
    const tool = new AgentTool({
      name: "search_files",
      description: "Find files under a directory.",
      group: "files",
      access: "reads",
      runner: "client",
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
    expect(Object.keys(format.function.parameters.properties ?? {})).toEqual([
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
      runner: "client",
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
      runner: "client",
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
      runner: "client",
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
    const target = parameters.properties?.["target"]
    expect(Object.isFrozen(parameters.properties)).toBe(true)
    expect(Object.isFrozen(parameters.required)).toBe(true)
    expect(Object.isFrozen(target)).toBe(true)
    expect(
      typeof target === "object" &&
        target !== null &&
        "enum" in target &&
        Object.isFrozen(target.enum)
    ).toBe(true)
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
        runner: "client",
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
        runner: "client",
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
        runner: "client",
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
        runner: "client",
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
        runner: "client",
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
        runner: "client",
        arguments: [
          { type: "string", name: "__proto__", description: "Prototype." }
        ]
      }
    }
  ])("rejects $problem", ({ definition }) => {
    expect(() => new AgentTool(definition)).toThrow(z.ZodError)
  })

  describe("parseCallArguments", () => {
    const searchFiles = new AgentTool({
      name: "search_files",
      description: "Find files under a directory.",
      group: "files",
      access: "reads",
      runner: "client",
      arguments: [
        { type: "string", name: "root", description: "Directory." },
        { type: "string", name: "query", description: "Text to find." },
        {
          type: "enum",
          name: "target",
          description: "What is compared.",
          values: ["name", "content"]
        },
        {
          type: "integer",
          name: "maxResults",
          description: "Most files to return.",
          required: false
        }
      ]
    })

    it("reports the name the model calls the tool by", () => {
      expect(searchFiles.name).toBe("search_files")
    })

    it("returns the values of a matching JSON object, leaving out an optional argument the model left out", () => {
      expect(
        searchFiles.parseCallArguments(
          '{"root":"/notes","query":"todo","target":"name"}'
        )
      ).toEqual({
        status: "valid",
        arguments: { root: "/notes", query: "todo", target: "name" }
      })
    })

    it("keeps an optional whole number the model sent", () => {
      expect(
        searchFiles.parseCallArguments(
          '{"root":"/notes","query":"todo","target":"name","maxResults":5}'
        )
      ).toEqual({
        status: "valid",
        arguments: {
          root: "/notes",
          query: "todo",
          target: "name",
          maxResults: 5
        }
      })
    })

    it("returns arguments that cannot be changed", () => {
      const result = searchFiles.parseCallArguments(
        '{"root":"/notes","query":"todo","target":"name"}'
      )

      expect(
        result.status === "valid" && Object.isFrozen(result.arguments)
      ).toBe(true)
    })

    it.each(["", "  "])(
      "reads blank text %j as no arguments for a tool without arguments",
      (argumentText) => {
        const tool = new AgentTool({
          name: "get_time",
          description: "Return the current time.",
          group: "files",
          access: "reads",
          runner: "client",
          arguments: []
        })

        expect(tool.parseCallArguments(argumentText)).toEqual({
          status: "valid",
          arguments: {}
        })
      }
    )

    it.each([
      ["text that is not JSON", '{"root":'],
      ["a JSON value that is not an object", '["/notes"]'],
      ["blank text while arguments are required", ""],
      ["a missing required argument", '{"root":"/notes","target":"name"}'],
      [
        "a value of the wrong type",
        '{"root":1,"query":"todo","target":"name"}'
      ],
      [
        "a fraction for a whole number",
        '{"root":"/notes","query":"todo","target":"name","maxResults":1.5}'
      ],
      [
        "a value the enum does not list",
        '{"root":"/notes","query":"todo","target":"path"}'
      ],
      [
        "an argument the tool does not declare",
        '{"root":"/notes","query":"todo","target":"name","deep":true}'
      ],
      [
        "a __proto__ key",
        '{"root":"/notes","query":"todo","target":"name","__proto__":{"x":1}}'
      ]
    ])("explains %s to the model, naming the tool", (_label, argumentText) => {
      expect(searchFiles.parseCallArguments(argumentText)).toEqual({
        status: "invalid",
        message: expect.stringContaining("search_files")
      })
    })
  })
})

describe("AgentTool for an MCP tool", () => {
  /** Input schema with a nested argument and a keyword Lys does not read. */
  const inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "File to read." },
      options: {
        type: "object",
        properties: { lines: { type: "array", items: { type: "integer" } } }
      }
    },
    required: ["path"],
    additionalProperties: false
  }
  const readFile = new AgentTool({
    name: "mcp__files__read_file",
    description: "Read one file.",
    group: "mcp",
    access: "unknown",
    runner: "mcp",
    server: "files",
    serverToolName: "read_file",
    inputSchema
  })

  /**
   * Builds argument text of an exact UTF-8 length.
   *
   * @param byteLength - Bytes of the whole text; at least 13.
   * @param filler - One-byte or two-byte character repeated in the path.
   * @returns `{"path":"…"}` of that many bytes.
   */
  function buildArgumentTextOfBytes(
    byteLength: number,
    filler: "a" | "é"
  ): string {
    const envelopeBytes = Buffer.byteLength('{"path":""}')
    const fillerBytes = Buffer.byteLength(filler)
    const path = filler.repeat((byteLength - envelopeBytes) / fillerBytes)
    return JSON.stringify({ path })
  }

  it("reports that what the tool reaches is unknown", () => {
    expect(readFile.access).toBe("unknown")
  })

  it("offers the model the server's input schema unchanged, frozen all the way down", () => {
    const format = readFile.buildAgentFormat()

    expect(format).toEqual({
      type: "function",
      function: {
        name: "mcp__files__read_file",
        description: "Read one file.",
        parameters: inputSchema
      }
    })
    const parameters = format.function.parameters
    const options = parameters.properties?.["options"]
    expect(Object.isFrozen(parameters)).toBe(true)
    expect(Object.isFrozen(parameters.properties)).toBe(true)
    expect(Object.isFrozen(options)).toBe(true)
  })

  it("returns arrays and objects the model sent, frozen all the way down", () => {
    const result = readFile.parseCallArguments(
      '{"path":"/notes/a.md","options":{"lines":[1,2]}}'
    )

    expect(result).toEqual({
      status: "valid",
      arguments: { path: "/notes/a.md", options: { lines: [1, 2] } }
    })
    const options =
      result.status === "valid" ? result.arguments["options"] : undefined
    expect(result.status === "valid" && Object.isFrozen(result.arguments)).toBe(
      true
    )
    expect(Object.isFrozen(options)).toBe(true)
    expect(
      typeof options === "object" &&
        options !== null &&
        "lines" in options &&
        Object.isFrozen(options.lines)
    ).toBe(true)
  })

  it("leaves the values to the server, which checks them against its schema", () => {
    expect(readFile.parseCallArguments('{"path":7,"extra":true}')).toEqual({
      status: "valid",
      arguments: { path: 7, extra: true }
    })
  })

  it("reads blank text as no arguments for a tool that requires none", () => {
    const listFiles = new AgentTool({
      name: "mcp__files__list",
      description: "List files.",
      group: "mcp",
      access: "unknown",
      runner: "mcp",
      server: "files",
      serverToolName: "list",
      inputSchema: { type: "object" }
    })

    expect(listFiles.parseCallArguments("  ")).toEqual({
      status: "valid",
      arguments: {}
    })
  })

  it("accepts argument text of exactly 256 KiB", () => {
    const argumentText = buildArgumentTextOfBytes(256 * 1024, "a")

    expect(Buffer.byteLength(argumentText)).toBe(256 * 1024)
    expect(readFile.parseCallArguments(argumentText).status).toBe("valid")
  })

  it.each([
    ["one-byte", "a", 256 * 1024 + 1],
    ["two-byte", "é", 256 * 1024 + 1]
  ] as const)(
    "refuses argument text one byte longer than 256 KiB of %s characters",
    (_label, filler, byteLength) => {
      const argumentText = buildArgumentTextOfBytes(byteLength, filler)

      expect(Buffer.byteLength(argumentText)).toBe(byteLength)

      expect(readFile.parseCallArguments(argumentText)).toEqual({
        status: "invalid",
        message:
          "The arguments for mcp__files__read_file are longer than 256 KiB."
      })
    }
  )

  it("names a required argument the model left out", () => {
    const result = readFile.parseCallArguments('{"options":{}}')

    expect(result.status).toBe("invalid")
    expect(result.status === "invalid" && result.message).toContain(
      "mcp__files__read_file"
    )
    expect(result.status === "invalid" && result.message).toContain("path")
  })

  it.each([
    ["text that is not JSON", '{"path":'],
    ["a JSON value that is not an object", '["/notes"]'],
    ["blank text while an argument is required", ""],
    ["a key outside the argument-name rule", '{"path":"/a","my-key":1}'],
    ["a __proto__ key at the top", '{"path":"/a","__proto__":{"x":1}}'],
    ["a __proto__ key deep inside", '{"path":"/a","o":{"__proto__":{}}}'],
    [
      "values nested deeper than 32 arrays and objects",
      `{"path":"/a","deep":${"[".repeat(32)}${"]".repeat(32)}}`
    ]
  ])("explains %s to the model, naming the tool", (_label, argumentText) => {
    expect(readFile.parseCallArguments(argumentText)).toEqual({
      status: "invalid",
      message: expect.stringContaining("mcp__files__read_file")
    })
  })

  it("accepts values nested exactly 32 arrays and objects deep, the arguments object included", () => {
    const argumentText = `{"path":"/a","deep":${"[".repeat(31)}${"]".repeat(31)}}`

    expect(readFile.parseCallArguments(argumentText).status).toBe("valid")
  })
})

describe("toolDefinitionSchema for an MCP tool", () => {
  const mcpDefinition = {
    name: "mcp__files__read_file",
    description: "Read one file.",
    group: "mcp",
    access: "unknown",
    runner: "mcp",
    server: "files",
    serverToolName: "read_file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      $schema: "https://json-schema.org/draft/2020-12/schema"
    }
  }

  it("keeps every keyword of the input schema", () => {
    expect(toolDefinitionSchema.parse(mcpDefinition)).toEqual(mcpDefinition)
  })

  it.each<{
    readonly problem: string
    readonly input: unknown
    readonly path: readonly (string | number)[]
  }>([
    {
      problem: "a name without the server's prefix",
      input: { ...mcpDefinition, name: "mcp__notes__read_file" },
      path: []
    },
    {
      problem: "a server name outside the server-name rule",
      input: {
        ...mcpDefinition,
        server: "My_Files",
        name: "mcp__My_Files__read_file"
      },
      path: ["server"]
    },
    {
      problem: "an empty server tool name",
      input: { ...mcpDefinition, serverToolName: "" },
      path: ["serverToolName"]
    },
    {
      problem: "a server tool name longer than 128 characters",
      input: { ...mcpDefinition, serverToolName: "a".repeat(129) },
      path: ["serverToolName"]
    },
    {
      problem: "an empty description",
      input: { ...mcpDefinition, description: "" },
      path: ["description"]
    },
    {
      problem: "a description longer than 4096 characters",
      input: { ...mcpDefinition, description: "a".repeat(4097) },
      path: ["description"]
    },
    {
      problem: "an input schema that is not an object schema",
      input: { ...mcpDefinition, inputSchema: { type: "string" } },
      path: ["inputSchema", "type"]
    },
    {
      problem: "a property name outside the argument-name rule",
      input: {
        ...mcpDefinition,
        inputSchema: { type: "object", properties: { "my-path": {} } }
      },
      path: ["inputSchema", "properties", "my-path"]
    },
    {
      problem: "a required name outside the argument-name rule",
      input: {
        ...mcpDefinition,
        inputSchema: { type: "object", required: ["1path"] }
      },
      path: ["inputSchema", "required", 0]
    },
    {
      problem: "an input schema nested deeper than 32 arrays and objects",
      input: {
        ...mcpDefinition,
        inputSchema: JSON.parse(
          `{"type":"object","x":${"[".repeat(32)}${"]".repeat(32)}}`
        ) as unknown
      },
      path: ["inputSchema"]
    },
    {
      problem: "an input schema with a __proto__ key",
      input: {
        ...mcpDefinition,
        inputSchema: JSON.parse(
          '{"type":"object","properties":{"__proto__":{"type":"string"}}}'
        ) as unknown
      },
      path: ["inputSchema"]
    },
    {
      problem: "a field the MCP variant lacks",
      input: { ...mcpDefinition, arguments: [] },
      path: []
    }
  ])("rejects $problem", ({ input, path }) => {
    const result = toolDefinitionSchema.safeParse(input)

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path)
  })

  it("rejects one of Lys's own tools whose name starts with mcp__", () => {
    const result = toolDefinitionSchema.safeParse({
      name: "mcp__files__read_file",
      description: "Read one file.",
      group: "files",
      access: "reads",
      runner: "client",
      arguments: []
    })

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["name"]])
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
    runner: "client",
    arguments: [rootArgument]
  }

  it("returns a definition that cannot be changed through any of its parts", () => {
    const definition = toolDefinitionSchema.parse({
      ...searchFilesDefinition,
      arguments: [rootArgument, targetArgument]
    })
    if (definition.runner === "mcp") throw new Error("Expected a Lys tool")
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

    if (definition.runner === "mcp") throw new Error("Expected a Lys tool")
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
      input: { ...searchFilesDefinition, group: "system" },
      issue: { code: "invalid_value", path: ["group"] }
    },
    {
      problem: "a runner that is neither the client, the backend, nor MCP",
      input: { ...searchFilesDefinition, runner: "desktop" },
      issue: { code: "invalid_union", path: ["runner"] }
    },
    {
      problem: "a definition without a runner",
      input: { ...searchFilesDefinition, runner: undefined },
      issue: { code: "invalid_union", path: ["runner"] }
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

describe("isEveryToolRunBy", () => {
  const clientTool = toolDefinitionSchema.parse({
    name: "read_text_file",
    description: "Read one text file.",
    group: "files",
    access: "reads",
    runner: "client",
    arguments: []
  })
  const backendTool = toolDefinitionSchema.parse({
    name: "read_page",
    description: "Read one web page.",
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  })

  it("answers whether one side runs every listed tool", () => {
    expect(isEveryToolRunBy([clientTool], "client")).toBe(true)
    expect(isEveryToolRunBy([backendTool], "backend")).toBe(true)
    expect(isEveryToolRunBy([clientTool, backendTool], "client")).toBe(false)
  })

  it("accepts an empty list for either side", () => {
    expect(isEveryToolRunBy([], "client")).toBe(true)
    expect(isEveryToolRunBy([], "backend")).toBe(true)
  })
})
