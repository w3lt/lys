#!/usr/bin/env node

/**
 * Copies the root package version into Lys workspace and desktop manifests.
 * Root versions must use major.minor.patch without prerelease or build metadata.
 *
 * Usage: node scripts/sync-version.mts [--check | --help]
 * Requires Node.js 24+. Workspace discovery follows the current apps/* and
 * packages/* layout. Missing JSON version fields are added. Other file text,
 * including dependency versions, is preserved. Cargo's local package entry is
 * updated directly, without resolving or upgrading dependencies. Cargo package
 * tables must use bare keys and single-line literal name/version fields. TOML
 * multiline strings are rejected; unrelated TOML syntax is not validated.
 *
 * Run with exclusive access to the manifests. All replacements are prepared
 * before writing, and each changed file is replaced atomically. The batch is not a
 * transaction: after an I/O failure, fix the cause and rerun to finish syncing.
 * --check never writes; it exits with status 1 on drift or invalid input.
 */

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Validated major.minor.patch version, distinct from paths and document text. */
type ReleaseVersion = string & {
  /** Compile-time proof that release version validation succeeded. */
  readonly __releaseVersion: unique symbol
}

/** Existing absolute repository directory resolved from this script's location. */
type RepositoryDirectory = string & {
  /** Compile-time proof that the repository path was resolved. */
  readonly __repositoryDirectory: unique symbol
}

/** Repository-relative manifest location in this command's supported layout. */
type ManifestPath = string & {
  /** Compile-time proof that the path belongs to the supported manifest layout. */
  readonly __manifestPath: unique symbol
}

/** JSON text validated to contain a non-null object rather than an array. */
type JsonObjectText = string & {
  /** Compile-time proof of JSON syntax and top-level object shape. */
  readonly __jsonObjectText: unique symbol
}

/** One decoded string field and the surrounding text in its source document. */
type StringField = {
  /** Decoded field value, without its enclosing quotes. */
  readonly value: string
  /** Complete document text before the field value, including its opening quote. */
  readonly beforeValue: string
  /** Complete document text after the field value, including its closing quote. */
  readonly afterValue: string
}

/** Parsed document with exactly one version replacement or JSON insertion slot. */
type VersionDocument = {
  /** Original document text retained for unchanged output and conflict detection. */
  readonly originalContents: string
  /** Existing version, or absence when a JSON version field must be inserted. */
  readonly currentVersion: string | undefined
  /** Document prefix prepared for a major.minor.patch version without escaping. */
  readonly beforeVersion: string
  /** Document suffix prepared for the replacement or inserted version. */
  readonly afterVersion: string
}

/** One table in the supported single-line Cargo layout, bound to its source. */
type CargoTable = {
  /** Complete document from which this table was parsed. */
  readonly originalContents: string
  /** Table text, including its header and excluding subsequent tables. */
  readonly contents: string
  /** Zero-based UTF-16 code-unit offset of the table in the original document. */
  readonly startOffset: number
}

/** Desktop crate identity and its parsed package-version replacement. */
type CargoPackageDocument = {
  /** Literal package name used to identify the matching local lockfile entry. */
  readonly name: string
  /** Complete Cargo manifest with a validated package-version slot. */
  readonly versionDocument: VersionDocument
}

/** One immutable, fully prepared manifest replacement. */
type VersionChange = {
  /** Manifest location relative to the repository. */
  readonly relativePath: ManifestPath
  /** Exact UTF-8 text observed during planning. */
  readonly originalContents: string
  /** Text with only the owned version changed. */
  readonly updatedContents: string
}

/**
 * Validates the CLI before any filesystem effects.
 * @param args - Arguments following the script filename.
 * @returns The selected command; omission means sync.
 * @throws {Error} If options are unknown, repeated, or combined.
 */
function parseVersionCommand(
  args: readonly string[]
): "sync" | "check" | "help" {
  if (args.length === 0) return "sync"
  if (args.length === 1 && args[0] === "--check") return "check"
  if (args.length === 1 && args[0] === "--help") return "help"
  throw new Error("Usage: node scripts/sync-version.mts [--check | --help]")
}

