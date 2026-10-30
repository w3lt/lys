import { SdkErrorCode } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"
import McpToolCatalogBuilder, {
  type McpToolCatalog
} from "../../../../src/modules/mcp/mcpToolCatalog"

/** Server the catalogs are built for; its tools are named `mcp__notes__…`. */
const SERVER_NAME = "notes"

/** Input schema of a tool without arguments. */
const EMPTY_INPUT_SCHEMA = Object.freeze({ type: "object" })

/**
 * Builds the catalog of tools added one at a time, as the tool list reader
 * adds them.
 *
 * @param tools - Untrusted tools as a server lists them.
 * @returns The catalog.
 * @throws What adding a tool throws.
 */
function buildCatalog(tools: readonly unknown[]): McpToolCatalog {
  const builder = new McpToolCatalogBuilder(SERVER_NAME)
  for (const tool of tools) builder.addTool(tool)
  return builder.build()
}

/**
 * Reads tool list JSON text, keeping keys such as `__proto__` that only
 * JSON text can hold.
 *
 * @param text - Untrusted JSON text of the tool list's `tools`.
 * @returns The tools.
 */
function parseToolsText(text: string): unknown[] {
  return JSON.parse(text) as unknown[]
}

/**
 * Builds a tool without arguments.
 *
 * @param name - Name the server calls the tool by.
 * @returns The untrusted tool.
 */
function buildTool(name: string): Readonly<Record<string, unknown>> {
  return { name, description: `Runs ${name}.`, inputSchema: EMPTY_INPUT_SCHEMA }
}

/**
 * Builds objects nested in one another under the key `a`.
 *
 * @param depth - How many objects, at least 1.
 * @returns The outermost object.
 */
function buildNestedObject(depth: number): Record<string, unknown> {
  let nested: Record<string, unknown> = {}
  for (let level = 1; level < depth; level += 1) nested = { a: nested }
  return nested
}

/**
 * Builds the catalog of one tool and reads its description.
 *
 * @param tool - Untrusted tool.
 * @returns The description the catalog lists.
 * @throws When the tool is not listed.
 */
async function readListedDescription(
  tool: Readonly<Record<string, unknown>>
): Promise<string> {
  const [definition] = buildCatalog([tool]).definitions
  if (definition === undefined)
    throw new Error("Expected the tool to be listed")
  return definition.description
}

