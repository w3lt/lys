import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import * as z from "zod"
import AttachmentFileStore from "../../../../src/modules/attachment/attachmentFileStore"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Conversation most cases write under. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Message most cases write under. */
const MESSAGE_ID = createFixtureUuidV7(2)

/** Bytes of a notes file. */
const NOTES = new TextEncoder().encode("Buy milk\n")

/** Bytes of a second file. */
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/**
 * Creates a store over an empty directory owned by the current test.
 *
 * @returns The store and its directory, removed when the test finishes.
 */
function createOwnedStore() {
  const directory = mkdtempSync(join(tmpdir(), "lys-attachment-store-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    store: new AttachmentFileStore(directory),
    directory,
    messageFolder: join(directory, CONVERSATION_ID, MESSAGE_ID)
  }
}

/**
 * Answers whether a path exists.
 *
 * @param path - Absolute path.
 * @returns True when a file or folder is there.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe("AttachmentFileStore", () => {
  describe("saveMessageAttachments", () => {
    it("creates the message's folder under the conversation's and writes each file by its name", async () => {
      const { store, messageFolder } = createOwnedStore()

      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES },
        { name: "photo.png", content: PHOTO }
      ])

      expect((await readdir(messageFolder)).sort()).toEqual([
        "notes.md",
        "photo.png"
      ])
      expect(await readFile(join(messageFolder, "notes.md"))).toEqual(
        Buffer.from(NOTES)
      )
      expect(await readFile(join(messageFolder, "photo.png"))).toEqual(
        Buffer.from(PHOTO)
      )
    })

    it("creates the attachments directory itself on the first write", async () => {
      const { directory } = createOwnedStore()
      const store = new AttachmentFileStore(join(directory, "attachments"))

      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES }
      ])

      expect(
        await exists(
          join(
            directory,
            "attachments",
            CONVERSATION_ID,
            MESSAGE_ID,
            "notes.md"
          )
        )
      ).toBe(true)
    })

    it("writes a message without files as an empty folder", async () => {
      const { store, messageFolder } = createOwnedStore()

      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [])

      expect(await readdir(messageFolder)).toEqual([])
    })

    it("writes a file whose name is 255 bytes long", async () => {
      const { store, messageFolder } = createOwnedStore()
      const name = `${"n".repeat(252)}.md`

      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name, content: NOTES }
      ])

      expect(await readdir(messageFolder)).toEqual([name])
    })

    it("refuses a message whose folder already exists before writing a file, keeping the folder", async () => {
      const { store, messageFolder } = createOwnedStore()
      await mkdir(messageFolder, { recursive: true })
      await writeFile(join(messageFolder, "photo.png"), "already here")

      await expect(
        store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
          { name: "notes.md", content: NOTES },
          { name: "photo.png", content: PHOTO }
        ])
      ).rejects.toMatchObject({ code: "EEXIST" })

      expect(await readdir(messageFolder)).toEqual(["photo.png"])
      expect(await readFile(join(messageFolder, "photo.png"), "utf8")).toBe(
        "already here"
      )
    })

    it("deletes the message's folder and what it wrote when a file cannot be created, as when a name repeats", async () => {
      const { store, directory, messageFolder } = createOwnedStore()

      await expect(
        store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
          { name: "notes.md", content: NOTES },
          { name: "notes.md", content: PHOTO }
        ])
      ).rejects.toMatchObject({ code: "EEXIST" })

      expect(await exists(messageFolder)).toBe(false)
      expect(await readdir(join(directory, CONVERSATION_ID))).toEqual([])
    })

    it.each([
      [
        "a conversation identifier that is not a UUIDv7",
        "not-an-id",
        MESSAGE_ID
      ],
      [
        "a message identifier that is not a UUIDv7",
        CONVERSATION_ID,
        "../escape"
      ]
    ])(
      "refuses %s before touching the disk",
      async (_label, conversationId, messageId) => {
        const { store, directory } = createOwnedStore()

        await expect(
          store.saveMessageAttachments(conversationId, messageId, [
            { name: "notes.md", content: NOTES }
          ])
        ).rejects.toBeInstanceOf(z.ZodError)

        expect(await readdir(directory)).toEqual([])
      }
    )

    it.each([["../escape.md"], ["a/b.md"], ["."], [".."], [""], ["nul\0.md"]])(
      "refuses the file name %j before touching the disk",
      async (name) => {
        const { store, directory } = createOwnedStore()

        await expect(
          store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
            { name, content: NOTES }
          ])
        ).rejects.toBeInstanceOf(z.ZodError)

        expect(await readdir(directory)).toEqual([])
      }
    )
  })

  describe("readAttachment", () => {
    it("reads a stored file's bytes", async () => {
      const { store } = createOwnedStore()
      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES }
      ])

      const content = await store.readAttachment({
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        name: "notes.md"
      })

      expect(content).toEqual(Buffer.from(NOTES))
    })

    it("resolves to undefined for a file, a message, or a conversation that is not there", async () => {
      const { store } = createOwnedStore()
      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES }
      ])

      await expect(
        store.readAttachment({
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          name: "other.md"
        })
      ).resolves.toBeUndefined()
      await expect(
        store.readAttachment({
          conversationId: CONVERSATION_ID,
          messageId: createFixtureUuidV7(3),
          name: "notes.md"
        })
      ).resolves.toBeUndefined()
      await expect(
        store.readAttachment({
          conversationId: createFixtureUuidV7(4),
          messageId: MESSAGE_ID,
          name: "notes.md"
        })
      ).resolves.toBeUndefined()
    })

    it("resolves to undefined when a folder on the way is a file", async () => {
      const { store, directory } = createOwnedStore()
      await mkdir(join(directory, CONVERSATION_ID), { recursive: true })
      await writeFile(join(directory, CONVERSATION_ID, MESSAGE_ID), "a file")

      await expect(
        store.readAttachment({
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          name: "notes.md"
        })
      ).resolves.toBeUndefined()
    })

    it("refuses a name that breaks the attachment name rules before touching the disk", async () => {
      const { store } = createOwnedStore()

      await expect(
        store.readAttachment({
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          name: "../../etc/passwd"
        })
      ).rejects.toBeInstanceOf(z.ZodError)
    })
  })

  describe("deleteMessageAttachments", () => {
    it("removes the message's folder with its files and keeps the conversation's other messages", async () => {
      const { store, directory, messageFolder } = createOwnedStore()
      const otherMessageId = createFixtureUuidV7(3)
      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES },
        { name: "photo.png", content: PHOTO }
      ])
      await store.saveMessageAttachments(CONVERSATION_ID, otherMessageId, [
        { name: "kept.md", content: NOTES }
      ])

      await store.deleteMessageAttachments(CONVERSATION_ID, MESSAGE_ID)

      expect(await exists(messageFolder)).toBe(false)
      expect(await readdir(join(directory, CONVERSATION_ID))).toEqual([
        otherMessageId
      ])
      expect(
        await readFile(
          join(directory, CONVERSATION_ID, otherMessageId, "kept.md")
        )
      ).toEqual(Buffer.from(NOTES))
    })

    it("changes nothing for a message without a folder", async () => {
      const { store, directory } = createOwnedStore()

      await store.deleteMessageAttachments(CONVERSATION_ID, MESSAGE_ID)

      expect(await readdir(directory)).toEqual([])
    })

    it("refuses an identifier that is not a UUIDv7 before touching the disk", async () => {
      const { store, messageFolder } = createOwnedStore()
      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES }
      ])

      await expect(
        store.deleteMessageAttachments(CONVERSATION_ID, "..")
      ).rejects.toBeInstanceOf(z.ZodError)

      expect(await readdir(messageFolder)).toEqual(["notes.md"])
    })
  })

  describe("deleteConversationAttachments", () => {
    it("removes the conversation's folder with every message folder and file in it", async () => {
      const { store, directory } = createOwnedStore()
      const otherConversationId = createFixtureUuidV7(5)
      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES }
      ])
      await store.saveMessageAttachments(
        CONVERSATION_ID,
        createFixtureUuidV7(3),
        [{ name: "photo.png", content: PHOTO }]
      )
      await store.saveMessageAttachments(otherConversationId, MESSAGE_ID, [
        { name: "kept.md", content: NOTES }
      ])

      await store.deleteConversationAttachments(CONVERSATION_ID)

      expect(await readdir(directory)).toEqual([otherConversationId])
      expect(
        await readFile(
          join(directory, otherConversationId, MESSAGE_ID, "kept.md")
        )
      ).toEqual(Buffer.from(NOTES))
    })

    it("changes nothing for a conversation without a folder", async () => {
      const { store, directory } = createOwnedStore()

      await store.deleteConversationAttachments(CONVERSATION_ID)

      expect(await exists(directory)).toBe(true)
      expect(await readdir(directory)).toEqual([])
    })

    it("refuses an identifier that is not a UUIDv7 before touching the disk", async () => {
      const { store, directory } = createOwnedStore()
      await store.saveMessageAttachments(CONVERSATION_ID, MESSAGE_ID, [
        { name: "notes.md", content: NOTES }
      ])

      await expect(
        store.deleteConversationAttachments("..")
      ).rejects.toBeInstanceOf(z.ZodError)

      expect(await readdir(directory)).toEqual([CONVERSATION_ID])
    })
  })
})