/**
 * Accepts only major.minor.patch, with no leading zeros, prefix, or suffix.
 * @param candidate - Text to interpret as a release version.
 * @returns The validated version, unchanged.
 * @throws {Error} If the version format or a numeric component is invalid.
 * @remarks Components must be nonnegative safe integers for npm compatibility;
 * these bounds also fit Cargo's unsigned 64-bit version components.
 */
function parseReleaseVersion(candidate: string): ReleaseVersion {
  const versionPattern =
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
  if (candidate.trim() !== candidate || !versionPattern.test(candidate)) {
    throw new Error(
      "Release version must use major.minor.patch (for example, 1.2.3)."
    )
  }
  const coreComponents = candidate.split(".")
  if (
    !coreComponents.every((component) =>
      Number.isSafeInteger(Number(component))
    )
  ) {
    throw new Error(
      "Release version components must not exceed Number.MAX_SAFE_INTEGER."
    )
  }
  return candidate as ReleaseVersion
}

/**
 * Restricts discovered paths to the manifests this command owns.
 * @param candidate - Repository-relative path from discovery or a fixed target.
 * @returns The validated path, without traversal components.
 * @throws {Error} If the path does not identify a supported manifest.
 */
function parseManifestPath(candidate: string): ManifestPath {
  const manifestPattern =
    /^(?:package\.json|(?:apps|packages)\/[^/\\]+\/package\.json|apps\/desktop\/src-tauri\/(?:tauri\.conf\.json|Cargo\.toml|Cargo\.lock))$/
  if (!manifestPattern.test(candidate)) {
    throw new Error(
      "Unsupported manifest path encountered during version synchronization."
    )
  }
  if (candidate.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Manifest paths must not contain traversal components.")
  }
  return candidate as ManifestPath
}

/**
 * Reads an existing regular manifest; symlink targets are not writable inputs.
 * @param rootDirectory - Repository determined from the script location.
 * @param relativePath - Manifest within the supported workspace layout.
 * @returns The manifest's exact UTF-8 text.
 * @throws {Error} If the path contains a symlink, cannot be read, or is not UTF-8.
 */
function readVersionManifest(
  rootDirectory: RepositoryDirectory,
  relativePath: ManifestPath
): string {
  const manifestPath = join(rootDirectory, relativePath)
  if (!lstatSync(manifestPath).isFile()) {
    throw new Error(`${relativePath} must be a regular file, not a symlink.`)
  }
  if (realpathSync(manifestPath) !== manifestPath) {
    throw new Error(`${relativePath} must not have a symlink in its path.`)
  }
  const manifestBytes = readFileSync(manifestPath)
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  try {
    return decoder.decode(manifestBytes)
  } catch (cause) {
    throw new Error(`${relativePath} must contain valid UTF-8.`, { cause })
  }
}

/**
 * Retrieves a manifest through its parser, attaching file context to parse errors.
 * @typeParam TManifest - Trusted result established by the supplied parser.
 * @param rootDirectory - Repository containing the manifest.
 * @param relativePath - Supported file to read.
 * @param parseManifest - Pure parser that validates text before returning a domain value.
 * @returns The complete parsed manifest; filesystem access occurs only during this call.
 * @throws {Error} If reading fails or parsing rejects the document.
 */
function getParsedManifest<TManifest>(
  rootDirectory: RepositoryDirectory,
  relativePath: ManifestPath,
  parseManifest: (contents: string) => TManifest
): TManifest {
  const contents = readVersionManifest(rootDirectory, relativePath)
  try {
    return parseManifest(contents)
  } catch (cause) {
    throw new Error(`Invalid ${relativePath}.`, { cause })
  }
}

/**
 * Validates JSON syntax and object shape while preserving the original text.
 * @param contents - Untrusted JSON document text.
 * @returns Exact text proven to contain a non-null object rather than an array.
 * @throws {Error} If the JSON syntax or top-level shape is invalid.
 */
function parseJsonObjectText(contents: string): JsonObjectText {
  const value: unknown = JSON.parse(contents)
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON manifest must contain an object.")
  }
  return contents as JsonObjectText
}

