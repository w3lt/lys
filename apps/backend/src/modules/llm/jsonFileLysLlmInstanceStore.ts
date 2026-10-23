import { open, rename, type FileHandle } from "node:fs/promises"
import * as z from "zod"
import { calculateLysLlmInstanceIdentifierOrder } from "./lysLlmInstanceIdentifiers"
import type {
  LysLlmInstanceIdentifiersRead,
  LysLlmInstanceStore
} from "./lysLlmInstanceStore"

/**
 * Most bytes of the loaded models file a read accepts, and a save writes,
 * inclusive. A record of the few instances Lys keeps loaded stays far below
 * it.
 */
export const MAXIMUM_LOADED_MODELS_FILE_BYTES = 64 * 1024

/** The only version of the file this backend reads and writes. */
const LOADED_MODELS_FILE_VERSION = 1

/** Validates a document of version 1; unknown fields are refused. */
const loadedModelsDocumentSchema = z.strictObject({
  version: z.literal(LOADED_MODELS_FILE_VERSION),
  instanceIdentifiers: z.array(z.string().min(1))
})

/** Validates only the version of a document, whatever else it holds. */
const loadedModelsVersionSchema = z.looseObject({
  version: z.literal(LOADED_MODELS_FILE_VERSION)
})

/** Decoder that rejects bytes that are not UTF-8. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

/** Read result of a missing file: nothing was ever saved. */
const NOTHING_SAVED: LysLlmInstanceIdentifiersRead = Object.freeze({
  status: "read",
  instanceIdentifiers: new Set<string>()
})

/**
 * Builds the read result of a file that cannot be read.
 *
 * @param message - Reason, which never quotes the file.
 * @returns A frozen `unreadable` result.
 */
function buildUnreadable(message: string): LysLlmInstanceIdentifiersRead {
  return Object.freeze({ status: "unreadable", message })
}

/**
 * Keeps the identifiers of the model instances Lys loaded in one JSON file,
 * `loaded_models.json` in the Lys home.
 *
 * @remarks The file is `{"version":1,"instanceIdentifiers":[...]}`, with the
 * identifiers sorted and unrepeated. A read accepts at most
 * {@link MAXIMUM_LOADED_MODELS_FILE_BYTES} bytes of UTF-8 in exactly that
 * shape; a missing file holds no identifier, and every other file is
 * unreadable. A save writes `loaded_models.json.tmp` beside the file,
 * flushes it, and renames it over the file, so a read sees either the
 * earlier record or the new one, whole. It never creates a directory.
 * Resource ownership: it opens no handle beyond each call. Concurrency
 * model: single-owner, as {@link LysLlmInstanceStore} requires; two saves
 * at once would share the temporary file.
 */
export default class JsonFileLysLlmInstanceStore implements LysLlmInstanceStore {
  /** Absolute path of the file. */
  readonly #filePath: string

  /**
   * Creates the store for one file without touching the disk.
   *
   * @param loadedModelsFilePath - Absolute path of `loaded_models.json`.
   */
  public constructor(loadedModelsFilePath: string) {
    this.#filePath = loadedModelsFilePath
  }

