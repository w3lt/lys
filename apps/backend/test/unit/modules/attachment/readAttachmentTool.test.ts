import { describe, expect, it, vi } from "vitest"
import type { BuiltInToolCallArguments } from "../../../../src/modules/tool/builtIn/builtInTool"
import ReadAttachmentTool, {
  buildReadAttachmentDefinition,
  listReadableAttachments,
  MAXIMUM_READ_CHARACTERS,
  MAXIMUM_READ_LINE_COUNT,
  READ_ATTACHMENT_TOOL_NAME,
  type ReadableAttachment,
  type ReadAttachmentFile
} from "../../../../src/modules/attachment/readAttachmentTool"
import {
  createImageAttachment,
  createTextAttachment
} from "../../support/attachmentFixtures"
import {
  createRecordedRunContext,
  registerBuiltInToolContractSuite,
  type BuiltInToolHarness
} from "../../support/builtInToolContract"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createTextPart,
  createUserMessage
} from "../../support/conversationFixtures"

/** Conversation every readable attachment of these cases belongs to. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Message the notes file was attached to. */
const NOTES_MESSAGE_ID = createFixtureUuidV7(2)

/** Message the photo was attached to. */
const PHOTO_MESSAGE_ID = createFixtureUuidV7(4)

/** Text of the notes file: three lines, 30 bytes, ended by a line break. */
const NOTES_TEXT = "Buy milk\nCall mum\nWrite tests\n"

/** The notes file, attachment 1 of the conversation. */
const NOTES: ReadableAttachment = Object.freeze({
  attachment: createTextAttachment(1, "notes.md", NOTES_TEXT.length),
  location: {
    conversationId: CONVERSATION_ID,
    messageId: NOTES_MESSAGE_ID,
    name: "notes.md"
  }
})

/** A photo, attachment 2 of the conversation. */
const PHOTO: ReadableAttachment = Object.freeze({
  attachment: createImageAttachment(2, "photo.png"),
  location: {
    conversationId: CONVERSATION_ID,
    messageId: PHOTO_MESSAGE_ID,
    name: "photo.png"
  }
})

/** Files of the conversation by their name, as a reader finds them. */
const FILES: ReadonlyMap<string, string> = new Map([["notes.md", NOTES_TEXT]])

/**
 * Creates a reader over fixed file texts that counts its reads.
 *
 * @param files - Text of each file by name; a name absent here is missing.
 * @returns The reader and the count of reads it started.
 */
function createFileReader(files: ReadonlyMap<string, string> = FILES) {
  let readCount = 0
  const readAttachmentFile = vi.fn<ReadAttachmentFile>(async (location) => {
    readCount += 1
    const text = files.get(location.name)
    return text === undefined ? undefined : new TextEncoder().encode(text)
  })
  return { readAttachmentFile, countReads: () => readCount }
}

/**
 * Runs one call of a tool over the conversation's attachments.
 *
 * @param tool - Tool under test.
 * @param callArguments - Arguments of the call.
 * @returns The run's result.
 * @throws If the arguments are not runnable.
 */
async function runRead(
  tool: ReadAttachmentTool,
  callArguments: BuiltInToolCallArguments
) {
  const parsed = tool.parseToolCall(callArguments)
  if (parsed.status !== "parsed") throw new Error(parsed.message)
  return await parsed.runToolCall(
    createRecordedRunContext(new AbortController().signal).context
  )
}

/**
 * Builds a file of numbered lines.
 *
 * @param lineCount - Number of lines.
 * @param lineLength - Length of each line, padded with dots.
 * @returns The text without a trailing line break.
 */
function createNumberedLines(lineCount: number, lineLength = 6): string {
  return Array.from({ length: lineCount }, (_, index) =>
    `L${index + 1}`.padEnd(lineLength, ".")
  ).join("\n")
}

describe("buildReadAttachmentDefinition", () => {
  it("defines a backend tool that reads this machine, with the attachment number and optional line arguments", () => {
    const definition = buildReadAttachmentDefinition()

    expect(definition).toMatchObject({
      name: READ_ATTACHMENT_TOOL_NAME,
      group: "files",
      access: "reads",
      runner: "backend",
      arguments: [
        { type: "integer", name: "number", required: true },
        { type: "integer", name: "start_line", required: false },
        { type: "integer", name: "line_count", required: false }
      ]
    })
    expect(definition.description).toContain("200 lines")
    expect(definition.description).toContain("16,000 characters")
    expect(Object.isFrozen(definition)).toBe(true)
  })
})