/**
 * Locates top-level version keys while ignoring strings and nested objects.
 * @param contents - Syntactically valid JSON object text.
 * @returns Key tokens in source order, with source offsets.
 */
function listJsonVersionKeys(contents: JsonObjectText): RegExpExecArray[] {
  const keys: RegExpExecArray[] = []
  let depth = 0
  for (const token of contents.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]]/g)) {
    if (token[0] === "{" || token[0] === "[") {
      depth += 1
      continue
    }
    if (token[0] === "}" || token[0] === "]") {
      depth -= 1
      continue
    }
    if (depth !== 1) continue
    const suffix = contents.slice(token.index + token[0].length)
    if (/^\s*:/.test(suffix) && JSON.parse(token[0]) === "version") {
      keys.push(token)
    }
  }
  return keys
}

/**
 * Finds a single string-valued version field in validated JSON object text.
 * @param contents - Valid JSON object text; unrelated properties stay opaque.
 * @returns The decoded field and document fragments, or absence when no version exists.
 * @throws {Error} If the version field is duplicated or is not a string.
 */
function findJsonVersionField(
  contents: JsonObjectText
): StringField | undefined {
  const keys = listJsonVersionKeys(contents)
  if (keys.length > 1)
    throw new Error("JSON manifest contains duplicate version fields.")
  const key = keys[0]
  if (key === undefined) return undefined
  const valueOffset = key.index + key[0].length
  const match = /^(\s*:\s*)("(?:\\[\s\S]|[^"\\])*")/.exec(
    contents.slice(valueOffset)
  )
  const separator = match?.[1]
  const quotedValue = match?.[2]
  if (separator === undefined || quotedValue === undefined) {
    throw new Error("JSON version must be a string when present.")
  }
  const value: unknown = JSON.parse(quotedValue)
  if (typeof value !== "string")
    throw new Error("JSON version must be a string.")
  const startOffset = valueOffset + separator.length + 1
  return Object.freeze({
    value,
    beforeValue: contents.slice(0, startOffset),
    afterValue: contents.slice(startOffset + quotedValue.length - 2)
  })
}

/**
 * Parses a JSON manifest and prepares its existing or missing version field.
 * @param contents - Complete untrusted JSON document text.
 * @returns A validated version slot retaining all unrelated text and field order.
 * @throws {Error} If JSON syntax, object shape, or the version field is invalid.
 */
function parseJsonVersionDocument(contents: string): VersionDocument {
  const jsonText = parseJsonObjectText(contents)
  const field = findJsonVersionField(jsonText)
  if (field !== undefined) {
    return Object.freeze({
      originalContents: contents,
      currentVersion: field.value,
      beforeVersion: field.beforeValue,
      afterVersion: field.afterValue
    })
  }
  const insertionOffset = contents.indexOf("{") + 1
  const suffix = contents.slice(insertionOffset)
  const spacing = /^\s*/.exec(suffix)?.[0] ?? ""
  const comma = suffix.trimStart().startsWith("}") ? "" : ","
  return Object.freeze({
    originalContents: contents,
    currentVersion: undefined,
    beforeVersion:
      contents.slice(0, insertionOffset) + `${spacing}"version": "`,
    afterVersion: `"${comma}${suffix}`
  })
}

/**
 * Retrieves the required release version from the repository's root package.json.
 * @param rootDirectory - Repository whose root manifest is the version authority.
 * @returns The validated major.minor.patch release version.
 * @throws {Error} If the root manifest or its required release version is invalid.
 */
function getRootReleaseVersion(
  rootDirectory: RepositoryDirectory
): ReleaseVersion {
  const rootPath = parseManifestPath("package.json")
  const document = getParsedManifest(
    rootDirectory,
    rootPath,
    parseJsonVersionDocument
  )
  try {
    if (document.currentVersion === undefined) {
      throw new Error("A root version field is required.")
    }
    return parseReleaseVersion(document.currentVersion)
  } catch (cause) {
    throw new Error("Invalid package.json release version.", { cause })
  }
}