  /**
   * Implements {@link LysLlmInstanceStore.readLysLlmInstanceIdentifiers}.
   *
   * @returns The identifiers; none when no file exists; or `unreadable`
   * when the file cannot be opened or read, is over the limit, is not
   * UTF-8 or JSON, has another version, or does not match its format.
   * @throws Only when closing the opened file fails.
   * @remarks Never writes. Parse failures are dropped, because their
   * messages quote the text.
   */
  public async readLysLlmInstanceIdentifiers(): Promise<LysLlmInstanceIdentifiersRead> {
    const file = await openLoadedModelsFile(this.#filePath)
    if (file === "missing") return NOTHING_SAVED
    if (file === "unopenable") {
      return buildUnreadable("The loaded models file cannot be read.")
    }
    try {
      return await readLoadedModelsFile(file)
    } finally {
      await file.close()
    }
  }

  /**
   * Implements {@link LysLlmInstanceStore.saveLysLlmInstanceIdentifiers}.
   *
   * @param instanceIdentifiers - Identifiers to keep, each non-empty.
   * @returns A promise resolving once the file holds exactly these
   * identifiers.
   * @throws If an identifier is empty or the record would be larger than
   * {@link MAXIMUM_LOADED_MODELS_FILE_BYTES}, before anything is written; or
   * if writing, flushing, closing, or renaming the temporary file fails, in
   * which case the file is unchanged unless the rename happened.
   */
  public async saveLysLlmInstanceIdentifiers(
    instanceIdentifiers: ReadonlySet<string>
  ): Promise<void> {
    const text = formatLoadedModelsFileText(instanceIdentifiers)
    const temporaryPath = `${this.#filePath}.tmp`
    const handle = await open(temporaryPath, "w")
    try {
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, this.#filePath)
  }
}

/**
 * Opens the file for reading.
 *
 * @param path - Absolute path of the file.
 * @returns The handle, which the caller closes; `missing` when no file
 * exists; or `unopenable` for any other failure.
 */
async function openLoadedModelsFile(
  path: string
): Promise<FileHandle | "missing" | "unopenable"> {
  try {
    return await open(path, "r")
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "unopenable"
  }
}

/**
 * Reads and parses an open file within the size limit.
 *
 * @param handle - Open handle; the caller closes it.
 * @returns The identifiers, or `unreadable` with the reason.
 */
async function readLoadedModelsFile(
  handle: FileHandle
): Promise<LysLlmInstanceIdentifiersRead> {
  const bytes = await readBoundedBytes(handle)
  if (bytes === "unreadable") {
    return buildUnreadable("The loaded models file cannot be read.")
  }
  if (bytes === "too-large") {
    return buildUnreadable(
      `The loaded models file is larger than ${MAXIMUM_LOADED_MODELS_FILE_BYTES} bytes.`
    )
  }
  const text = decodeUtf8(bytes)
  if (text === undefined) {
    return buildUnreadable("The loaded models file is not UTF-8.")
  }
  return parseLoadedModelsFileText(text)
}

/**
 * Reads an open file's bytes within the size limit.
 *
 * @param handle - Open handle; the caller closes it.
 * @returns The bytes, `too-large` over the limit, or `unreadable` when a
 * read fails.
 */
async function readBoundedBytes(
  handle: FileHandle
): Promise<Uint8Array | "too-large" | "unreadable"> {
  try {
    const { size } = await handle.stat()
    if (size > MAXIMUM_LOADED_MODELS_FILE_BYTES) return "too-large"
    const bytes = await handle.readFile()
    return bytes.byteLength > MAXIMUM_LOADED_MODELS_FILE_BYTES
      ? "too-large"
      : bytes
  } catch {
    return "unreadable"
  }
}

/**
 * Decodes UTF-8 bytes.
 *
 * @param bytes - Bytes of the file.
 * @returns The text, or undefined when the bytes are not UTF-8.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Parses the file's text.
 *
 * @param text - Text of the file.
 * @returns The identifiers, or `unreadable` when the text is not JSON, has
 * a version other than 1, or does not match the version 1 format.
 * @remarks Parse failures are dropped, because their messages can quote the
 * text.
 */
function parseLoadedModelsFileText(
  text: string
): LysLlmInstanceIdentifiersRead {
  const document = parseJson(text)
  if (document === undefined) {
    return buildUnreadable("The loaded models file is not JSON.")
  }
  if (!loadedModelsVersionSchema.safeParse(document.value).success) {
    return buildUnreadable(
      "The loaded models file has a version this backend cannot read."
    )
  }
  const parsed = loadedModelsDocumentSchema.safeParse(document.value)
  if (!parsed.success) {
    return buildUnreadable(
      "The loaded models file does not match its version 1 format."
    )
  }
  return Object.freeze({
    status: "read",
    instanceIdentifiers: new Set(parsed.data.instanceIdentifiers)
  })
}

/**
 * Parses JSON text.
 *
 * @param text - Text to parse.
 * @returns The parsed value, boxed so `null` stays distinct from a failure,
 * or undefined when the text is not JSON.
 */
function parseJson(text: string): Readonly<{ value: unknown }> | undefined {
  try {
    return Object.freeze({ value: JSON.parse(text) as unknown })
  } catch {
    return undefined
  }
}

/**
 * Formats the file's text for a save.
 *
 * @param instanceIdentifiers - Identifiers to keep.
 * @returns The version 1 document, identifiers sorted, with a final newline.
 * @throws If an identifier is empty, or the text would be larger than
 * {@link MAXIMUM_LOADED_MODELS_FILE_BYTES}, so a save never writes what a
 * read refuses.
 */
function formatLoadedModelsFileText(
  instanceIdentifiers: ReadonlySet<string>
): string {
  const document = loadedModelsDocumentSchema.parse({
    version: LOADED_MODELS_FILE_VERSION,
    instanceIdentifiers: [...instanceIdentifiers].toSorted(
      calculateLysLlmInstanceIdentifierOrder
    )
  })
  const text = `${JSON.stringify(document, null, 2)}\n`
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_LOADED_MODELS_FILE_BYTES) {
    throw new Error(
      `The loaded models record is larger than ${MAXIMUM_LOADED_MODELS_FILE_BYTES} bytes.`
    )
  }
  return text
}

/**
 * Answers whether a failure means that no file exists at a path.
 *
 * @param error - Untrusted failure of an open.
 * @returns True for an error whose code is `ENOENT`.
 */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
