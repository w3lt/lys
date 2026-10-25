import { describe, expect, it } from "vitest"
import {
  formatMcpCommandArguments,
  parseMcpCommandArguments
} from "@/lib/models/mcp-command-arguments"

describe("formatMcpCommandArguments", () => {
  it("writes no arguments as an empty line", () => {
    expect(formatMcpCommandArguments([])).toBe("")
  })

  it("separates plain arguments with single spaces, without quotes", () => {
    expect(
      formatMcpCommandArguments([
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "--port=8080"
      ])
    ).toBe("-y @modelcontextprotocol/server-filesystem --port=8080")
  })

  it.each([
    ["an empty argument", "", '""'],
    ["an argument with a space", "two words", '"two words"'],
    ["an argument with a tab", "a\tb", '"a\tb"'],
    ["an argument with a single quote", "it's", `"it's"`],
    ["an argument with a double quote", 'say "hi"', String.raw`"say \"hi\""`],
    ["an argument with a backslash", String.raw`C:\tmp`, String.raw`"C:\\tmp"`],
    ["a lone backslash", "\\", String.raw`"\\"`]
  ])(
    "quotes %s, escaping its quotes and backslashes",
    (_case, argument, line) => {
      expect(formatMcpCommandArguments([argument])).toBe(line)
    }
  )

  it("quotes only the arguments that need it", () => {
    expect(formatMcpCommandArguments(["--from", "two words", "-v"])).toBe(
      '--from "two words" -v'
    )
  })
})

describe("parseMcpCommandArguments", () => {
  it.each([
    ["an empty line", ""],
    ["a line of spaces and tabs", "  \t "]
  ])("reads no argument from %s", (_case, text) => {
    expect(parseMcpCommandArguments(text)).toEqual({
      status: "parsed",
      arguments: []
    })
  })

  it("splits at runs of spaces and tabs, ignoring them at either end", () => {
    expect(parseMcpCommandArguments("  -y   pkg\t\t/tmp ")).toEqual({
      status: "parsed",
      arguments: ["-y", "pkg", "/tmp"]
    })
  })

  it.each([
    ["double quotes", '"two words"', "two words"],
    ["single quotes", "'two words'", "two words"],
    [
      "a quote inside a plain argument",
      '--name="two words"',
      "--name=two words"
    ],
    ["two quoted parts and plain characters", `a'b c'"d e"f`, "ab cd ef"],
    ["a double quote inside single quotes", `'say "hi"'`, 'say "hi"'],
    ["a single quote inside double quotes", `"it's"`, "it's"]
  ])("keeps the spaces of %s in one argument", (_case, text, argument) => {
    expect(parseMcpCommandArguments(text)).toEqual({
      status: "parsed",
      arguments: [argument]
    })
  })

  it.each([
    ["two double quotes", '-a "" -b'],
    ["two single quotes", "-a '' -b"]
  ])("reads %s as an empty argument", (_case, text) => {
    expect(parseMcpCommandArguments(text)).toEqual({
      status: "parsed",
      arguments: ["-a", "", "-b"]
    })
  })

  it.each([
    ["a double quote", String.raw`"a\"b"`, 'a"b'],
    ["a backslash", String.raw`"a\\b"`, "a\\b"],
    ["any other character, keeping the backslash", String.raw`"a\nb"`, "a\\nb"]
  ])(
    "makes a backslash inside double quotes escape %s",
    (_case, text, argument) => {
      expect(parseMcpCommandArguments(text)).toEqual({
        status: "parsed",
        arguments: [argument]
      })
    }
  )

  it("keeps every character inside single quotes as it is", () => {
    expect(parseMcpCommandArguments(`'a\\"b\\' c`)).toEqual({
      status: "parsed",
      arguments: ['a\\"b\\', "c"]
    })
  })

  it("reads a backslash outside quotes as an ordinary character", () => {
    expect(parseMcpCommandArguments(String.raw`C:\tmp a\ b`)).toEqual({
      status: "parsed",
      arguments: [String.raw`C:\tmp`, "a\\", "b"]
    })
  })

  it.each([
    ["a double quote at the start", '"abc', 1],
    ["a single quote after an argument", "-y 'abc", 4],
    ["a quote after a closed one", '"a" "b', 5],
    ["a double quote whose closing quote is escaped", String.raw`-v "a\"`, 4],
    ["a double quote ending in a backslash", '"abc\\', 1],
    ["a double quote holding a single quote", `"it's`, 1],
    ["a quote after a character outside the BMP", '😀 "abc', 3]
  ])(
    "gives the one-based position of %s left open",
    (_case, text, position) => {
      expect(parseMcpCommandArguments(text)).toEqual({
        status: "unclosed-quote",
        position
      })
    }
  )

  it("returns a frozen outcome with frozen arguments", () => {
    const parse = parseMcpCommandArguments("-y pkg")

    expect(Object.isFrozen(parse)).toBe(true)
    expect(parse.status === "parsed" && Object.isFrozen(parse.arguments)).toBe(
      true
    )
    expect(Object.isFrozen(parseMcpCommandArguments('"open'))).toBe(true)
  })
})

describe("formatMcpCommandArguments and parseMcpCommandArguments", () => {
  it.each<[string, readonly string[]]>([
    ["no argument", []],
    ["plain arguments", ["-y", "@scope/server", "/tmp"]],
    ["empty arguments", ["", "-a", ""]],
    ["spaces and tabs", [" ", " lead", "trail ", "a  b", "\t"]],
    ["quotes", ['"', "'", `it's "quoted"`, `""`, "''"]],
    [
      "backslashes",
      ["\\", "\\\\", "C:\\Program Files\\x", "end\\", String.raw`\"`]
    ],
    ["non-ASCII characters", ["café", "日本 語", "😀"]]
  ])("reads %s back unchanged", (_case, commandArguments) => {
    expect(
      parseMcpCommandArguments(formatMcpCommandArguments(commandArguments))
    ).toEqual({ status: "parsed", arguments: commandArguments })
  })
})