/**
 * Parses one literal Cargo string field and binds its position to its document.
 * @param table - Table parsed from a document using the supported TOML layout.
 * @param field - Owned package field to extract.
 * @returns The unescaped value and complete document fragments surrounding it.
 * @throws {Error} If the field is absent, duplicated, inherited, or not a literal.
 */
function parseCargoStringField(
  table: CargoTable,
  field: "name" | "version"
): StringField {
  if (
    /^[ \t]*(?:"(?:\\.|[^"\\])*"|'[^']*')[ \t]*(?:=|\.)/m.test(table.contents)
  ) {
    throw new Error("Quoted keys in Cargo package tables are unsupported.")
  }
  const declarations = table.contents.match(
    new RegExp(`^[ \\t]*["']?${field}["']?[ \\t]*(?:=|\\.)`, "gm")
  )
  const pattern = new RegExp(
    `^([ \\t]*${field}[ \\t]*=[ \\t]*)(["'])([^"'\\\\\\r\\n]+)\\2[ \\t]*(?:#[^\\r\\n]*)?\\r?$`,
    "gm"
  )
  const matches = [...table.contents.matchAll(pattern)]
  const match = matches[0]
  if (
    declarations?.length !== 1 ||
    matches.length !== 1 ||
    match === undefined
  ) {
    throw new Error(
      `Cargo package table must have exactly one literal ${field}.`
    )
  }
  const prefix = match[1]
  const value = match[3]
  if (prefix === undefined || value === undefined) {
    throw new Error(
      `Cargo package ${field} must be a single-line string literal.`
    )
  }
  const startOffset = table.startOffset + match.index + prefix.length + 1
  return Object.freeze({
    value,
    beforeValue: table.originalContents.slice(0, startOffset),
    afterValue: table.originalContents.slice(startOffset + value.length)
  })
}

/**
 * Splits the supported TOML layout without interpreting string text as tables.
 * @param contents - Complete Cargo document in the current repository layout.
 * @returns Source-bound tables in document order, preceded by any document preamble.
 * @throws {Error} If multiline string syntax prevents safe line-based editing.
 */
