import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import JsonFileLysLlmInstanceStore, {
  MAXIMUM_LOADED_MODELS_FILE_BYTES
} from "../../../../src/modules/llm/jsonFileLysLlmInstanceStore"
import { registerLysLlmInstanceStoreContractSuite } from "../../support/lysLlmInstanceStoreContract"

/** Name of the file in its directory. */
const FILE_NAME = "loaded_models.json"

/**
 * Creates a new temporary directory, removed with everything in it when the
 * current test finishes.
 *
 * @returns Absolute path of the directory.
 */
async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lys-loaded-models-"))
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

/**
 * Writes the file in a new temporary directory.
 *
 * @param contents - Exact text or bytes of the file.
 * @returns Absolute path of the file.
 */
async function writeLoadedModelsFile(
  contents: string | Uint8Array
): Promise<string> {
  const path = join(await createDirectory(), FILE_NAME)
  await writeFile(path, contents)
  return path
}

/**
 * Builds a valid file of an exact size by padding a document with spaces,
 * which JSON allows after the value.
 *
 * @param sizeBytes - Size of the file in bytes.
 * @returns The file's text.
 */
function buildPaddedFileText(sizeBytes: number): string {
  const document = '{"version":1,"instanceIdentifiers":["a/model@lys-000001"]}'
  return document.padEnd(sizeBytes, " ")
}

