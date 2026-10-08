import { build } from "esbuild"
import { copyFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/index.ts"],
  outfile: "dist/backend.mjs",
  bundle: true,
  packages: "bundle",
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  minify: true,

  banner: {
    js: `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
    `
  }
})

// Prompt paths resolve beside the output bundle after bundling. The copies run
// together, and every copy settles before a failure ends the build, so no
// prompt is left half-written.
const promptCopies = await Promise.allSettled(
  ["lys.txt", "title-generation.txt"].map((filename) =>
    copyFile(
      new URL(`./src/utils/prompts/${filename}`, import.meta.url),
      new URL(`./dist/${filename}`, import.meta.url)
    )
  )
)
const promptCopyFailures = promptCopies.flatMap((promptCopy) =>
  promptCopy.status === "rejected" ? [promptCopy.reason] : []
)
if (promptCopyFailures.length > 0) {
  throw new AggregateError(promptCopyFailures, "Copying the prompts failed.")
}
