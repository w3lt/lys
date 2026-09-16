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

// Prompt paths resolve beside the output bundle after bundling.
for (const filename of ["lys.txt", "title-generation.txt"]) {
  await copyFile(
    new URL(`./src/utils/prompts/${filename}`, import.meta.url),
    new URL(`./dist/${filename}`, import.meta.url)
  )
}