describe("JsonFileLysLlmInstanceStore", () => {
  registerLysLlmInstanceStoreContractSuite(async () => {
    const directory = await createDirectory()
    return new JsonFileLysLlmInstanceStore(join(directory, FILE_NAME))
  })

  it("saves a version 1 document with the identifiers sorted", async () => {
    const path = join(await createDirectory(), FILE_NAME)
    const store = new JsonFileLysLlmInstanceStore(path)

    await store.saveLysLlmInstanceIdentifiers(
      new Set(["b/model@lys-000002", "a/model@lys-000001"])
    )

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      instanceIdentifiers: ["a/model@lys-000001", "b/model@lys-000002"]
    })
  })

  it("reads what an earlier store saved, as after a restart", async () => {
    const path = join(await createDirectory(), FILE_NAME)
    await new JsonFileLysLlmInstanceStore(path).saveLysLlmInstanceIdentifiers(
      new Set(["a/model@lys-000001"])
    )

    await expect(
      new JsonFileLysLlmInstanceStore(path).readLysLlmInstanceIdentifiers()
    ).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a/model@lys-000001"])
    })
  })

  it("reads a repeated identifier once", async () => {
    const path = await writeLoadedModelsFile(
      '{"version":1,"instanceIdentifiers":["a@lys-000001","a@lys-000001"]}'
    )

    await expect(
      new JsonFileLysLlmInstanceStore(path).readLysLlmInstanceIdentifiers()
    ).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a@lys-000001"])
    })
  })

  it("reads a file of exactly the size limit", async () => {
    const path = await writeLoadedModelsFile(
      buildPaddedFileText(MAXIMUM_LOADED_MODELS_FILE_BYTES)
    )

    await expect(
      new JsonFileLysLlmInstanceStore(path).readLysLlmInstanceIdentifiers()
    ).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a/model@lys-000001"])
    })
  })

  it.each([
    [
      "is one byte over the size limit",
      buildPaddedFileText(MAXIMUM_LOADED_MODELS_FILE_BYTES + 1),
      "The loaded models file is larger than 65536 bytes."
    ],
    [
      "is not UTF-8",
      Uint8Array.from([0x7b, 0xff, 0x7d]),
      "The loaded models file is not UTF-8."
    ],
    [
      "is not JSON",
      "secret-looking text",
      "The loaded models file is not JSON."
    ],
    [
      "has another version",
      '{"version":2,"instanceIdentifiers":[]}',
      "The loaded models file has a version this backend cannot read."
    ],
    [
      "has a version that is not a number",
      '{"version":"1","instanceIdentifiers":[]}',
      "The loaded models file has a version this backend cannot read."
    ],
    [
      "has no version",
      '{"instanceIdentifiers":[]}',
      "The loaded models file has a version this backend cannot read."
    ],
    [
      "is a JSON array",
      "[]",
      "The loaded models file has a version this backend cannot read."
    ],
    [
      "is JSON null",
      "null",
      "The loaded models file has a version this backend cannot read."
    ],
    [
      "has an unknown field",
      '{"version":1,"instanceIdentifiers":[],"extra":true}',
      "The loaded models file does not match its version 1 format."
    ],
    [
      "has no identifier list",
      '{"version":1}',
      "The loaded models file does not match its version 1 format."
    ],
    [
      "has an empty identifier",
      '{"version":1,"instanceIdentifiers":[""]}',
      "The loaded models file does not match its version 1 format."
    ],
    [
      "has an identifier that is not a string",
      '{"version":1,"instanceIdentifiers":[7]}',
      "The loaded models file does not match its version 1 format."
    ]
  ])(
    "reads a file that %s as unreadable, without quoting it",
    async (_case, contents, message) => {
      const path = await writeLoadedModelsFile(contents)

      await expect(
        new JsonFileLysLlmInstanceStore(path).readLysLlmInstanceIdentifiers()
      ).resolves.toEqual({ status: "unreadable", message })
    }
  )

  it("reads a directory at the path as unreadable", async () => {
    const path = join(await createDirectory(), FILE_NAME)
    await mkdir(path)

    await expect(
      new JsonFileLysLlmInstanceStore(path).readLysLlmInstanceIdentifiers()
    ).resolves.toEqual({
      status: "unreadable",
      message: "The loaded models file cannot be read."
    })
  })

  it("leaves an unreadable file as it is when reading it", async () => {
    const path = await writeLoadedModelsFile("not json")

    await new JsonFileLysLlmInstanceStore(path).readLysLlmInstanceIdentifiers()

    await expect(readFile(path, "utf8")).resolves.toBe("not json")
  })

  it("leaves no temporary file after a save, replacing one left by an interrupted save", async () => {
    const directory = await createDirectory()
    const path = join(directory, FILE_NAME)
    await writeFile(`${path}.tmp`, "left by an interrupted save")

    await new JsonFileLysLlmInstanceStore(path).saveLysLlmInstanceIdentifiers(
      new Set(["a/model@lys-000001"])
    )

    await expect(readdir(directory)).resolves.toEqual([FILE_NAME])
  })

  it("keeps the earlier file whole when the save cannot write", async () => {
    const directory = await createDirectory()
    const path = join(directory, FILE_NAME)
    const store = new JsonFileLysLlmInstanceStore(path)
    await store.saveLysLlmInstanceIdentifiers(new Set(["a/model@lys-000001"]))
    await mkdir(`${path}.tmp`)

    await expect(
      store.saveLysLlmInstanceIdentifiers(new Set())
    ).rejects.toThrow()

    await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a/model@lys-000001"])
    })
  })

  it("rejects a save into a directory that does not exist, creating nothing", async () => {
    const directory = await createDirectory()
    const path = join(directory, "missing", FILE_NAME)

    await expect(
      new JsonFileLysLlmInstanceStore(path).saveLysLlmInstanceIdentifiers(
        new Set()
      )
    ).rejects.toThrow()

    await expect(readdir(directory)).resolves.toEqual([])
  })

  it("rejects saving a record larger than a read accepts, leaving the file as it was", async () => {
    const path = join(await createDirectory(), FILE_NAME)
    const store = new JsonFileLysLlmInstanceStore(path)
    await store.saveLysLlmInstanceIdentifiers(new Set(["a/model@lys-000001"]))

    await expect(
      store.saveLysLlmInstanceIdentifiers(
        new Set(["x".repeat(MAXIMUM_LOADED_MODELS_FILE_BYTES)])
      )
    ).rejects.toThrow("The loaded models record is larger than 65536 bytes.")

    await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a/model@lys-000001"])
    })
  })

  it("rejects saving an empty identifier, leaving the file as it was", async () => {
    const path = join(await createDirectory(), FILE_NAME)
    const store = new JsonFileLysLlmInstanceStore(path)
    await store.saveLysLlmInstanceIdentifiers(new Set(["a/model@lys-000001"]))

    await expect(
      store.saveLysLlmInstanceIdentifiers(new Set([""]))
    ).rejects.toThrow()

    await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a/model@lys-000001"])
    })
  })
})
