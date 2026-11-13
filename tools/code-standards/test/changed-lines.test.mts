import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { overlapsChange, parseUnifiedDiff } from "../changed-lines.mts"

/** Diff of a modified, an added, a deleted, and a renamed file. */
const diff = [
  "diff --git a/src/kept.ts b/src/kept.ts",
  "index 1111111..2222222 100644",
  "--- a/src/kept.ts",
  "+++ b/src/kept.ts",
  "@@ -3,2 +3,4 @@ function kept() {",
  "-old()",
  "-older()",
  "+new()",
  "+newer()",
  "++++ b/not-a-header.ts",
  "+newest()",
  "@@ -10 +12 @@",
  "-one()",
  "+two()",
  "@@ -20,3 +21,0 @@",
  "-removed()",
  "-removed()",
  "-removed()",
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1,2 @@",
  "+first()",
  "+second()",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone()",
  'diff --git a/old name.ts "b/new \\"name\\".ts"',
  "similarity index 100%",
  "rename from old name.ts",
  'rename to new "name".ts',
  ""
].join("\n")

describe("parseUnifiedDiff", () => {
  it("lists each added or modified file with its changed new-version lines", () => {
    const files = parseUnifiedDiff(diff)

    assert.deepEqual(
      files.map((file) => file.path),
      ["src/kept.ts", "src/added.ts"]
    )
    assert.deepEqual(files[0]?.ranges, [
      { start: 3, end: 6 },
      { start: 12, end: 12 },
      { start: 21.5, end: 21.5 }
    ])
    assert.deepEqual(files[1]?.ranges, [{ start: 1, end: 2 }])
  })

  it("decodes a quoted path and lists a pure rename without changed lines", () => {
    const renameHeader = [
      'diff --git "a/old \\"name\\".ts" "b/new \\"name\\".ts"',
      "similarity index 90%",
      'rename from old "name".ts',
      'rename to new "name".ts',
      "index 1111111..2222222 100644",
      '--- "a/old \\"name\\".ts"',
      '+++ "b/new \\"name\\".ts"',
      "@@ -1 +1 @@",
      "-a()",
      "+b()"
    ].join("\n")

    const [renamed] = parseUnifiedDiff(renameHeader)

    assert.equal(renamed?.path, 'new "name".ts')
    assert.deepEqual(renamed?.ranges, [{ start: 1, end: 1 }])
  })
})

describe("overlapsChange", () => {
  /** Lines 21 and 22 were joined by deleting the lines between them. */
  const deletionBetween21And22 = Object.freeze([{ start: 21.5, end: 21.5 }])

  it("matches a construct that contains a changed line", () => {
    assert.equal(overlapsChange(10, 14, [{ start: 14, end: 16 }]), true)
    assert.equal(overlapsChange(10, 13, [{ start: 14, end: 16 }]), false)
  })

  it("matches a deletion only inside a construct spanning both neighbors", () => {
    assert.equal(overlapsChange(20, 22, deletionBetween21And22), true)
    assert.equal(overlapsChange(18, 21, deletionBetween21And22), false)
    assert.equal(overlapsChange(22, 30, deletionBetween21And22), false)
  })
})
