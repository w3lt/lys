import { describe, expect, it } from "vitest"
import {
  createComposerAttachment,
  removeComposerAttachment,
  stageComposerFiles,
  stagePastedText
} from "@/components/ComposerComponents/composer-attachments"

/**
 * Builds a file the user could choose, drop, or paste.
 *
 * @param name - File name.
 * @param sizeBytes - Size of its ASCII content in bytes.
 * @returns The file.
 */
function buildFile(name: string, sizeBytes = 8): File {
  return new File(["x".repeat(sizeBytes)], name)
}

/**
 * Builds files named `file-1.txt` onward.
 *
 * @param count - Number of files.
 * @param firstNumber - Number in the first file's name.
 * @returns The files in name order.
 */
function buildNumberedFiles(count: number, firstNumber = 1): File[] {
  return Array.from({ length: count }, (_, index) =>
    buildFile(`file-${firstNumber + index}.txt`)
  )
}

/**
 * Lists the names staged in a tray, in order.
 *
 * @param tray - Staged attachments.
 * @returns Their names.
 */
function listNames(tray: readonly { readonly name: string }[]): string[] {
  return tray.map((attachment) => attachment.name)
}

describe("createComposerAttachment", () => {
  it("names the chip after the file and estimates its tokens from its size", () => {
    expect(createComposerAttachment("notes.md", 4000)).toMatchObject({
      name: "notes.md",
      kind: "md",
      estimatedTokens: 1000
    })
  })

  it.each([
    ["photo.JPEG", "jpeg"],
    ["archive.tar.gz", "gz"],
    ["table.parquet", "parq"],
    ["README", "txt"],
    [".bashrc", "txt"],
    ["draft.", "txt"]
  ])("marks %s with the kind %s", (fileName, kind) => {
    expect(createComposerAttachment(fileName, 10).kind).toBe(kind)
  })

  it("gives each staged file its own identity, even for the same file", () => {
    const first = createComposerAttachment("notes.md", 10)
    const second = createComposerAttachment("notes.md", 10)

    expect(first.id).not.toBe(second.id)
  })
})

describe("stageComposerFiles", () => {
  it("adds the selected files after the staged ones, in selection order", () => {
    const staged = stageComposerFiles([], [buildFile("a.txt")])

    const tray = stageComposerFiles(staged, [
      buildFile("b.md"),
      buildFile("c.ts")
    ])

    expect(listNames(tray)).toEqual(["a.txt", "b.md", "c.ts"])
    expect(tray[0]).toBe(staged[0])
  })

  it("accepts at most six files from one selection", () => {
    const tray = stageComposerFiles([], buildNumberedFiles(7))

    expect(listNames(tray)).toEqual(listNames(buildNumberedFiles(6)))
  })

  it("keeps the eight newest files, dropping the oldest", () => {
    const staged = stageComposerFiles([], buildNumberedFiles(6))

    const tray = stageComposerFiles(staged, buildNumberedFiles(4, 7))

    expect(listNames(tray)).toEqual(listNames(buildNumberedFiles(8, 3)))
  })

  it("returns the same tray when nothing was selected", () => {
    const staged = stageComposerFiles([], [buildFile("a.txt")])

    expect(stageComposerFiles(staged, [])).toBe(staged)
  })
})

describe("stagePastedText", () => {
  it("stages a paste as a text file sized by its length", () => {
    const tray = stagePastedText([], "x".repeat(1200))

    expect(tray).toEqual([
      expect.objectContaining({
        name: "pasted-1.txt",
        kind: "txt",
        estimatedTokens: 300
      })
    ])
  })

  it("numbers pastes in staging order beside chosen files", () => {
    const withFile = stageComposerFiles([], [buildFile("a.txt")])

    const tray = stagePastedText(
      stagePastedText(withFile, "x".repeat(1200)),
      "y".repeat(1300)
    )

    expect(listNames(tray)).toEqual(["a.txt", "pasted-1.txt", "pasted-2.txt"])
  })

  it("keeps the eight newest entries when a paste overfills the tray", () => {
    const staged = stagePastedText(
      stageComposerFiles(stageComposerFiles([], buildNumberedFiles(6)), [
        buildFile("file-7.txt"),
        buildFile("file-8.txt")
      ]),
      "x".repeat(1200)
    )

    expect(staged).toHaveLength(8)
    expect(listNames(staged)[0]).toBe("file-2.txt")
    expect(listNames(staged).at(-1)).toBe("pasted-1.txt")
  })

  // Known defect, tracked by #105 ("Pasted text always gets a name that is
  // not already staged"): numbering counts the staged pastes, so removing an
  // earlier paste makes the next one reuse a name still in the tray.
  it.fails("never reuses the name of a paste still in the tray (#105)", () => {
    const twoPastes = stagePastedText(
      stagePastedText([], "x".repeat(1200)),
      "y".repeat(1200)
    )
    const withoutFirst = removeComposerAttachment(twoPastes, twoPastes[0].id)

    const tray = stagePastedText(withoutFirst, "z".repeat(1200))

    expect(new Set(listNames(tray)).size).toBe(tray.length)
  })
})

describe("removeComposerAttachment", () => {
  it("removes only the attachment with the identity, keeping the order of the rest", () => {
    const tray = stageComposerFiles(
      [],
      [buildFile("a.txt"), buildFile("b.txt"), buildFile("c.txt")]
    )

    const remaining = removeComposerAttachment(tray, tray[1].id)

    expect(remaining).toEqual([tray[0], tray[2]])
  })

  it("keeps every attachment when the identity is not staged", () => {
    const tray = stageComposerFiles([], [buildFile("a.txt")])

    expect(removeComposerAttachment(tray, "attachment-missing")).toEqual(tray)
  })
})