describe("listReadableAttachments", () => {
  it("lists each user message's attachments with their file locations, in order, skipping replies", () => {
    const messages = [
      createUserMessage(2, "Notes", [NOTES.attachment]),
      createAssistantMessage(
        3,
        [createTextPart({ sequence: 13, round: 0, content: "Read." })],
        { status: "completed", finishReason: "stop" }
      ),
      createUserMessage(4, "Photo", [PHOTO.attachment]),
      createUserMessage(5, "Nothing")
    ]

    expect(listReadableAttachments(CONVERSATION_ID, messages)).toEqual([
      NOTES,
      PHOTO
    ])
  })
})

describe("ReadAttachmentTool", () => {
  registerBuiltInToolContractSuite(async (): Promise<BuiltInToolHarness> => {
    const reader = createFileReader()
    return {
      tool: new ReadAttachmentTool([NOTES, PHOTO], reader.readAttachmentFile),
      runnableArguments: { number: 1 },
      invalidArguments: { number: 7 },
      countStartedWork: reader.countReads
    }
  })

  it("returns a file's lines from the first by default, with a header naming the attachment, its line count, and its size", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES, PHOTO],
      createFileReader().readAttachmentFile
    )

    const result = await runRead(tool, { number: 1 })

    expect(result).toEqual({
      status: "succeeded",
      content:
        "[attachment 1] notes.md, lines 1–3 of 3 (30 bytes).\nBuy milk\nCall mum\nWrite tests",
      sources: []
    })
  })

  it("reads the file through its stored location, never a path of the model's", async () => {
    const reader = createFileReader()
    const tool = new ReadAttachmentTool(
      [NOTES, PHOTO],
      reader.readAttachmentFile
    )

    await runRead(tool, { number: 1, path: "/etc/passwd" })

    expect(reader.readAttachmentFile).toHaveBeenCalledExactlyOnceWith(
      NOTES.location
    )
  })

  it("returns the requested lines and says how to continue when lines follow", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader().readAttachmentFile
    )

    const result = await runRead(tool, {
      number: 1,
      start_line: 2,
      line_count: 1
    })

    expect(result).toEqual({
      status: "succeeded",
      content:
        "[attachment 1] notes.md, lines 2–2 of 3 (30 bytes). Call read_attachment with start_line 3 to continue.\nCall mum",
      sources: []
    })
  })

  it("keeps Windows line breaks out of the lines and counts an unterminated last line", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(new Map([["notes.md", "one\r\ntwo\r\nthree"]]))
        .readAttachmentFile
    )

    const result = await runRead(tool, { number: 1 })

    expect(result.content).toBe(
      "[attachment 1] notes.md, lines 1–3 of 3 (30 bytes).\none\ntwo\nthree"
    )
  })

  it("returns at most the line limit per call, lowering a larger request to it", async () => {
    const lineCount = MAXIMUM_READ_LINE_COUNT + 5
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(new Map([["notes.md", createNumberedLines(lineCount)]]))
        .readAttachmentFile
    )

    const result = await runRead(tool, { number: 1, line_count: 1_000 })

    const [header, ...lines] = result.content.split("\n")
    expect(header).toBe(
      `[attachment 1] notes.md, lines 1–${MAXIMUM_READ_LINE_COUNT} of ${lineCount} (30 bytes). Call read_attachment with start_line ${MAXIMUM_READ_LINE_COUNT + 1} to continue.`
    )
    expect(lines).toHaveLength(MAXIMUM_READ_LINE_COUNT)
    expect(lines.at(-1)).toBe(`L${MAXIMUM_READ_LINE_COUNT}`.padEnd(6, "."))
  })

  it("cuts the response before the line that would pass the character limit and says so", async () => {
    const lineLength = 7_000
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(
        new Map([["notes.md", createNumberedLines(4, lineLength)]])
      ).readAttachmentFile
    )

    const result = await runRead(tool, { number: 1 })

    const [header, ...lines] = result.content.split("\n")
    expect(header).toBe(
      `[attachment 1] notes.md, lines 1–2 of 4 (30 bytes). The response was cut at ${MAXIMUM_READ_CHARACTERS.toLocaleString("en-US")} characters. Call read_attachment with start_line 3 to continue.`
    )
    expect(lines.map((line) => line.length)).toEqual([lineLength, lineLength])
  })

  it("cuts a first line longer than the character limit to the limit, says the rest of that line cannot be read, and points at the next line", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(
        new Map([
          ["notes.md", `${"x".repeat(MAXIMUM_READ_CHARACTERS + 10)}\nshort`]
        ])
      ).readAttachmentFile
    )

    const result = await runRead(tool, { number: 1, start_line: 1 })

    const [header, line] = result.content.split("\n")
    expect(header).toBe(
      `[attachment 1] notes.md, lines 1–1 of 2 (30 bytes). Line 1 was cut at ${MAXIMUM_READ_CHARACTERS.toLocaleString("en-US")} characters; the rest of it cannot be read. Call read_attachment with start_line 2 to continue.`
    )
    expect(line).toHaveLength(MAXIMUM_READ_CHARACTERS)
  })

  it("names the cut line by its number in the file and omits the continuation for the last line", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(
        new Map([
          ["notes.md", `short\n${"x".repeat(MAXIMUM_READ_CHARACTERS + 10)}`]
        ])
      ).readAttachmentFile
    )

    const result = await runRead(tool, { number: 1, start_line: 2 })

    expect(result.content.split("\n")[0]).toBe(
      `[attachment 1] notes.md, lines 2–2 of 2 (30 bytes). Line 2 was cut at ${MAXIMUM_READ_CHARACTERS.toLocaleString("en-US")} characters; the rest of it cannot be read.`
    )
  })

  it("cuts a long line one code unit short of the limit rather than splitting a surrogate pair", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(
        new Map([
          [
            "notes.md",
            `${"x".repeat(MAXIMUM_READ_CHARACTERS - 1)}😀${"y".repeat(10)}`
          ]
        ])
      ).readAttachmentFile
    )

    const result = await runRead(tool, { number: 1 })

    const [, line] = result.content.split("\n")
    expect(line).toBe("x".repeat(MAXIMUM_READ_CHARACTERS - 1))
  })

  it("reports an empty file as empty", async () => {
    const tool = new ReadAttachmentTool(
      [{ ...NOTES, attachment: createTextAttachment(1, "notes.md", 0) }],
      createFileReader(new Map([["notes.md", ""]])).readAttachmentFile
    )

    expect(await runRead(tool, { number: 1 })).toEqual({
      status: "succeeded",
      content: "[attachment 1] notes.md is empty (0 bytes).",
      sources: []
    })
  })

  it("fails a start line past the end with the file's line count", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader().readAttachmentFile
    )

    expect(await runRead(tool, { number: 1, start_line: 4 })).toEqual({
      status: "failed",
      content:
        "Lys could not read [attachment 1] notes.md: it has 3 lines, so there is no line 4."
    })
  })

  it("fails a read of a file missing from this machine", async () => {
    const tool = new ReadAttachmentTool(
      [NOTES],
      createFileReader(new Map()).readAttachmentFile
    )

    expect(await runRead(tool, { number: 1 })).toEqual({
      status: "failed",
      content:
        "Lys could not read [attachment 1] notes.md: its file is missing from this machine."
    })
  })

  it("rejects with the reader's failure for a file that cannot be read", async () => {
    const failure = new Error("EACCES")
    const tool = new ReadAttachmentTool([NOTES], () => Promise.reject(failure))

    await expect(runRead(tool, { number: 1 })).rejects.toBe(failure)
  })

  it("rejects with the abort reason when stopped while the file is read", async () => {
    const abortController = new AbortController()
    const stopReason = new Error("stopped")
    const tool = new ReadAttachmentTool([NOTES], async () => {
      abortController.abort(stopReason)
      return new TextEncoder().encode(NOTES_TEXT)
    })
    const parsed = tool.parseToolCall({ number: 1 })
    if (parsed.status !== "parsed") throw new Error("Expected a parsed call")

    await expect(
      parsed.runToolCall(
        createRecordedRunContext(abortController.signal).context
      )
    ).rejects.toBe(stopReason)
  })

  describe("arguments it cannot run", () => {
    it.each([
      [
        "a number no attachment has",
        { number: 3 },
        "No attachment has the number 3. The attachments of this conversation are: [attachment 1] notes.md, [attachment 2] photo.png."
      ],
      [
        "a number that is not a number",
        { number: "1" },
        "No attachment has the number 1. The attachments of this conversation are: [attachment 1] notes.md, [attachment 2] photo.png."
      ],
      [
        "an image",
        { number: 2 },
        "[attachment 2] photo.png is an image, which you see with the message it was attached to; read_attachment reads text files only."
      ],
      [
        "a start line below 1",
        { number: 1, start_line: 0 },
        "The start_line argument must be a whole number of at least 1."
      ],
      [
        "a fractional line count",
        { number: 1, line_count: 1.5 },
        "The line_count argument must be a whole number of at least 1."
      ]
    ] as const)(
      "explains %s without reading anything",
      (_label, callArguments, message) => {
        const reader = createFileReader()
        const tool = new ReadAttachmentTool(
          [NOTES, PHOTO],
          reader.readAttachmentFile
        )

        expect(tool.parseToolCall(callArguments)).toEqual({
          status: "invalid",
          message
        })
        expect(reader.countReads()).toBe(0)
      }
    )

    it("lists no attachment for a conversation without any", () => {
      const tool = new ReadAttachmentTool(
        [],
        createFileReader().readAttachmentFile
      )

      expect(tool.parseToolCall({ number: 1 })).toEqual({
        status: "invalid",
        message:
          "No attachment has the number 1. This conversation has no attachments."
      })
    })
  })
})
