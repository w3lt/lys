import { globSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"

/** major.minor.patch version validated before it is written to release manifests. */
type ReleaseVersion = string & {
  /** Keeps release versions distinct from paths and serialized contents. */
  readonly __releaseVersion: unique symbol
}

/** Complete replacement for one stale manifest, prepared before any writes. */
type ManifestUpdate = {
  /** Repository-relative target path. */
  readonly path: string
  /** Serialized manifest with its release version corrected. */
  readonly contents: string
}

/**
 * Parses VERSION as major.minor.patch, allowing surrounding whitespace.
 * @param contents - Raw VERSION contents.
 * @returns Three nonnegative integers separated by dots, without leading zeroes.
 * @throws If VERSION is empty or uses any other version format.
 */
function parseReleaseVersion(contents: string): ReleaseVersion {
  const version = contents.trim()
  const pattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
  if (!pattern.test(version)) {
    throw new Error("VERSION must use major.minor.patch, such as 1.2.3.")
  }
  return version as ReleaseVersion
}

/**
 * Lists package manifests and desktop release metadata in sorted path order.
 * @param root - Repository root, independent of the caller's working directory.
 * @returns Unique targets, excluding dependencies, hidden directories and builds.
 * @throws If package discovery cannot read the repository.
 */
function listVersionManifests(root: string): readonly string[] {
  const packages = globSync("**/package.json", {
    cwd: root,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-ssr/**",
      "**/build/**",
      "**/coverage/**",
      "**/target/**",
      "**/.*/**"
    ]
  })
  return [
    ...new Set([
      ...packages,
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/src-tauri/Cargo.toml"
    ])
  ].sort()
}

/**
 * Replaces only the root JSON version; other fields stay within this adapter.
 * @param contents - JSON object text from a package or Tauri manifest.
 * @param version - Validated version to write when absent or different.
 * @returns Original text when current, otherwise JSON with two-space indentation.
 * @throws If the manifest is malformed or its root is not an object.
 */
function buildJsonVersion(contents: string, version: ReleaseVersion): string {
  const manifest: unknown = JSON.parse(contents)
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error("The JSON manifest must contain an object.")
  }
  if ("version" in manifest && manifest.version === version) {
    return contents
  }
  // Keep opaque manifest fields local; publish only the edited JSON text.
  Object.defineProperty(manifest, "version", {
    value: version,
    enumerable: true
  })
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Replaces the desktop package version using TOML parsing and serialization.
 * @param contents - Cargo.toml text containing the desktop package table.
 * @param version - Validated release version for the desktop crate.
 * @returns Original text when current; otherwise normalized TOML without comments.
 * @throws If TOML is malformed, package is not a table, or serialization fails.
 */
function buildCargoVersion(contents: string, version: ReleaseVersion): string {
  const manifest = parseToml(contents, { integersAsBigInt: true })
  const packageTable = manifest.package
  if (
    typeof packageTable !== "object" ||
    Array.isArray(packageTable) ||
    packageTable instanceof Date
  ) {
    throw new Error("Cargo.toml must contain a package table.")
  }
  if (packageTable.version === version) {
    return contents
  }
  packageTable.version = version
  // Preserve integer precision and distinguish integers from floats on rewrite.
  return stringifyToml(manifest, { numbersAsFloat: true })
}

/**
 * Reads a target and prepares its replacement without changing the filesystem.
 * @param root - Repository root that owns the target.
 * @param path - Repository-relative manifest path.
 * @param version - Validated release version.
 * @returns A replacement for a stale target, or undefined when already current.
 * @throws With the target path and original cause on read or parsing failure.
 */
function getManifestUpdate(
  root: string,
  path: string,
  version: ReleaseVersion
): ManifestUpdate | undefined {
  try {
    const contents = readFileSync(join(root, path), "utf8")
    const updated = path.endsWith(".json")
      ? buildJsonVersion(contents, version)
      : buildCargoVersion(contents, version)
    return contents === updated
      ? undefined
      : Object.freeze({ path, contents: updated })
  } catch (cause) {
    throw new Error(`Cannot synchronize ${path}.`, { cause })
  }
}

/**
 * Checks release versions or writes stale manifests after all targets are read.
 * @param root - Repository root containing VERSION and the manifests.
 * @param args - Exactly one mode: update or check.
 * @returns Zero on success, or one when check finds missing or mismatched versions.
 * @throws On invalid input, unreadable manifests or failed writes. Writes are
 * sequential; rerunning update repairs remaining targets after a write failure.
 */
function startVersionSync(root: string, args: readonly string[]): number {
  const mode = args[0]
  if (args.length !== 1 || (mode !== "update" && mode !== "check")) {
    throw new Error("Usage: node sync-version.mts <update|check>")
  }
  const version = parseReleaseVersion(
    readFileSync(join(root, "VERSION"), "utf8")
  )
  const updates = listVersionManifests(root)
    .map((path) => getManifestUpdate(root, path, version))
    .filter((update) => update !== undefined)
  if (mode === "check") {
    for (const update of updates) {
      console.error(
        `${update.path}: version is missing or differs from ${version}`
      )
    }
    return updates.length === 0 ? 0 : 1
  }
  for (const update of updates) {
    writeFileSync(join(root, update.path), update.contents, "utf8")
    console.log(`Updated ${update.path} to ${version}`)
  }
  return 0
}

try {
  process.exitCode = startVersionSync(
    fileURLToPath(new URL("../", import.meta.url)),
    process.argv.slice(2)
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
