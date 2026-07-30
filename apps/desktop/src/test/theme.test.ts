import { readFileSync, readdirSync } from "node:fs"
import { extname, join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const sourceRoot = join(process.cwd(), "src")
const themePath = join(sourceRoot, "index.css")
const colorLiteral =
  /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(|\b(?:bg|text|border|ring|outline|fill|stroke)-(?:white|black)\b/i

function collectStyleSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      return entry.name === "assets" || entry.name === "test"
        ? []
        : collectStyleSources(path)
    }

    return [".css", ".scss", ".tsx"].includes(extname(entry.name)) &&
      path !== themePath
      ? [path]
      : []
  })
}

describe("desktop color theme", () => {
  it("keeps rendered color values centralized in index.css", () => {
    const violations = collectStyleSources(sourceRoot).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          colorLiteral.test(line)
            ? [`${relative(sourceRoot, path)}:${index + 1}: ${line.trim()}`]
            : []
        )
    )

    expect(violations).toEqual([])
  })
})