function parseCargoTables(contents: string): readonly CargoTable[] {
  if (contents.includes('"""') || contents.includes("'''")) {
    throw new Error("Multiline TOML strings are unsupported.")
  }
  const tables: CargoTable[] = []
  let startOffset = 0
  for (const tableContents of contents.split(/(?=^[ \t]*\[)/m)) {
    tables.push(
      Object.freeze({
        originalContents: contents,
        contents: tableContents,
        startOffset
      })
    )
    startOffset += tableContents.length
  }
  return Object.freeze(tables)
}

/**
 * Parses the crate name and version slot from a standalone Cargo manifest.
 * @param contents - Cargo.toml text in the checked-in table layout.
 * @returns The crate identity and a version slot bound to this document.
 * @throws {Error} If the package table or its required literal fields are invalid.
 */
function parseCargoPackageDocument(contents: string): CargoPackageDocument {
  const tables = parseCargoTables(contents).filter((table) =>
    /^\[package\][ \t]*(?:#.*)?(?:\r?\n|$)/.test(table.contents.trimStart())
  )
  const [packageTable] = tables
  if (tables.length !== 1 || packageTable === undefined) {
    throw new Error("Cargo manifest must contain exactly one [package] table.")
  }
  const name = parseCargoStringField(packageTable, "name").value
  const versionDocument = parseCargoVersionDocument(packageTable)
  return Object.freeze({ name, versionDocument })
}

/**
 * Parses one local package's version slot from a Cargo lockfile.
 * @param contents - Existing Cargo.lock text; dependency entries stay opaque.
 * @param packageName - Exact local package name to select; registry entries are excluded.
 * @returns A version slot bound to the matching entry and complete lockfile.
 * @throws {Error} If the local entry is absent, ambiguous, or malformed.
 */
function parseCargoLockVersionDocument(
  contents: string,
  packageName: string
): VersionDocument {
  const matches: CargoTable[] = []
  for (const table of parseCargoTables(contents)) {
    if (
      !/^\[\[package\]\][ \t]*(?:#.*)?(?:\r?\n|$)/.test(
        table.contents.trimStart()
      )
    )
      continue
    if (/^[ \t]*source[ \t]*=/m.test(table.contents)) continue
    if (parseCargoStringField(table, "name").value === packageName) {
      matches.push(table)
    }
  }
  const [packageTable] = matches
  if (matches.length !== 1 || packageTable === undefined) {
    throw new Error(
      "Cargo lockfile must contain exactly one matching local package entry."
    )
  }
  return parseCargoVersionDocument(packageTable)
}

/**
 * Parses the version field of one source-bound Cargo table.
 * @param table - Table in the supported Cargo layout, including its source location.
 * @returns A version slot preserving all other document text, comments, and quotes.
 * @throws {Error} If the version field is missing, duplicated, or not a literal.
 */
function parseCargoVersionDocument(table: CargoTable): VersionDocument {
  const field = parseCargoStringField(table, "version")
  return Object.freeze({
    originalContents: table.originalContents,
    currentVersion: field.value,
    beforeVersion: field.beforeValue,
    afterVersion: field.afterValue
  })
}

/**
 * Builds updated document text from its parsed version slot.
 * @param document - Validated document containing a replacement or insertion slot.
 * @param version - Release version safe to place inside JSON and Cargo string literals.
 * @returns Original text when already matching; otherwise text with only its version changed.
 */
function buildVersionContents(
  document: VersionDocument,
  version: ReleaseVersion
): string {
  if (document.currentVersion === version) return document.originalContents
  return document.beforeVersion + version + document.afterVersion
}

/**
 * Prepares one immutable replacement for a parsed manifest.
 * @param relativePath - Target manifest in the supported repository layout.
 * @param document - Parsed source document whose original text guards against conflicts.
 * @param version - Desired release version.
 * @returns A complete replacement plan without reading or writing any files.
 */
function buildVersionChange(
  relativePath: ManifestPath,
  document: VersionDocument,
  version: ReleaseVersion
): VersionChange {
  const updatedContents = buildVersionContents(document, version)
  return Object.freeze({
    relativePath,
    originalContents: document.originalContents,
    updatedContents
  })
}

/**
 * Prepares the standalone desktop crate and its existing lockfile together.
 * @param rootDirectory - Repository containing the desktop crate.
 * @param version - Validated root release version.
 * @returns Both replacements, without resolving dependencies.
 * @throws {Error} If either file or its required package fields cannot be read.
 */
function listCargoVersionChanges(
  rootDirectory: RepositoryDirectory,
  version: ReleaseVersion
): VersionChange[] {
  const cargoPath = parseManifestPath("apps/desktop/src-tauri/Cargo.toml")
  const cargoPackage = getParsedManifest(
    rootDirectory,
    cargoPath,
    parseCargoPackageDocument
  )
  const lockPath = parseManifestPath("apps/desktop/src-tauri/Cargo.lock")
  const lockDocument = getParsedManifest(rootDirectory, lockPath, (contents) =>
    parseCargoLockVersionDocument(contents, cargoPackage.name)
  )
  return [
    buildVersionChange(cargoPath, cargoPackage.versionDocument, version),
    buildVersionChange(lockPath, lockDocument, version)
  ]
}

/**
 * Discovers immediate workspace manifests without hiding directory read failures.
 * @param rootDirectory - Repository containing apps and packages.
 * @returns Supported manifests in deterministic path order.
 * @throws {Error} If a workspace directory cannot be enumerated.
 * @remarks Skips directory symlinks and directories without a package.json.
 */
function listWorkspaceManifests(
  rootDirectory: RepositoryDirectory
): ManifestPath[] {
  const paths: ManifestPath[] = []
  for (const group of ["apps", "packages"]) {
    const groupDirectory = join(rootDirectory, group)
    const entries = readdirSync(groupDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filenames = readdirSync(join(groupDirectory, entry.name))
      if (filenames.includes("package.json")) {
        paths.push(parseManifestPath(`${group}/${entry.name}/package.json`))
      }
    }
  }
  return paths.sort()
}

/**
 * Validates all targets before returning the files that need synchronization.
 * @param rootDirectory - Repository containing apps/* and packages/*.
 * @param version - Validated root release version.
 * @returns Changed files in deterministic path order.
 * @throws {Error} If any discovered or required desktop manifest is invalid.
 */
function listVersionChanges(
  rootDirectory: RepositoryDirectory,
  version: ReleaseVersion
): VersionChange[] {
  const workspacePaths = listWorkspaceManifests(rootDirectory)
  if (workspacePaths.length === 0) {
    throw new Error(
      "No workspace package.json files found under apps/* or packages/*."
    )
  }
  const jsonPaths = [
    ...workspacePaths,
    parseManifestPath("apps/desktop/src-tauri/tauri.conf.json")
  ]
  const jsonChanges = jsonPaths.map((path) => {
    const document = getParsedManifest(
      rootDirectory,
      path,
      parseJsonVersionDocument
    )
    return buildVersionChange(path, document, version)
  })
  const cargoChanges = listCargoVersionChanges(rootDirectory, version)
  return [...jsonChanges, ...cargoChanges]
    .filter((change) => change.originalContents !== change.updatedContents)
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1))
}

