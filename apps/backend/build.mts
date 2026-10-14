import { build } from "esbuild"
import { copyFile, cp, realpath, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/index.ts"],
  outfile: "dist/backend.mjs",
  bundle: true,
  packages: "bundle",
  // playwright-core reads its own package files beside its code at run time,
  // so the bundle imports it from the copy installed next to it below.
  external: ["playwright-core"],
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
  ["caliginia.txt", "lysiptera.txt", "title-generation.txt"].map((filename) =>
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

// The copy replaces any earlier one, so no file of another playwright-core
// version stays beside the bundle.
const playwrightCoreCopy = new URL(
  "./dist/node_modules/playwright-core",
  import.meta.url
)
await rm(playwrightCoreCopy, { recursive: true, force: true })
await cp(
  await realpath(new URL("./node_modules/playwright-core", import.meta.url)),
  playwrightCoreCopy,
  { recursive: true, dereference: true }
)