describe("McpToolCatalogBuilder", async () => {
  it("lists a tool under the server's prefix, with its schema and the MCP fields", () => {
    const inputSchema = {
      type: "object",
      properties: { path: { type: "string", description: "File path." } },
      required: ["path"],
      additionalProperties: false
    }

    const catalog = buildCatalog([
      { name: "read_note", description: "Reads one note.", inputSchema }
    ])

    expect(catalog).toEqual({
      definitions: [
        {
          name: "mcp__notes__read_note",
          description: "Reads one note.",
          group: "mcp",
          access: "unknown",
          runner: "mcp",
          server: SERVER_NAME,
          serverToolName: "read_note",
          inputSchema
        }
      ],
      skippedTools: [],
      isToolListCut: false
    })
  })

  it("keeps the server's order", () => {
    const catalog = buildCatalog([
      buildTool("zeta"),
      buildTool("alpha"),
      buildTool("mid")
    ])

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__zeta",
      "mcp__notes__alpha",
      "mcp__notes__mid"
    ])
  })

  it.each([
    ["dots and slashes", "notes.read/v2", "mcp__notes__notes_read_v2"],
    ["spaces", "read note", "mcp__notes__read_note"],
    ["a non-ASCII letter", "café", "mcp__notes__caf_"],
    ["an emoji", "go🚀", "mcp__notes__go_"],
    ["hyphens and digits", "read-note-2", "mcp__notes__read-note-2"]
  ])(
    "replaces each character outside the name rule in %s",
    (_label, serverToolName, modelName) => {
      const [definition] = buildCatalog([buildTool(serverToolName)]).definitions

      expect(definition?.name).toBe(modelName)
      expect(definition?.serverToolName).toBe(serverToolName)
    }
  )

  it("lists a tool whose model-facing name is exactly 64 characters", () => {
    const serverToolName = "t".repeat(64 - "mcp__notes__".length)

    const catalog = buildCatalog([buildTool(serverToolName)])

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      `mcp__notes__${serverToolName}`
    ])
  })

  it("skips a tool whose model-facing name is 65 characters", () => {
    const serverToolName = "t".repeat(65 - "mcp__notes__".length)

    const catalog = buildCatalog([buildTool(serverToolName)])

    expect(catalog.definitions).toEqual([])
    expect(catalog.skippedTools).toEqual([
      { name: serverToolName, reason: "unsupported-name" }
    ])
  })

  it("skips a tool with an empty name, listing it with an empty name", () => {
    const catalog = buildCatalog([buildTool("")])

    expect(catalog.definitions).toEqual([])
    expect(catalog.skippedTools).toEqual([
      { name: "", reason: "unsupported-name" }
    ])
  })

  it("skips a tool whose name is 129 characters, listing its first 128", () => {
    const serverToolName = "n".repeat(129)

    const catalog = buildCatalog([buildTool(serverToolName)])

    expect(catalog.skippedTools).toEqual([
      { name: "n".repeat(128), reason: "unsupported-name" }
    ])
  })

  it("skips a tool whose name holds characters a person cannot see, naming it without them", () => {
    const catalog = buildCatalog([
      buildTool("read\u202Efile"),
      buildTool("fi\u200Bnd"),
      buildTool("list\u{E0041}"),
      buildTool("bell\u0007")
    ])

    expect(catalog.definitions).toEqual([])
    expect(catalog.skippedTools).toEqual([
      { name: "readfile", reason: "unsupported-name" },
      { name: "find", reason: "unsupported-name" },
      { name: "list", reason: "unsupported-name" },
      { name: "bell", reason: "unsupported-name" }
    ])
  })

  it("skips a later tool with the same name as a listed one", () => {
    const catalog = buildCatalog([buildTool("search"), buildTool("search")])

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__search"
    ])
    expect(catalog.skippedTools).toEqual([
      { name: "search", reason: "duplicate-name" }
    ])
  })

  it("skips a later tool whose name matches a listed one once replaced", () => {
    const catalog = buildCatalog([
      buildTool("read_note"),
      buildTool("read.note")
    ])

    expect(
      catalog.definitions.map((definition) => definition.serverToolName)
    ).toEqual(["read_note"])
    expect(catalog.skippedTools).toEqual([
      { name: "read.note", reason: "duplicate-name" }
    ])
  })

  it("lists an input schema nested exactly 32 objects deep", () => {
    const inputSchema = { type: "object", $defs: buildNestedObject(31) }

    const catalog = buildCatalog([{ name: "deep", inputSchema }])

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__deep"
    ])
  })

  it.each([
    [
      "nests 33 objects deep",
      [
        {
          name: "bad",
          inputSchema: { type: "object", $defs: buildNestedObject(32) }
        }
      ]
    ],
    [
      "names an argument that starts with a digit",
      [
        {
          name: "bad",
          inputSchema: {
            type: "object",
            properties: { "1st": { type: "string" } }
          }
        }
      ]
    ],
    [
      "names an argument with a hyphen",
      [
        {
          name: "bad",
          inputSchema: {
            type: "object",
            properties: { "file-path": { type: "string" } }
          }
        }
      ]
    ],
    [
      "requires an argument whose name breaks the rule",
      [{ name: "bad", inputSchema: { type: "object", required: ["$path"] } }]
    ]
  ])("skips a tool whose input schema %s", (_label, tools) => {
    const catalog = buildCatalog(tools)

    expect(catalog.definitions).toEqual([])
    expect(catalog.skippedTools).toEqual([
      { name: "bad", reason: "unsupported-input-schema" }
    ])
  })

  it("skips a tool whose input schema holds a __proto__ key", () => {
    const tools = parseToolsText(
      '[{"name":"bad","inputSchema":{"type":"object","$defs":{"__proto__":{"type":"string"}}}}]'
    )

    const catalog = buildCatalog(tools)

    expect(catalog.definitions).toEqual([])
    expect(catalog.skippedTools).toEqual([
      { name: "bad", reason: "unsupported-input-schema" }
    ])
  })

  it.each([
    {
      where: "an argument's description",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Path\u200B" } }
      }
    },
    {
      where: "a nested title",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "object",
            properties: { body: { type: "string", title: "Body\u{E0049}" } }
          }
        }
      }
    },
    {
      where: "an enum value",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string", enum: ["fast\u2066", "slow"] } }
      }
    },
    {
      where: "a key outside the arguments",
      inputSchema: {
        type: "object",
        $defs: { "Note\u200D": { type: "string" } }
      }
    },
    {
      where: "a description with a control character",
      inputSchema: { type: "object", description: "Ring\u0007" }
    }
  ])(
    "skips a tool whose input schema holds a character a person cannot see in $where",
    ({ inputSchema }) => {
      const catalog = buildCatalog([{ name: "write", inputSchema }])

      expect(catalog.definitions).toEqual([])
      expect(catalog.skippedTools).toEqual([
        { name: "write", reason: "unsupported-input-schema" }
      ])
    }
  )

  it("lists an input schema whose text holds joined and styled emoji, tabs, and line breaks", () => {
    const inputSchema = {
      type: "object",
      properties: {
        mood: {
          type: "string",
          description: "First line\n\tsecond line",
          enum: ["👩\u200D💻", "❤\uFE0F"]
        }
      }
    }

    const catalog = buildCatalog([{ name: "write", inputSchema }])

    expect(catalog.skippedTools).toEqual([])
    expect(catalog.definitions.map((tool) => tool.inputSchema)).toEqual([
      inputSchema
    ])
  })

  it("lists an input schema of exactly 64 KiB as JSON", () => {
    const emptySchemaText =
      '{"type":"object","properties":{"a":{"type":"string","description":""}}}'
    const padding = "x".repeat(64 * 1024 - emptySchemaText.length)
    const inputSchema = {
      type: "object",
      properties: { a: { type: "string", description: padding } }
    }

    const catalog = buildCatalog([{ name: "large", inputSchema }])

    expect(catalog.skippedTools).toEqual([])
    expect(catalog.definitions).toHaveLength(1)
  })

  it("skips an input schema one byte over 64 KiB as JSON", () => {
    const emptySchemaText =
      '{"type":"object","properties":{"a":{"type":"string","description":""}}}'
    const padding = "x".repeat(64 * 1024 + 1 - emptySchemaText.length)
    const inputSchema = {
      type: "object",
      properties: { a: { type: "string", description: padding } }
    }

    const catalog = buildCatalog([{ name: "large", inputSchema }])

    expect(catalog.definitions).toEqual([])
    expect(catalog.skippedTools).toEqual([
      { name: "large", reason: "input-schema-too-large" }
    ])
  })

  it("measures the input schema in UTF-8 bytes, not characters", () => {
    const inputSchema = {
      type: "object",
      properties: { a: { type: "string", description: "é".repeat(33_000) } }
    }

    const catalog = buildCatalog([{ name: "large", inputSchema }])

    expect(catalog.skippedTools).toEqual([
      { name: "large", reason: "input-schema-too-large" }
    ])
  })

  it("lists every tool but the skipped ones", () => {
    const catalog = buildCatalog([
      buildTool("first"),
      buildTool(""),
      buildTool("second"),
      buildTool("first")
    ])

    expect(
      catalog.definitions.map((definition) => definition.serverToolName)
    ).toEqual(["first", "second"])
    expect(catalog.skippedTools).toEqual([
      { name: "", reason: "unsupported-name" },
      { name: "first", reason: "duplicate-name" }
    ])
  })

  it("reads 128 tools and says the list is not cut", () => {
    const tools = Array.from({ length: 128 }, (_, index) =>
      buildTool(`tool${index}`)
    )

    const catalog = buildCatalog(tools)

    expect(catalog.definitions).toHaveLength(128)
    expect(catalog.isToolListCut).toBe(false)
  })

  it("reads only the first 128 of 129 tools and says the list is cut", () => {
    const tools = [
      ...Array.from({ length: 128 }, (_, index) => buildTool(`tool${index}`)),
      buildTool("")
    ]

    const catalog = buildCatalog(tools)

    expect(catalog.definitions).toHaveLength(128)
    expect(catalog.definitions.at(-1)?.serverToolName).toBe("tool127")
    expect(catalog.skippedTools).toEqual([])
    expect(catalog.isToolListCut).toBe(true)
  })

  it("uses the tool's description", async () => {
    expect(
      await readListedDescription({
        name: "find",
        description: "Finds notes.",
        title: "Find",
        annotations: { title: "Find notes" },
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe("Finds notes.")
  })

  it("uses the title when the description is blank once cleaned", async () => {
    expect(
      await readListedDescription({
        name: "find",
        description: " ​⁠ ",
        title: "Find",
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe("Find")
  })

  it("uses the annotations' title when there is no description or title", async () => {
    expect(
      await readListedDescription({
        name: "find",
        annotations: { title: "Find notes" },
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe("Find notes")
  })

  it("uses a sentence naming the tool and the server when nothing else describes it", async () => {
    expect(
      await readListedDescription({
        name: "find",
        description: "",
        title: "   ",
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe("Tool find of the MCP server notes.")
  })

  it("cleans invisible characters out of the description and trims it", async () => {
    expect(
      await readListedDescription({
        name: "find",
        description: "  Finds\u200B notes\u202E.\u{E0041}  ",
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe("Finds notes.")
  })

  it("keeps a description of exactly 4096 characters", async () => {
    const description = "d".repeat(4096)

    expect(
      await readListedDescription({
        name: "find",
        description,
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe(description)
  })

  it("cuts a longer description to 4096 characters ending with an ellipsis", async () => {
    expect(
      await readListedDescription({
        name: "find",
        description: "d".repeat(5000),
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe(`${"d".repeat(4095)}…`)
  })

  it("never splits a character when it cuts the description", async () => {
    expect(
      await readListedDescription({
        name: "find",
        description: `${"d".repeat(4094)}😀${"d".repeat(10)}`,
        inputSchema: EMPTY_INPUT_SCHEMA
      })
    ).toBe(`${"d".repeat(4094)}…`)
  })

  it("lists a skipped tool's long name cut to 128 characters without splitting a character", () => {
    const catalog = buildCatalog([buildTool(`${"n".repeat(127)}😀n`)])

    expect(catalog.skippedTools).toEqual([
      { name: "n".repeat(127), reason: "unsupported-name" }
    ])
  })

  it("returns a catalog frozen all the way down", () => {
    const catalog = buildCatalog([
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      },
      buildTool("")
    ])
    const [definition] = catalog.definitions

    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.definitions)).toBe(true)
    expect(Object.isFrozen(catalog.skippedTools)).toBe(true)
    expect(Object.isFrozen(catalog.skippedTools[0])).toBe(true)
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition?.inputSchema)).toBe(true)
    expect(Object.isFrozen(definition?.inputSchema.properties)).toBe(true)
    expect(Object.isFrozen(definition?.inputSchema.properties?.["path"])).toBe(
      true
    )
    expect(Object.isFrozen(definition?.inputSchema.required)).toBe(true)
  })

  it("skips a tool whose input schema nests 10,000 objects deep without exhausting the stack, listing the others", () => {
    const deepSchema = parseToolsText(
      `[${'{"type":"object","properties":{"a":'.repeat(10_000)}{"type":"object"}${"}}".repeat(10_000)}]`
    )[0]

    const catalog = buildCatalog([
      { name: "deep", inputSchema: deepSchema },
      buildTool("shallow")
    ])

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__shallow"
    ])
    expect(catalog.skippedTools).toEqual([
      { name: "deep", reason: "unsupported-input-schema" }
    ])
  })

  it("checks a tool with an input schema too deep for its name first", () => {
    const catalog = buildCatalog([
      {
        name: "",
        inputSchema: { type: "object", $defs: buildNestedObject(40) }
      }
    ])

    expect(catalog.skippedTools).toEqual([
      { name: "", reason: "unsupported-name" }
    ])
  })

  it("lists a tool whose output schema nests 10,000 objects deep", () => {
    const catalog = buildCatalog([
      {
        ...buildTool("report"),
        outputSchema: {
          type: "object",
          properties: { a: buildNestedObject(10_000) }
        }
      }
    ])

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__report"
    ])
  })

  it.each([
    ["without an input schema", { name: "bare" }],
    ["whose name is not text", { name: 7, inputSchema: EMPTY_INPUT_SCHEMA }],
    ["that is not an object", "tool"]
  ])(
    "refuses a tool %s as an invalid result, as the SDK's MCP tool schema does",
    (_label, tool) => {
      expect(() => buildCatalog([tool])).toThrow(
        expect.objectContaining({ code: SdkErrorCode.InvalidResult })
      )
    }
  )

  it("marks the list as cut at a tool past the 128 it holds, without checking that tool", () => {
    const builder = new McpToolCatalogBuilder(SERVER_NAME)
    for (let index = 0; index < 128; index += 1)
      builder.addTool(buildTool(`tool${String(index)}`))
    expect(builder.isToolListCut).toBe(false)

    builder.addTool("not a tool")

    expect(builder.isToolListCut).toBe(true)
    expect(builder.build().definitions).toHaveLength(128)
  })

  it("builds a catalog that later additions do not change", () => {
    const builder = new McpToolCatalogBuilder(SERVER_NAME)
    builder.addTool(buildTool("first"))
    const catalog = builder.build()

    builder.addTool(buildTool("second"))

    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      "mcp__notes__first"
    ])
  })

  it("lists nothing for a server without tools", () => {
    expect(buildCatalog([])).toEqual({
      definitions: [],
      skippedTools: [],
      isToolListCut: false
    })
  })
})