/**
 * Replaces one manifest through a same-filesystem temporary file.
 * @param rootDirectory - Repository containing the planned target.
 * @param change - Validated replacement and original text.
 * @throws {Error} If the input changed, writing fails, or temporary cleanup fails.
 * @remarks Preserves file permission bits; earlier batch replacements may remain
 * after failure. Owns and removes only its newly created temporary directory.
 */
function saveVersionChange(
  rootDirectory: RepositoryDirectory,
  change: VersionChange
): void {
  const targetPath = join(rootDirectory, change.relativePath)
  if (
    readVersionManifest(rootDirectory, change.relativePath) !==
    change.originalContents
  ) {
    throw new Error(
      `${change.relativePath} changed during synchronization; rerun the command.`
    )
  }
  const mode = lstatSync(targetPath).mode & 0o777
  const temporaryDirectory = mkdtempSync(
    join(dirname(targetPath), ".sync-version-")
  )
  const temporaryPath = join(temporaryDirectory, "manifest")
  const failures: unknown[] = []
  try {
    writeFileSync(temporaryPath, change.updatedContents, {
      encoding: "utf8",
      flag: "wx",
      mode
    })
    chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, targetPath)
  } catch (error) {
    failures.push(error)
  }
  try {
    rmSync(temporaryDirectory, { recursive: true })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to save ${change.relativePath}; the batch may be partially synchronized.`
    )
  }
}

/**
 * Retrieves the repository directory from this script's installed location.
 * @returns An existing absolute directory with filesystem symlinks resolved.
 * @throws {Error} If the repository directory cannot be resolved.
 */
function getRepositoryDirectory(): RepositoryDirectory {
  const directory = realpathSync(fileURLToPath(new URL("../", import.meta.url)))
  return directory as RepositoryDirectory
}

/**
 * Handles a CLI invocation and reports completion or read-only version drift.
 * @param args - CLI options, excluding runtime and filename.
 * @throws {Error} If validation or a required filesystem operation fails.
 * @remarks Owns stdout and the drift exit status; the entry boundary reports
 * thrown failures. Resolves the repository from this script, independent of cwd.
 */
function handleVersionCommand(args: readonly string[]): void {
  const command = parseVersionCommand(args)
  if (command === "help") {
    console.log(
      "Usage: node scripts/sync-version.mts [--check | --help]\nDefault: synchronize from root package.json. --check: read only; exit 1 on drift."
    )
    return
  }
  const rootDirectory = getRepositoryDirectory()
  const version = getRootReleaseVersion(rootDirectory)
  const changes = listVersionChanges(rootDirectory, version)
  if (changes.length === 0) {
    console.log(`All versions match ${version}.`)
    return
  }
  if (command === "check") {
    for (const change of changes)
      console.error(
        `${change.relativePath} does not match root version ${version}.`
      )
    process.exitCode = 1
    return
  }
  for (const change of changes) {
    saveVersionChange(rootDirectory, change)
    console.log(`Updated ${change.relativePath} to ${version}.`)
  }
  console.log(`Synchronized ${changes.length} files to ${version}.`)
}

try {
  handleVersionCommand(process.argv.slice(2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
